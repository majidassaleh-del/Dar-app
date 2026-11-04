import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { Budget } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { assertWritten, isoDate, money as fmt } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { money, periodWindow, ymd } from './banking.common';
import { todayIn } from '../staff/staff.dto';

const PERIODS = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
const Create = z.object({ name: z.string().trim().min(1).max(80), categoryId: z.guid().optional(), ownerId: z.guid().optional(),
  period: z.enum(PERIODS).default('MONTHLY'), amount: money, alertAtPct: z.number().int().min(1).max(100).default(80),
  startsOn: ymd, endsOn: ymd.optional() }).strict();
const Update = z.object({ name: z.string().trim().min(1).max(80).optional(), amount: money.optional(),
  alertAtPct: z.number().int().min(1).max(100).optional(), endsOn: ymd.nullable().optional() }).strict();

/**
 * Budgets: spent = posted bank/card expenses (POSTED or RECONCILED) plus approved
 * petty-cash expenses, in the category and all its sub-categories, inside the
 * current period (household-local). A personal budget (ownerId) counts only
 * that member's spending. Changing or deleting a budget is Head / EFA only (RLS).
 */
@Controller('budgets')
export class BudgetsController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const h = await tx.household.findFirst({ where: { id: ctx.householdId }, select: { timezone: true } });
      const today = todayIn(h?.timezone ?? 'Asia/Riyadh');
      const budgets = await tx.budget.findMany({ orderBy: { startsOn: 'asc' } });
      return { data: await Promise.all(budgets.map((b) => this.withSpend(tx, ctx, b, today))) };
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      const { name, startsOn, endsOn, ...rest } = b;
      const row = await tx.budget.create({ data: { ...rest, householdId: ctx.householdId!, nameI18n: { [ctx.locale]: name },
        startsOn: new Date(`${startsOn}T00:00:00Z`), endsOn: endsOn ? new Date(`${endsOn}T00:00:00Z`) : undefined } });
      const h = await tx.household.findFirst({ where: { id: ctx.householdId }, select: { timezone: true } });
      return this.withSpend(tx, ctx, row, todayIn(h?.timezone ?? 'Asia/Riyadh'));
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Update)) b: z.infer<typeof Update>) {
    return this.db.withRls(ctx, async (tx) => {
      const row = await this.find(tx, id);
      const { name, endsOn, ...rest } = b;
      const { count } = await tx.budget.updateMany({ where: { id }, data: { ...rest, ...(name ? { nameI18n: { ...(row.nameI18n as object), [ctx.locale]: name } } : {}),
        ...(endsOn !== undefined ? { endsOn: endsOn ? new Date(`${endsOn}T00:00:00Z`) : null } : {}) } });
      await assertWritten(count, async () => row, 'budget');
      const h = await tx.household.findFirst({ where: { id: ctx.householdId }, select: { timezone: true } });
      return this.withSpend(tx, ctx, await this.find(tx, id), todayIn(h?.timezone ?? 'Asia/Riyadh'));
    });
  }

  @Delete(':id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const row = await this.find(tx, id);
      const { count } = await tx.budget.deleteMany({ where: { id } });
      await assertWritten(count, async () => row, 'budget');
      return { deleted: true };
    });
  }

  async withSpend(tx: Tx, ctx: RequestContext, b: Budget, today: Date) {
    const { start, end } = periodWindow(b.startsOn, b.period, today);
    const [r] = await tx.$queryRaw<Array<{ bank: string; petty: string }>>`
      WITH RECURSIVE cats AS (
        SELECT id FROM categories WHERE id = ${b.categoryId}::uuid
        UNION ALL SELECT c.id FROM categories c JOIN cats ON c."parentId" = cats.id),
      h AS (SELECT timezone FROM households WHERE id = ${b.householdId}::uuid)
      SELECT
        (SELECT COALESCE(sum(t.amount), 0) FROM transactions t, h
          WHERE t.type IN ('EXPENSE', 'ALLOWANCE') AND t.status IN ('POSTED', 'RECONCILED') AND NOT t."isFunding"
            AND (t."occurredAt" AT TIME ZONE h.timezone)::date >= ${start}::date AND (t."occurredAt" AT TIME ZONE h.timezone)::date < ${end}::date
            AND (${b.categoryId}::uuid IS NULL OR t."categoryId" IN (SELECT id FROM cats))
            AND (${b.ownerId}::uuid IS NULL OR t."spentById" = ${b.ownerId}::uuid))::text AS bank,
        (SELECT COALESCE(sum(p.amount), 0) FROM petty_cash_logs p, h
          WHERE p.type = 'EXPENSE' AND p.status = 'APPROVED' AND ${b.ownerId}::uuid IS NULL
            AND (p."occurredAt" AT TIME ZONE h.timezone)::date >= ${start}::date AND (p."occurredAt" AT TIME ZONE h.timezone)::date < ${end}::date
            AND (${b.categoryId}::uuid IS NULL OR p."categoryId" IN (SELECT id FROM cats)))::text AS petty`;
    const spent = Number(r?.bank ?? 0) + Number(r?.petty ?? 0);
    const amount = Number(b.amount);
    const pct = amount > 0 ? Math.round((spent / amount) * 1000) / 10 : 0;
    const active = !b.endsOn || b.endsOn >= today;
    return { id: b.id, name: resolveI18n(b.nameI18n as I18nText, { locale: ctx.locale }).text, categoryId: b.categoryId, ownerId: b.ownerId, period: b.period,
      amount: fmt(b.amount), currency: b.currency, alertAtPct: b.alertAtPct, startsOn: isoDate(b.startsOn), endsOn: isoDate(b.endsOn), active,
      currentPeriod: { start: isoDate(start), end: isoDate(new Date(end.getTime() - 86_400_000)) },
      spent: spent.toFixed(2), fromBank: Number(r?.bank ?? 0).toFixed(2), fromPettyCash: Number(r?.petty ?? 0).toFixed(2),
      remaining: (amount - spent).toFixed(2), percentUsed: pct, alert: active && pct >= b.alertAtPct, overBudget: spent > amount };
  }

  private async find(tx: Tx, id: string) {
    const b = await tx.budget.findFirst({ where: { id } });
    if (!b) throw new NotFoundException('budget not found');
    return b;
  }
}
