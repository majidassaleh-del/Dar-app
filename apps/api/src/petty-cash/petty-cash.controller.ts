import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { PettyCashAccount, PettyCashLog } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const amount = z.number().positive().max(1_000_000);
const CreateFloat = z.object({
  custodianId: z.guid(), name: z.string().trim().min(1).max(80), currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
  floatLimit: amount, lowBalanceAlert: z.number().min(0).optional(), receiptRequiredOver: z.number().min(0).default(0),
  allowNegative: z.boolean().default(false), financialAccountId: z.guid().optional(),
}).strict();
const UpdateFloat = z.object({
  custodianId: z.guid().optional(), name: z.string().trim().min(1).max(80).optional(), floatLimit: amount.optional(),
  lowBalanceAlert: z.number().min(0).optional(), receiptRequiredOver: z.number().min(0).optional(),
  allowNegative: z.boolean().optional(), isActive: z.boolean().optional(),
}).strict();
const Spend = z.object({
  amount, description: z.string().trim().min(1).max(300), merchantName: z.string().max(120).optional(), receiptId: z.guid().optional(),
  categoryId: z.guid().optional(), vehicleId: z.guid().optional(), workOrderId: z.guid().optional(), tripId: z.guid().optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
}).strict();
const Simple = z.object({ amount, description: z.string().trim().min(1).max(300).optional() }).strict();
const Adjust = z.object({ amount: z.number().refine((n) => n !== 0, 'non-zero').refine((n) => Math.abs(n) <= 1_000_000), reason: z.string().trim().min(3).max(300) }).strict();
const Review = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), categoryId: z.guid().optional() }).strict();
const FundFromBank = z.object({ accountId: z.guid(), amount, description: z.string().trim().max(200).optional() }).strict();
const Reconcile = z.object({ countedCash: z.number().min(0).max(1_000_000), note: z.string().max(300).optional() }).strict();
const LogQuery = z.object({ status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED']).optional(), type: z.enum(['TOP_UP', 'EXPENSE', 'RETURN', 'ADJUSTMENT']).optional() });

const floatDto = (a: PettyCashAccount, locale: RequestContext['locale']) => ({
  id: a.id, custodianId: a.custodianId, name: resolveI18n(a.nameI18n as I18nText, { locale }).text, currency: a.currency,
  floatLimit: money(a.floatLimit), balance: money(a.currentBalance), lowBalanceAlert: money(a.lowBalanceAlert),
  lowBalance: a.lowBalanceAlert != null && Number(a.currentBalance) <= Number(a.lowBalanceAlert),
  receiptRequiredOver: money(a.receiptRequiredOver), allowNegative: a.allowNegative, isActive: a.isActive, lastReconciledAt: a.lastReconciledAt,
});
const logDto = (l: PettyCashLog, locale: RequestContext['locale']) => ({
  id: l.id, accountId: l.accountId, type: l.type, status: l.status, amount: money(l.amount), balanceAfter: money(l.balanceAfter),
  description: resolveI18n(l.descriptionI18n as I18nText, { locale, originalLocale: l.originalLocale }).text,
  merchantName: l.merchantName, receiptId: l.receiptId, categoryId: l.categoryId, vehicleId: l.vehicleId, workOrderId: l.workOrderId,
  tripId: l.tripId, recordedById: l.recordedById, reviewedById: l.reviewedById, reviewedAt: l.reviewedAt, occurredAt: l.occurredAt,
});

/**
 * Imprest floats held by drivers / housekeepers. Balance, float limit,
 * overdraft, receipt threshold, custodian-only logging and review states are
 * enforced in the database (app.apply_petty_cash, policies, column grants).
 */
@Controller('petty-cash')
export class PettyCashController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.pettyCashAccount.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => floatDto(a, ctx.locale)),
    }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateFloat)) b: z.infer<typeof CreateFloat>) {
    return this.db.withRls(ctx, async (tx) => {
      const { name, ...rest } = b;
      return floatDto(await tx.pettyCashAccount.create({ data: { ...rest, householdId: ctx.householdId!, nameI18n: { [ctx.locale]: name } } }), ctx.locale);
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(UpdateFloat)) b: z.infer<typeof UpdateFloat>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      const { name, ...rest } = b;
      const { count } = await tx.pettyCashAccount.updateMany({ where: { id }, data: { ...rest, ...(name ? { nameI18n: { [ctx.locale]: name } } : {}) } });
      await assertWritten(count, async () => a, 'petty cash float');
      return floatDto(await this.find(tx, id), ctx.locale);
    });
  }

  @Get(':id/logs')
  logs(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(LogQuery)) q: z.infer<typeof LogQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.find(tx, id);
      return { data: (await tx.pettyCashLog.findMany({ where: { accountId: id, status: q.status, type: q.type }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 500 }))
        .map((l) => logDto(l, ctx.locale)) };
    });
  }

  /** Custodian spends from their float (lands PENDING_REVIEW); a manager can also record on their behalf. */
  @Post(':id/expenses')
  expense(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Spend)) b: z.infer<typeof Spend>) {
    const { description, occurredAt, ...rest } = b;
    return this.log(ctx, id, 'EXPENSE', b.amount, description, { ...rest, ...(occurredAt ? { occurredAt: new Date(occurredAt) } : {}) });
  }

  @Post(':id/returns')
  giveBack(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Simple)) b: z.infer<typeof Simple>) {
    return this.log(ctx, id, 'RETURN', b.amount, b.description ?? 'Cash returned');
  }

  @Post(':id/top-ups')
  topUp(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Simple)) b: z.infer<typeof Simple>) {
    return this.log(ctx, id, 'TOP_UP', b.amount, b.description ?? 'Top-up');
  }

  @Post(':id/adjustments')
  adjust(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Adjust)) b: z.infer<typeof Adjust>) {
    return this.log(ctx, id, 'ADJUSTMENT', b.amount, b.reason);
  }

  /**
   * One-touch: move money from a bank account into this float. In ONE transaction:
   * a funding bank transaction (Dr 1190 / Cr bank), the petty-cash TOP_UP
   * (Dr float / Cr 1190), and the funding match between them, so the
   * clearing account nets to zero immediately (nothing left to reconcile by hand).
   */
  @Post(':id/fund-from-bank')
  fundFromBank(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(FundFromBank)) b: z.infer<typeof FundFromBank>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      const floatName = resolveI18n(a.nameI18n as I18nText, { locale: ctx.locale }).text;
      const bank = await tx.transaction.create({ data: { householdId: ctx.householdId!, accountId: b.accountId, type: 'TRANSFER', isFunding: true,
        amount: b.amount, baseAmount: b.amount, currency: a.currency, occurredAt: new Date(), createdById: ctx.membershipId!,
        merchantName: `Petty cash top-up: ${floatName}`.slice(0, 120), descriptionI18n: { [ctx.locale]: b.description ?? `Petty cash top-up: ${floatName}` } } });
      const log = await tx.pettyCashLog.create({ data: { householdId: ctx.householdId!, accountId: id, type: 'TOP_UP', amount: b.amount,
        descriptionI18n: { [ctx.locale]: b.description ?? 'Top-up from bank' }, originalLocale: ctx.locale, recordedById: ctx.membershipId! } });
      const entry = await tx.journalEntry.findFirst({ where: { source: 'PETTY_CASH', sourceId: log.id }, select: { id: true } });
      if (!entry) throw new NotFoundException('top-up was not posted to the ledger');
      await tx.fundingMatch.create({ data: { householdId: ctx.householdId!, transactionId: bank.id, journalEntryId: entry.id, amount: b.amount, matchedById: ctx.membershipId! } });
      return { float: floatDto(await this.find(tx, id), ctx.locale), entry: logDto(log, ctx.locale), bankTransactionId: bank.id, fundingMatched: b.amount.toFixed(2) };
    });
  }

  /** Count the cash in hand; any variance becomes a signed ADJUSTMENT so the books match the box. */
  @Post(':id/reconcile')
  reconcile(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Reconcile)) b: z.infer<typeof Reconcile>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      const variance = Math.round((b.countedCash - Number(a.currentBalance)) * 100) / 100;
      let adjustment = null;
      if (variance !== 0) {
        adjustment = logDto(await tx.pettyCashLog.create({ data: { householdId: ctx.householdId!, accountId: id, type: 'ADJUSTMENT', amount: variance,
          descriptionI18n: { [ctx.locale]: b.note ?? `Reconciliation: counted ${b.countedCash.toFixed(2)}` }, originalLocale: ctx.locale,
          recordedById: ctx.membershipId! } }), ctx.locale);
      }
      const { count } = await tx.pettyCashAccount.updateMany({ where: { id }, data: { lastReconciledAt: new Date() } });
      await assertWritten(count, async () => a, 'petty cash float');
      return { expected: money(a.currentBalance), counted: b.countedCash.toFixed(2), variance: variance.toFixed(2), adjustment,
               float: floatDto(await this.find(tx, id), ctx.locale) };
    });
  }

  @Post('logs/:logId/review')
  review(@Ctx() ctx: RequestContext, @Param('logId', ParseUUIDPipe) logId: string, @Body(new ZodBody(Review)) b: z.infer<typeof Review>) {
    return this.db.withRls(ctx, async (tx) => {
      const l = await tx.pettyCashLog.findFirst({ where: { id: logId } });
      if (!l) throw new NotFoundException('petty cash entry not found');
      const { count } = await tx.pettyCashLog.updateMany({ where: { id: logId, status: 'PENDING_REVIEW' },
        data: { status: b.decision, categoryId: b.categoryId, reviewedById: ctx.membershipId, reviewedAt: new Date() } });
      await assertWritten(count, async () => l, 'petty cash entry (already reviewed, or not yours to review)');
      return logDto((await tx.pettyCashLog.findFirst({ where: { id: logId } }))!, ctx.locale);
    });
  }

  private log(ctx: RequestContext, accountId: string, type: PettyCashLog['type'], amount: number, description: string, extra: object = {}) {
    return this.db.withRls(ctx, async (tx) => {
      await this.find(tx, accountId);
      const l = await tx.pettyCashLog.create({ data: { ...extra, householdId: ctx.householdId!, accountId, type, amount,
        descriptionI18n: { [ctx.locale]: description }, originalLocale: ctx.locale, recordedById: ctx.membershipId! } });
      return { entry: logDto(l, ctx.locale), float: floatDto(await this.find(tx, accountId), ctx.locale) };
    });
  }

  private async find(tx: Tx, id: string) {
    const a = await tx.pettyCashAccount.findFirst({ where: { id } });
    if (!a) throw new NotFoundException('petty cash float not found');
    return a;
  }
}
