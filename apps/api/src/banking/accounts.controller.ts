import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { isValidIban, seal } from '@herp/crypto';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { FinancialAccount } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { CryptoService } from '../crypto/crypto.module';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { assertWritten, money as fmt } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { household, ymd } from './banking.common';

const TYPES = ['BANK_CURRENT', 'BANK_SAVINGS', 'CASH_BOX', 'DIGITAL_WALLET', 'CREDIT_CARD', 'LOAN', 'INVESTMENT_CASH'] as const;
const Create = z.object({
  type: z.enum(TYPES), name: z.string().trim().min(1).max(80), institution: z.string().max(80).optional(),
  iban: z.string().refine(isValidIban, 'invalid IBAN (mod-97 check failed)').optional(),
  /** Asset value: positive cash; a card's or loan's opening debt is negative. */
  openingBalance: z.number().min(-100_000_000).max(100_000_000).default(0), custodianId: z.guid().optional(),
}).strict();
const Update = z.object({ name: z.string().trim().min(1).max(80).optional(), institution: z.string().max(80).optional(),
  iban: z.string().refine(isValidIban, 'invalid IBAN (mod-97 check failed)').optional(), custodianId: z.guid().nullable().optional(),
  isActive: z.boolean().optional() }).strict();
const Reconcile = z.object({ statementBalance: z.number().min(-1e10).max(1e10), asOf: ymd, transactionIds: z.array(z.guid()).max(2000).optional() }).strict();

type WithLedger = FinancialAccount & { ledgerAccount: { id: string; code: string } | null };
const dto = (a: WithLedger, locale: RequestContext['locale']) => ({
  id: a.id, type: a.type, name: resolveI18n(a.nameI18n as I18nText, { locale }).text, institution: a.institution, ibanLast4: a.ibanLast4,
  currency: a.currency, openingBalance: fmt(a.openingBalance), balance: fmt(a.currentBalance), custodianId: a.custodianId, isActive: a.isActive,
  ledgerAccount: a.ledgerAccount,
});

/** Bank / wallet / cash / card / loan accounts. Each one is mapped to its own ledger account (12xx / 22xx) by the database. */
@Controller('accounts')
export class AccountsController {
  constructor(private readonly db: PrismaService, private readonly crypto: CryptoService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.financialAccount.findMany({ include: { ledgerAccount: { select: { id: true, code: true } } }, orderBy: { createdAt: 'asc' } }))
        .map((a) => dto(a, ctx.locale)),
    }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      if (b.type !== 'CREDIT_CARD' && b.type !== 'LOAN' && b.openingBalance < 0 && b.type !== 'BANK_CURRENT') {
        throw new BadRequestException('openingBalance: only current accounts, cards and loans can open negative');
      }
      const { currency } = await household(tx, ctx.householdId!);
      const { name, iban, ...rest } = b;
      const a = await tx.financialAccount.create({ data: { ...rest, householdId: ctx.householdId!, currency, nameI18n: { [ctx.locale]: name },
        ...(await seal(this.crypto.cipher, 'financial_accounts.iban', ctx.householdId!, iban)) } });
      return dto(await this.find(tx, a.id), ctx.locale);
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => dto(await this.find(tx, id), ctx.locale));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Update)) b: z.infer<typeof Update>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      const { name, iban, ...rest } = b;
      const { count } = await tx.financialAccount.updateMany({ where: { id }, data: { ...rest, updatedAt: new Date(),
        ...(name ? { nameI18n: { ...(a.nameI18n as object), [ctx.locale]: name } } : {}),
        ...(await seal(this.crypto.cipher, 'financial_accounts.iban', ctx.householdId!, iban)) } });
      await assertWritten(count, async () => a, 'account');
      return dto(await this.find(tx, id), ctx.locale);
    });
  }

  /**
   * Bank reconciliation. Cleared balance = opening + already-RECONCILED + the
   * selected POSTED transactions up to `asOf`. If it equals the statement, the
   * selection is marked RECONCILED; otherwise nothing changes and the
   * difference is returned.
   */
  @Post(':id/reconcile')
  reconcile(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Reconcile)) b: z.infer<typeof Reconcile>) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      // End of `asOf` in the household's time zone (exclusive bound).
      const [bounds] = await tx.$queryRaw<Array<{ end: Date }>>`
        SELECT ((${b.asOf}::date + 1)::timestamp AT TIME ZONE timezone) AS end FROM households WHERE id = ${ctx.householdId}::uuid`;
      const rows = await tx.transaction.findMany({ where: { OR: [{ accountId: id }, { counterAccountId: id }], status: { in: ['POSTED', 'RECONCILED'] }, occurredAt: { lt: bounds!.end } } });
      const selected = new Set(b.transactionIds ?? rows.filter((t) => t.status === 'POSTED').map((t) => t.id));
      const unknown = [...selected].filter((x) => !rows.some((t) => t.id === x && t.status === 'POSTED'));
      if (unknown.length) throw new BadRequestException(`transactionIds: not POSTED on this account up to ${b.asOf}: ${unknown.slice(0, 5).join(', ')}`);
      const delta = (t: (typeof rows)[number]) => (t.counterAccountId === id ? Number(t.amount) : t.type === 'INCOME' || t.type === 'REFUND' ? Number(t.amount) : -Number(t.amount));
      const cleared = Number(a.openingBalance) + rows.filter((t) => t.status === 'RECONCILED' || selected.has(t.id)).reduce((s, t) => s + delta(t), 0);
      const difference = Math.round((b.statementBalance - cleared) * 100) / 100;
      if (difference !== 0) return { reconciled: false, clearedBalance: cleared.toFixed(2), statementBalance: b.statementBalance.toFixed(2), difference: difference.toFixed(2) };
      const { count } = await tx.transaction.updateMany({ where: { id: { in: [...selected] }, status: 'POSTED' }, data: { status: 'RECONCILED' } });
      return { reconciled: true, clearedBalance: cleared.toFixed(2), statementBalance: b.statementBalance.toFixed(2), difference: '0.00', transactionsReconciled: count };
    });
  }

  private async find(tx: Tx, id: string): Promise<WithLedger> {
    const a = await tx.financialAccount.findFirst({ where: { id }, include: { ledgerAccount: { select: { id: true, code: true } } } });
    if (!a) throw new NotFoundException('account not found');
    return a;
  }
}
