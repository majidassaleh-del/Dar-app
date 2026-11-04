import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { matchStatementLines, parseStatement, StatementParseError } from '@herp/bank-statements';
import type { BankStatementImport, BankStatementLine } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { isoDate, money as fmt } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { household } from './banking.common';

const Upload = z.object({
  fileName: z.string().trim().min(1).max(200), content: z.string().min(10).max(5_000_000),
  encoding: z.enum(['utf8', 'base64']).default('utf8'), format: z.enum(['CSV', 'OFX']).optional(), dateOrder: z.enum(['DMY', 'MDY']).optional(),
}).strict();
const LineAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('match'), transactionId: z.guid() }).strict(),
  z.object({ action: z.literal('unmatch') }).strict(),
  z.object({ action: z.literal('ignore') }).strict(),
]);
const Apply = z.object({
  defaultExpenseCategoryId: z.guid().optional(), defaultIncomeCategoryId: z.guid().optional(),
  lines: z.array(z.object({ lineId: z.guid(), categoryId: z.guid().optional(), isFunding: z.boolean().optional(),
    /** Money moved to/from another own account (an internal transfer, not spending). */ counterAccountId: z.guid().optional() }).strict()).max(5000).default([]),
}).strict();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const lineDto = (l: BankStatementLine) => ({ id: l.id, lineNo: l.lineNo, date: isoDate(l.bookedOn), amount: fmt(l.amount), description: l.description,
  reference: l.reference, balance: fmt(l.balance), status: l.status, transactionId: l.transactionId, matchScore: l.matchScore });
const importDto = (i: BankStatementImport, lines: BankStatementLine[]) => ({
  id: i.id, accountId: i.accountId, format: i.format, fileName: i.fileName, status: i.status, periodStart: isoDate(i.periodStart), periodEnd: isoDate(i.periodEnd),
  openingBalance: fmt(i.openingBalance), closingBalance: fmt(i.closingBalance), warnings: i.warnings, appliedAt: i.appliedAt,
  summary: { lines: lines.length, matched: lines.filter((l) => l.status === 'MATCHED').length, unmatched: lines.filter((l) => l.status === 'UNMATCHED').length,
             created: lines.filter((l) => l.status === 'CREATED').length, ignored: lines.filter((l) => l.status === 'IGNORED').length },
  lines: lines.sort((a, b) => a.lineNo - b.lineNo).map(lineDto),
});

/**
 * Bank statement import (CSV / OFX) and batch reconciliation:
 *   upload → parse → store lines (deduplicated across overlapping statements)
 *   → auto-match to existing POSTED transactions (amount exact, ±3 days, bank ref)
 *   → review (match / unmatch / ignore) → apply: unmatched lines become
 *   BANK_FEED transactions and every matched or created transaction is RECONCILED.
 */
@Controller()
export class StatementsController {
  constructor(private readonly db: PrismaService) {}

  @Post('accounts/:accountId/statements')
  upload(@Ctx() ctx: RequestContext, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodBody(Upload)) b: z.infer<typeof Upload>) {
    return this.db.withRls(ctx, async (tx) => {
      const account = await tx.financialAccount.findFirst({ where: { id: accountId } });
      if (!account) throw new NotFoundException('account not found');
      const text = b.encoding === 'base64' ? Buffer.from(b.content, 'base64').toString('utf8') : b.content;
      const sha256 = createHash('sha256').update(text).digest('hex');
      if (await tx.bankStatementImport.findFirst({ where: { accountId, sha256 }, select: { id: true } })) throw new ConflictException('this statement file was already imported');
      let parsed;
      try { parsed = parseStatement(text, b.format, { dateOrder: b.dateOrder }); } catch (e) {
        if (e instanceof StatementParseError) throw new BadRequestException(`content: ${e.message}`);
        throw e;
      }
      if (parsed.currency && parsed.currency !== account.currency) throw new BadRequestException(`statement currency ${parsed.currency} ≠ account currency ${account.currency}`);

      const imp = await tx.bankStatementImport.create({ data: { householdId: ctx.householdId!, accountId, format: parsed.format, fileName: b.fileName, sha256,
        periodStart: parsed.periodStart ? new Date(`${parsed.periodStart}T00:00:00Z`) : undefined, periodEnd: parsed.periodEnd ? new Date(`${parsed.periodEnd}T00:00:00Z`) : undefined,
        openingBalance: parsed.openingBalance, closingBalance: parsed.closingBalance, warnings: parsed.warnings, importedById: ctx.membershipId! } });

      const seen = new Map<string, number>();
      const rows = parsed.lines.map((l) => {
        const base = `${l.date}|${l.amount.toFixed(2)}|${norm(l.description)}`;
        const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
        return { householdId: ctx.householdId!, importId: imp.id, accountId, lineNo: l.lineNo, bookedOn: new Date(`${l.date}T00:00:00Z`), amount: l.amount,
                 description: l.description, reference: l.reference, balance: l.balance, fingerprint: l.reference ? `ref:${l.reference}` : `${base}|${n}` };
      });
      const { count } = await tx.bankStatementLine.createMany({ data: rows, skipDuplicates: true });
      await this.autoMatch(tx, ctx, imp.id, accountId);
      const lines = await tx.bankStatementLine.findMany({ where: { importId: imp.id } });
      return { ...importDto(imp, lines), duplicatesSkipped: rows.length - count };
    });
  }

  @Get('accounts/:accountId/statements')
  list(@Ctx() ctx: RequestContext, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.db.withRls(ctx, async (tx) => {
      const imps = await tx.bankStatementImport.findMany({ where: { accountId }, include: { lines: true }, orderBy: { createdAt: 'desc' } });
      return { data: imps.map(({ lines, ...i }) => { const d = importDto(i as BankStatementImport, lines); return { ...d, lines: undefined }; }) };
    });
  }

  @Get('statements/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => this.detail(tx, id));
  }

  @Post('statements/:id/lines/:lineId')
  line(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string,
       @Body(new ZodBody(LineAction)) b: z.infer<typeof LineAction>) {
    return this.db.withRls(ctx, async (tx) => {
      const l = await tx.bankStatementLine.findFirst({ where: { id: lineId, importId: id } });
      if (!l) throw new NotFoundException('statement line not found');
      const data = b.action === 'match' ? { status: 'MATCHED' as const, transactionId: b.transactionId, matchScore: null }
        : b.action === 'unmatch' ? { status: 'UNMATCHED' as const, transactionId: null, matchScore: null }
        : { status: 'IGNORED' as const, transactionId: null, matchScore: null };
      if (b.action === 'match' && await tx.bankStatementLine.findFirst({ where: { transactionId: b.transactionId }, select: { id: true } })) {
        throw new ConflictException('that transaction is already matched to a statement line');
      }
      await tx.bankStatementLine.updateMany({ where: { id: lineId }, data });
      return this.detail(tx, id);
    });
  }

  @Post('statements/:id/apply')
  apply(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Apply)) b: z.infer<typeof Apply>) {
    return this.db.withRls(ctx, async (tx) => {
      const imp = await tx.bankStatementImport.findFirst({ where: { id } });
      if (!imp) throw new NotFoundException('statement not found');
      if (imp.status === 'APPLIED') throw new ConflictException('statement already applied');
      const { currency, timezone } = await household(tx, ctx.householdId!);
      const overrides = new Map(b.lines.map((x) => [x.lineId, x]));
      const open = await tx.bankStatementLine.findMany({ where: { importId: id, status: 'UNMATCHED' }, orderBy: { lineNo: 'asc' } });
      for (const l of open) {
        const o = overrides.get(l.id); const amt = Number(l.amount); const out = amt < 0;
        const [noon] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT ((${isoDate(l.bookedOn)}::date + time '12:00') AT TIME ZONE ${timezone}) AS at`;
        const at = noon!.at; // midday household time on the booking date
        const base = { householdId: ctx.householdId!, amount: Math.abs(amt), baseAmount: Math.abs(amt), currency, occurredAt: at, source: 'BANK_FEED' as const,
          status: 'POSTED' as const, createdById: ctx.membershipId!, merchantName: l.description.slice(0, 120) || null,
          externalRef: l.reference ?? `stmt:${l.id}`, descriptionI18n: { [ctx.locale]: l.description } };
        const data = o?.counterAccountId
          ? (out ? { ...base, type: 'TRANSFER' as const, accountId: imp.accountId, counterAccountId: o.counterAccountId }
                 : { ...base, type: 'TRANSFER' as const, accountId: o.counterAccountId, counterAccountId: imp.accountId })
          : o?.isFunding && out ? { ...base, type: 'TRANSFER' as const, isFunding: true, accountId: imp.accountId }
          : out ? { ...base, type: 'EXPENSE' as const, accountId: imp.accountId, categoryId: o?.categoryId ?? b.defaultExpenseCategoryId }
          : { ...base, type: 'INCOME' as const, accountId: imp.accountId, categoryId: o?.categoryId ?? b.defaultIncomeCategoryId };
        const t = await tx.transaction.create({ data });
        await tx.bankStatementLine.updateMany({ where: { id: l.id }, data: { status: 'CREATED', transactionId: t.id } });
      }
      const linked = (await tx.bankStatementLine.findMany({ where: { importId: id, transactionId: { not: null } }, select: { transactionId: true } })).map((x) => x.transactionId!);
      const { count: reconciled } = await tx.transaction.updateMany({ where: { id: { in: linked }, status: 'POSTED' }, data: { status: 'RECONCILED' } });
      await tx.bankStatementImport.updateMany({ where: { id }, data: { status: 'APPLIED', appliedAt: new Date() } });

      // Book balance at the statement's last day vs the bank's closing balance.
      let balanceCheck = null;
      if (imp.closingBalance != null && imp.periodEnd) {
        const [r] = await tx.$queryRaw<Array<{ bal: string }>>`
          SELECT (a."openingBalance" + COALESCE(sum(CASE WHEN t."counterAccountId" = a.id THEN t.amount
                                                         WHEN t.type IN ('INCOME', 'REFUND') THEN t.amount ELSE -t.amount END), 0))::text AS bal
          FROM financial_accounts a LEFT JOIN transactions t ON (t."accountId" = a.id OR t."counterAccountId" = a.id)
            AND t.status IN ('POSTED', 'RECONCILED') AND (t."occurredAt" AT TIME ZONE ${timezone})::date <= ${isoDate(imp.periodEnd)}::date
          WHERE a.id = ${imp.accountId}::uuid GROUP BY a.id, a."openingBalance"`;
        const book = Number(r?.bal ?? 0), bank = Number(imp.closingBalance);
        balanceCheck = { asOf: isoDate(imp.periodEnd), bank: bank.toFixed(2), books: book.toFixed(2), difference: (bank - book).toFixed(2), balanced: Math.abs(bank - book) < 0.005 };
      }
      return { ...(await this.detail(tx, id)), transactionsCreated: open.length, transactionsReconciled: reconciled, balanceCheck };
    });
  }

  private async autoMatch(tx: Tx, ctx: RequestContext, importId: string, accountId: string) {
    const lines = await tx.bankStatementLine.findMany({ where: { importId, status: 'UNMATCHED' } });
    if (!lines.length) return;
    const from = new Date(Math.min(...lines.map((l) => l.bookedOn.getTime())) - 4 * 86_400_000);
    const to = new Date(Math.max(...lines.map((l) => l.bookedOn.getTime())) + 4 * 86_400_000);
    const { timezone } = await household(tx, ctx.householdId!);
    const cands = await tx.$queryRaw<Array<{ id: string; d: string; amount: string; ext: string | null; merchant: string | null }>>`
      SELECT t.id::text, to_char((t."occurredAt" AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS d,
             (CASE WHEN t."counterAccountId" = ${accountId}::uuid THEN t.amount WHEN t.type IN ('INCOME', 'REFUND') THEN t.amount ELSE -t.amount END)::text AS amount,
             t."externalRef" AS ext, t."merchantName" AS merchant
      FROM transactions t
      WHERE (t."accountId" = ${accountId}::uuid OR t."counterAccountId" = ${accountId}::uuid) AND t.status = 'POSTED'
        AND t."occurredAt" BETWEEN ${from} AND ${to}
        AND NOT EXISTS (SELECT 1 FROM bank_statement_lines s WHERE s."transactionId" = t.id)`;
    const matches = matchStatementLines(
      lines.map((l) => ({ id: l.id, date: isoDate(l.bookedOn)!, amount: Number(l.amount), reference: l.reference, description: l.description })),
      cands.map((c) => ({ id: c.id, date: c.d, amount: Number(c.amount), externalRef: c.ext, merchantName: c.merchant })));
    for (const m of matches) await tx.bankStatementLine.updateMany({ where: { id: m.lineId }, data: { status: 'MATCHED', transactionId: m.transactionId, matchScore: m.score } });
  }

  private async detail(tx: Tx, id: string) {
    const imp = await tx.bankStatementImport.findFirst({ where: { id } });
    if (!imp) throw new NotFoundException('statement not found');
    return importDto(imp, await tx.bankStatementLine.findMany({ where: { importId: id } }));
  }
}
