import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { JournalEntry, JournalLine, LedgerAccount } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, isoDate, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
const CreateAccount = z.object({
  code: z.string().regex(/^[0-9]{4,10}$/), name: z.string().trim().min(1).max(120), type: z.enum(TYPES),
  parentId: z.guid().optional(), isHeader: z.boolean().default(false), categoryId: z.guid().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
}).strict();
const UpdateAccount = z.object({ name: z.string().trim().min(1).max(120).optional(), isActive: z.boolean().optional(),
  parentId: z.guid().optional(), categoryId: z.guid().nullable().optional() }).strict();
const cents = (n: number) => Math.round(n * 100);
const Line = z.object({ accountId: z.guid(), debit: z.number().min(0).max(1e10).optional(), credit: z.number().min(0).max(1e10).optional(),
  staffId: z.guid().optional(), memo: z.string().max(300).optional() }).strict()
  .refine((l) => (l.debit ?? 0) > 0 !== (l.credit ?? 0) > 0, 'each line is either a debit or a credit (non-zero)');
const CreateEntry = z.object({
  entryDate: ymd, description: z.string().trim().min(1).max(300), opening: z.boolean().default(false),
  lines: z.array(Line).min(2).max(200),
}).strict().superRefine((e, ctx) => {
  const dr = e.lines.reduce((s, l) => s + cents(l.debit ?? 0), 0), cr = e.lines.reduce((s, l) => s + cents(l.credit ?? 0), 0);
  if (dr !== cr) ctx.addIssue({ code: 'custom', path: ['lines'], message: `entry does not balance: debits ${(dr / 100).toFixed(2)} ≠ credits ${(cr / 100).toFixed(2)}` });
});
const Reverse = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const JournalQuery = z.object({ from: ymd.optional(), to: ymd.optional(), source: z.string().optional(), sourceId: z.guid().optional(),
  accountId: z.guid().optional(), staffId: z.guid().optional() });
const AsOf = z.object({ asOf: ymd.optional() });
const Range = z.object({ from: ymd.optional(), to: ymd.optional() });
const CloseBooks = z.object({ through: ymd }).strict();

const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE']);
const d = (s?: string) => (s ? new Date(`${s}T00:00:00Z`) : undefined);
/** Balance in the account's normal direction (assets/expenses: debit − credit; others: credit − debit). */
const signed = (type: string, dr: number, cr: number) => (DEBIT_NORMAL.has(type) ? dr - cr : cr - dr);

const accountDto = (a: LedgerAccount, locale: RequestContext['locale'], totals?: { dr: number; cr: number }) => ({
  id: a.id, code: a.code, name: resolveI18n(a.nameI18n as I18nText, { locale }).text, type: a.type, parentId: a.parentId,
  isHeader: a.isHeader, isSystem: a.isSystem, systemKey: a.systemKey, categoryId: a.categoryId, pettyCashAccountId: a.pettyCashAccountId,
  isActive: a.isActive, currency: a.currency,
  ...(totals ? { debits: totals.dr.toFixed(2), credits: totals.cr.toFixed(2), balance: signed(a.type, totals.dr, totals.cr).toFixed(2) } : {}),
});
type EntryWithLines = JournalEntry & { lines: (JournalLine & { account: LedgerAccount })[] };
const entryDto = (e: EntryWithLines, locale: RequestContext['locale']) => ({
  id: e.id, number: `JE-${String(e.number).padStart(6, '0')}`, entryDate: isoDate(e.entryDate), source: e.source, sourceId: e.sourceId,
  status: e.status, reversalOfId: e.reversalOfId, reversalReason: e.reversalReason, postedById: e.postedById, currency: e.currency,
  description: resolveI18n(e.descriptionI18n as I18nText, { locale, originalLocale: 'en' }).text, createdAt: e.createdAt,
  lines: e.lines.map((l) => ({ id: l.id, accountId: l.ledgerAccountId, accountCode: l.account.code,
    account: resolveI18n(l.account.nameI18n as I18nText, { locale }).text, debit: money(l.debit), credit: money(l.credit), staffId: l.staffId, memo: l.memo })),
  totals: { debit: e.lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(2), credit: e.lines.reduce((s, l) => s + Number(l.credit), 0).toFixed(2) },
});

/**
 * Double-entry ledger. Operational modules post automatically through DB hooks
 * (petty cash, payroll, salary payments, advances). This controller exposes the
 * chart of accounts, journals, statements and the trial balance, and accepts
 * MANUAL / OPENING_BALANCE entries. Balance, immutability, period lock and
 * household isolation are enforced in the database.
 */
@Controller('ledger')
export class LedgerController {
  constructor(private readonly db: PrismaService) {}

  @Get('accounts')
  accounts(@Ctx() ctx: RequestContext, @Query(new ZodQuery(AsOf)) q: z.infer<typeof AsOf>) {
    return this.db.withRls(ctx, async (tx) => {
      const [accs, totals] = await Promise.all([tx.ledgerAccount.findMany({ orderBy: { code: 'asc' } }), this.totals(tx, q.asOf)]);
      return { data: accs.map((a) => accountDto(a, ctx.locale, totals.get(a.id) ?? { dr: 0, cr: 0 })) };
    });
  }

  @Post('accounts')
  createAccount(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateAccount)) b: z.infer<typeof CreateAccount>) {
    return this.db.withRls(ctx, async (tx) => {
      if (b.categoryId && b.type !== 'EXPENSE') throw new BadRequestException('categoryId: only EXPENSE accounts map to categories');
      const { name, ...rest } = b;
      return accountDto(await tx.ledgerAccount.create({ data: { ...rest, householdId: ctx.householdId!, nameI18n: { [ctx.locale]: name } } }), ctx.locale);
    });
  }

  @Patch('accounts/:id')
  updateAccount(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(UpdateAccount)) b: z.infer<typeof UpdateAccount>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await tx.ledgerAccount.findFirst({ where: { id } });
      if (!a) throw new NotFoundException('account not found');
      if (b.categoryId && a.type !== 'EXPENSE') throw new BadRequestException('categoryId: only EXPENSE accounts map to categories');
      const { name, ...rest } = b;
      const { count } = await tx.ledgerAccount.updateMany({ where: { id }, data: { ...rest, ...(name ? { nameI18n: { ...(a.nameI18n as object), [ctx.locale]: name } } : {}) } });
      await assertWritten(count, async () => a, 'ledger account');
      return accountDto((await tx.ledgerAccount.findFirst({ where: { id } }))!, ctx.locale);
    });
  }

  /** Lines with a running balance; opening balance = everything before `from`. */
  @Get('accounts/:id/statement')
  statement(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(Range)) q: z.infer<typeof Range>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await tx.ledgerAccount.findFirst({ where: { id } });
      if (!a) throw new NotFoundException('account not found');
      const before = q.from ? await tx.journalLine.aggregate({ where: { ledgerAccountId: id, entry: { entryDate: { lt: d(q.from) } } }, _sum: { debit: true, credit: true } }) : null;
      let running = before ? signed(a.type, Number(before._sum.debit ?? 0), Number(before._sum.credit ?? 0)) : 0;
      const opening = running;
      const lines = await tx.journalLine.findMany({
        where: { ledgerAccountId: id, entry: { entryDate: { gte: d(q.from), lte: d(q.to) } } },
        include: { entry: true }, orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { number: 'asc' } }],
      });
      return {
        account: accountDto(a, ctx.locale), opening: opening.toFixed(2),
        lines: lines.map((l) => {
          running += signed(a.type, Number(l.debit), Number(l.credit));
          return { entryId: l.entryId, number: `JE-${String(l.entry.number).padStart(6, '0')}`, entryDate: isoDate(l.entry.entryDate), source: l.entry.source,
                   description: resolveI18n(l.entry.descriptionI18n as I18nText, { locale: ctx.locale, originalLocale: 'en' }).text,
                   debit: money(l.debit), credit: money(l.credit), staffId: l.staffId, memo: l.memo, balance: running.toFixed(2) };
        }),
        closing: running.toFixed(2),
      };
    });
  }

  @Get('journal')
  journal(@Ctx() ctx: RequestContext, @Query(new ZodQuery(JournalQuery)) q: z.infer<typeof JournalQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.journalEntry.findMany({
        where: { entryDate: { gte: d(q.from), lte: d(q.to) }, source: q.source as never, sourceId: q.sourceId,
                 ...(q.accountId || q.staffId ? { lines: { some: { ledgerAccountId: q.accountId, staffId: q.staffId } } } : {}) },
        include: { lines: { include: { account: true }, orderBy: [{ debit: 'desc' }, { createdAt: 'asc' }] } },
        orderBy: [{ entryDate: 'desc' }, { number: 'desc' }], take: 500,
      })).map((e) => entryDto(e, ctx.locale)),
    }));
  }

  @Get('journal/:id')
  entry(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => entryDto(await this.loadEntry(tx, id), ctx.locale));
  }

  @Post('journal')
  post(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateEntry)) b: z.infer<typeof CreateEntry>) {
    return this.db.withRls(ctx, async (tx) => {
      const e = await tx.journalEntry.create({ data: { householdId: ctx.householdId!, entryDate: d(b.entryDate)!, source: b.opening ? 'OPENING_BALANCE' : 'MANUAL',
        descriptionI18n: { [ctx.locale]: b.description }, postedById: ctx.membershipId } });
      await tx.journalLine.createMany({ data: b.lines.map((l) => ({ householdId: ctx.householdId!, entryId: e.id, ledgerAccountId: l.accountId,
        debit: l.debit ?? 0, credit: l.credit ?? 0, staffId: l.staffId, memo: l.memo })) });
      return entryDto(await this.loadEntry(tx, e.id), ctx.locale);
    });
  }

  @Post('journal/:id/reverse')
  reverse(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Reverse)) b: z.infer<typeof Reverse>) {
    return this.db.withRls(ctx, async (tx) => {
      const [r] = await tx.$queryRaw<Array<{ id: string }>>`SELECT app.reverse_journal_entry(${id}::uuid, ${b.reason})::text AS id`;
      return { reversal: entryDto(await this.loadEntry(tx, r!.id), ctx.locale), original: entryDto(await this.loadEntry(tx, id), ctx.locale) };
    });
  }

  /** Every non-header account with movements; Σ debit balances must equal Σ credit balances. */
  @Get('trial-balance')
  trialBalance(@Ctx() ctx: RequestContext, @Query(new ZodQuery(AsOf)) q: z.infer<typeof AsOf>) {
    return this.db.withRls(ctx, async (tx) => {
      const [accs, totals] = await Promise.all([tx.ledgerAccount.findMany({ where: { isHeader: false }, orderBy: { code: 'asc' } }), this.totals(tx, q.asOf)]);
      let dr = 0, cr = 0;
      const rows = accs.filter((a) => totals.has(a.id)).map((a) => {
        const t = totals.get(a.id)!; const net = t.dr - t.cr;
        if (net >= 0) dr += net; else cr -= net;
        return { ...accountDto(a, ctx.locale, t), debitBalance: net > 0 ? net.toFixed(2) : '0.00', creditBalance: net < 0 ? (-net).toFixed(2) : '0.00' };
      });
      return { asOf: q.asOf ?? null, rows, totals: { debit: dr.toFixed(2), credit: cr.toFixed(2) }, balanced: cents(dr) === cents(cr) };
    });
  }

  /** Per-worker sub-ledger: salary advances, receivables (rejected petty cash), unpaid net salary. */
  @Get('staff/:staffId')
  staffLedger(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => {
      // 404 for a worker the caller cannot see (another household, or not permitted), not a page of zeros.
      if (!(await tx.staffProfile.findFirst({ where: { id: staffId }, select: { id: true } }))) throw new NotFoundException('staff member not found');
      const rows = await tx.$queryRaw<Array<{ key: string; type: string; dr: string; cr: string }>>`
        SELECT a."systemKey" AS key, a.type::text AS type, COALESCE(sum(l.debit), 0)::text AS dr, COALESCE(sum(l.credit), 0)::text AS cr
        FROM journal_lines l JOIN ledger_accounts a ON a.id = l."ledgerAccountId"
        WHERE l."staffId" = ${staffId}::uuid AND a."systemKey" IN ('staff_advances', 'staff_receivables', 'salaries_payable', 'salaries_expense')
        GROUP BY a."systemKey", a.type`;
      const bal = (k: string) => { const r = rows.find((x) => x.key === k); return r ? signed(r.type, Number(r.dr), Number(r.cr)) : 0; };
      return { staffId, advancesOutstanding: bal('staff_advances').toFixed(2), owedByWorker: bal('staff_receivables').toFixed(2),
               salaryPayable: bal('salaries_payable').toFixed(2), salaryCostToDate: bal('salaries_expense').toFixed(2) };
    });
  }

  @Get('settings')
  settings(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const h = await tx.household.findFirst({ where: { id: ctx.householdId }, select: { booksClosedThrough: true, baseCurrency: true } });
      return { booksClosedThrough: isoDate(h?.booksClosedThrough), baseCurrency: h?.baseCurrency };
    });
  }

  /** Period lock (Head / EFA only, forward only, past dates only), audited. */
  @Post('close-books')
  closeBooks(@Ctx() ctx: RequestContext, @Body(new ZodBody(CloseBooks)) b: z.infer<typeof CloseBooks>) {
    return this.db.withRls(ctx, async (tx) => {
      await tx.$queryRaw`SELECT app.close_books(${b.through}::date)`;
      return { booksClosedThrough: b.through };
    });
  }

  private async totals(tx: Tx, asOf?: string) {
    const rows = await tx.journalLine.groupBy({ by: ['ledgerAccountId'], where: asOf ? { entry: { entryDate: { lte: d(asOf) } } } : {}, _sum: { debit: true, credit: true } });
    return new Map(rows.map((r) => [r.ledgerAccountId, { dr: Number(r._sum.debit ?? 0), cr: Number(r._sum.credit ?? 0) }]));
  }

  private async loadEntry(tx: Tx, id: string): Promise<EntryWithLines> {
    const e = await tx.journalEntry.findFirst({ where: { id }, include: { lines: { include: { account: true }, orderBy: [{ debit: 'desc' }, { createdAt: 'asc' }] } } });
    if (!e) throw new NotFoundException('journal entry not found');
    return e;
  }
}
