import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { Prisma, Transaction } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, money as fmt } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { household, iso, money, ymd } from './banking.common';

const Create = z.object({
  type: z.enum(['EXPENSE', 'INCOME', 'TRANSFER']), accountId: z.guid(), amount: money,
  occurredAt: iso.optional(), categoryId: z.guid().optional(), cardId: z.guid().optional(), counterAccountId: z.guid().optional(),
  /** Owner funding outflow (TRANSFER without a counter account): Dr 1190 / Cr bank, later matched to clearing items. */
  isFunding: z.boolean().default(false),
  merchantName: z.string().max(120).optional(), description: z.string().max(300).optional(), vatAmount: z.number().min(0).optional(),
  status: z.enum(['PENDING', 'POSTED']).default('POSTED'), externalRef: z.string().max(120).optional(),
  tags: z.array(z.string().max(30)).max(20).default([]), spentById: z.guid().optional(), vehicleId: z.guid().optional(), propertyId: z.guid().optional(),
}).strict().superRefine((t, ctx) => {
  if (t.type === 'TRANSFER' && !t.isFunding && !t.counterAccountId) ctx.addIssue({ code: 'custom', path: ['counterAccountId'], message: 'a transfer needs counterAccountId (or isFunding: true)' });
  if (t.isFunding && (t.type !== 'TRANSFER' || t.counterAccountId)) ctx.addIssue({ code: 'custom', path: ['isFunding'], message: 'funding is a TRANSFER without counterAccountId' });
  if (t.type !== 'TRANSFER' && t.counterAccountId) ctx.addIssue({ code: 'custom', path: ['counterAccountId'], message: 'only transfers have a counter account' });
});
const Update = z.object({ categoryId: z.guid().nullable().optional(), description: z.string().max(300).optional(), merchantName: z.string().max(120).optional(),
  tags: z.array(z.string().max(30)).max(20).optional(), status: z.enum(['POSTED', 'RECONCILED']).optional() }).strict();
const ListQuery = z.object({ accountId: z.guid().optional(), cardId: z.guid().optional(), categoryId: z.guid().optional(), spentById: z.guid().optional(),
  status: z.enum(['PENDING', 'POSTED', 'RECONCILED', 'REVERSED']).optional(), from: ymd.optional(), to: ymd.optional(),
  isFunding: z.enum(['true', 'false']).optional(), q: z.string().max(60).optional() });
const Reverse = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const Match = z.object({ matches: z.array(z.object({ journalEntryId: z.guid(), amount: money }).strict()).min(1).max(100) }).strict();

const dto = (t: Transaction, locale: RequestContext['locale']) => ({
  id: t.id, type: t.type, status: t.status, source: t.source, isFunding: t.isFunding, accountId: t.accountId, counterAccountId: t.counterAccountId,
  cardId: t.cardId, categoryId: t.categoryId, amount: fmt(t.amount), currency: t.currency, vatAmount: fmt(t.vatAmount), merchantName: t.merchantName,
  description: resolveI18n(t.descriptionI18n as I18nText, { locale }).text || null, occurredAt: t.occurredAt, createdById: t.createdById,
  spentById: t.spentById, recurringRuleId: t.recurringRuleId, externalRef: t.externalRef, tags: t.tags, reconciledAt: t.reconciledAt, createdAt: t.createdAt,
});

/** Everyday money movements. Card rules, immutability, balances and ledger postings are DB-enforced. */
@Controller()
export class TransactionsController {
  constructor(private readonly db: PrismaService) {}

  @Get('transactions')
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      const where: Prisma.TransactionWhereInput = {
        accountId: q.accountId, cardId: q.cardId, categoryId: q.categoryId, spentById: q.spentById, status: q.status,
        ...(q.isFunding ? { isFunding: q.isFunding === 'true' } : {}),
        occurredAt: { gte: q.from ? new Date(`${q.from}T00:00:00Z`) : undefined, lte: q.to ? new Date(`${q.to}T23:59:59Z`) : undefined },
        ...(q.q ? { merchantName: { contains: q.q, mode: 'insensitive' } } : {}),
      };
      return { data: (await tx.transaction.findMany({ where, orderBy: { occurredAt: 'desc' }, take: 500 })).map((t) => dto(t, ctx.locale)) };
    });
  }

  @Post('transactions')
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      const { currency } = await household(tx, ctx.householdId!);
      const { description, occurredAt, ...rest } = b;
      const t = await tx.transaction.create({ data: { ...rest, householdId: ctx.householdId!, currency, baseAmount: b.amount,
        occurredAt: occurredAt ? new Date(occurredAt) : new Date(), createdById: ctx.membershipId!, spentById: b.spentById ?? ctx.membershipId,
        descriptionI18n: description ? { [ctx.locale]: description } : {} } });
      return this.detail(tx, ctx, t.id);
    });
  }

  @Get('transactions/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, (tx) => this.detail(tx, ctx, id));
  }

  @Patch('transactions/:id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Update)) b: z.infer<typeof Update>) {
    return this.db.withRls(ctx, async (tx) => {
      const t = await this.find(tx, id);
      const { description, ...rest } = b;
      const { count } = await tx.transaction.updateMany({ where: { id }, data: { ...rest, ...(description ? { descriptionI18n: { ...(t.descriptionI18n as object), [ctx.locale]: description } } : {}) } });
      await assertWritten(count, async () => t, 'transaction');
      return this.detail(tx, ctx, id);
    });
  }

  @Post('transactions/:id/reverse')
  reverse(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Reverse)) b: z.infer<typeof Reverse>) {
    return this.db.withRls(ctx, async (tx) => {
      await tx.$executeRaw`SELECT app.reverse_transaction(${id}::uuid, ${b.reason})`; // returns void: executeRaw, not queryRaw
      return this.detail(tx, ctx, id);
    });
  }

  /** Open clearing items, best candidates first: exact remaining amount, then nearest date. */
  @Get('transactions/:id/funding-suggestions')
  suggestions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const t = await this.find(tx, id);
      const left = Number(t.amount) - (await this.matchedOnTxn(tx, id));
      const items = await openClearingItems(tx, ctx);
      const rank = (i: { remaining: string; entryDate: string }) => [Math.abs(Number(i.remaining) - left) < 0.005 ? 0 : 1,
        Math.abs(new Date(i.entryDate).getTime() - t.occurredAt.getTime())] as const;
      return { transactionId: id, unmatched: left.toFixed(2), candidates: items.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; }).slice(0, 20) };
    });
  }

  @Post('transactions/:id/funding-matches')
  match(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Match)) b: z.infer<typeof Match>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.find(tx, id);
      for (const m of b.matches) {
        await tx.fundingMatch.create({ data: { householdId: ctx.householdId!, transactionId: id, journalEntryId: m.journalEntryId, amount: m.amount, matchedById: ctx.membershipId! } });
      }
      return this.detail(tx, ctx, id);
    });
  }

  @Delete('transactions/:id/funding-matches/:matchId')
  unmatch(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('matchId', ParseUUIDPipe) matchId: string) {
    return this.db.withRls(ctx, async (tx) => {
      const m = await tx.fundingMatch.findFirst({ where: { id: matchId, transactionId: id } });
      if (!m) throw new NotFoundException('match not found');
      const { count } = await tx.fundingMatch.deleteMany({ where: { id: matchId } });
      await assertWritten(count, async () => m, 'funding match');
      return this.detail(tx, ctx, id);
    });
  }

  /**
   * Reconciliation of 1190 Owner funding clearing: what the owner paid out
   * (petty-cash top-ups, salary payments, advances) vs the bank transactions
   * that funded them. Everything matched ⇒ clearing balance 0.
   */
  @Get('funding-clearing')
  clearing(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const [bal] = await tx.$queryRaw<Array<{ b: string | null }>>`
        SELECT (sum(l.debit) - sum(l.credit))::text AS b FROM journal_lines l JOIN ledger_accounts a ON a.id = l."ledgerAccountId" WHERE a."systemKey" = 'funding_clearing'`;
      const items = await openClearingItems(tx, ctx);
      const funding = await tx.$queryRaw<Array<{ id: string; occurred_at: Date; amount: string; matched: string; merchant: string | null }>>`
        SELECT t.id::text, t."occurredAt" AS occurred_at, t.amount::text, COALESCE(sum(m.amount), 0)::text AS matched, t."merchantName" AS merchant
        FROM transactions t LEFT JOIN funding_matches m ON m."transactionId" = t.id
        WHERE t."isFunding" AND t.status IN ('POSTED', 'RECONCILED') GROUP BY t.id HAVING t.amount > COALESCE(sum(m.amount), 0) ORDER BY t."occurredAt"`;
      return {
        // Debit-normal: positive = owner paid out more than the bank funding recorded so far.
        clearingBalance: Number(bal?.b ?? 0).toFixed(2), openItems: items,
        unmatchedFunding: funding.map((f) => ({ transactionId: f.id, occurredAt: f.occurred_at, amount: Number(f.amount).toFixed(2), matched: Number(f.matched).toFixed(2),
          remaining: (Number(f.amount) - Number(f.matched)).toFixed(2), merchantName: f.merchant })),
      };
    });
  }

  private async matchedOnTxn(tx: Tx, id: string) {
    return Number((await tx.fundingMatch.aggregate({ where: { transactionId: id }, _sum: { amount: true } }))._sum.amount ?? 0);
  }

  private async find(tx: Tx, id: string) {
    const t = await tx.transaction.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('transaction not found');
    return t;
  }

  private async detail(tx: Tx, ctx: RequestContext, id: string) {
    const t = await this.find(tx, id);
    const entry = await tx.journalEntry.findFirst({ where: { source: 'BANK_TRANSACTION', sourceId: id }, select: { id: true, number: true, status: true } });
    const matches = await tx.fundingMatch.findMany({ where: { transactionId: id }, orderBy: { createdAt: 'asc' } });
    return { ...dto(t, ctx.locale),
      ledgerEntry: entry ? { id: entry.id, number: `JE-${String(entry.number).padStart(6, '0')}`, status: entry.status } : null,
      ...(t.isFunding ? { fundingMatches: matches.map((m) => ({ id: m.id, journalEntryId: m.journalEntryId, amount: fmt(m.amount) })),
                          unmatched: (Number(t.amount) - matches.reduce((s, m) => s + Number(m.amount), 0)).toFixed(2) } : {}) };
  }
}

/** Journal entries that credited 1190 and are not yet fully matched to bank funding. */
export async function openClearingItems(tx: Tx, ctx: RequestContext) {
  const rows = await tx.$queryRaw<Array<{ id: string; number: number; entry_date: Date; source: string; source_id: string | null; descr: I18nText; credit: string; matched: string }>>`
    WITH c AS (
      SELECT e.id, e.number, e."entryDate", e.source::text AS source, e."sourceId", e."descriptionI18n", sum(l.credit - l.debit) AS credit
      FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id JOIN ledger_accounts a ON a.id = l."ledgerAccountId"
      WHERE a."systemKey" = 'funding_clearing' AND e.status = 'POSTED' GROUP BY e.id HAVING sum(l.credit - l.debit) > 0)
    SELECT c.id::text, c.number, c."entryDate" AS entry_date, c.source, c."sourceId"::text AS source_id, c."descriptionI18n" AS descr,
           c.credit::text, COALESCE((SELECT sum(amount) FROM funding_matches m WHERE m."journalEntryId" = c.id), 0)::text AS matched
    FROM c WHERE c.credit > COALESCE((SELECT sum(amount) FROM funding_matches m WHERE m."journalEntryId" = c.id), 0)
    ORDER BY c."entryDate", c.number`;
  return rows.map((r) => ({ journalEntryId: r.id, number: `JE-${String(r.number).padStart(6, '0')}`, entryDate: r.entry_date.toISOString().slice(0, 10),
    source: r.source, sourceId: r.source_id, description: resolveI18n(r.descr, { locale: ctx.locale, originalLocale: 'en' }).text,
    amount: Number(r.credit).toFixed(2), matched: Number(r.matched).toFixed(2), remaining: (Number(r.credit) - Number(r.matched)).toFixed(2) }));
}
