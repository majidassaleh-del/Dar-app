import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Card } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { assertWritten, money as fmt } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const limit = z.number().positive().max(10_000_000).nullable().optional();
const Create = z.object({
  accountId: z.guid(), holderId: z.guid().optional(), type: z.enum(['DEBIT', 'CREDIT', 'PREPAID', 'VIRTUAL']),
  last4: z.string().regex(/^\d{4}$/), network: z.string().max(20).optional(), nickname: z.string().max(40).optional(),
  expiryMonth: z.number().int().min(1).max(12), expiryYear: z.number().int().min(2024).max(2100),
  dailyLimit: limit, monthlyLimit: limit, perTxnLimit: limit, allowedCategoryIds: z.array(z.guid()).max(50).optional(),
}).strict();
const Update = z.object({ nickname: z.string().max(40).optional(), dailyLimit: limit, monthlyLimit: limit, perTxnLimit: limit,
  allowedCategoryIds: z.array(z.guid()).max(50).optional(), holderId: z.guid().optional() }).strict();

const dto = (c: Card) => ({ id: c.id, accountId: c.accountId, holderId: c.holderId, type: c.type, status: c.status, nickname: c.nickname,
  last4: c.last4, network: c.network, expiry: `${String(c.expiryMonth).padStart(2, '0')}/${c.expiryYear}`,
  limits: { perTxn: fmt(c.perTxnLimit), daily: fmt(c.dailyLimit), monthly: fmt(c.monthlyLimit) }, allowedCategoryIds: c.allowedCategoryIds });

/**
 * Cards held by family members and staff. Only last-4 is stored (PAN/CVV never
 * touch the platform). Status, expiry, allowed categories and limits are
 * enforced by the database on every transaction, whoever records it.
 */
@Controller('cards')
export class CardsController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.card.findMany({ orderBy: { createdAt: 'asc' } })).map(dto) }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => dto(await tx.card.create({ data: { ...b, householdId: ctx.householdId!, allowedCategoryIds: b.allowedCategoryIds ?? [] } })));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Update)) b: z.infer<typeof Update>) {
    return this.write(ctx, id, b);
  }

  /** The holder may freeze their own card (lost / stolen); only managers unfreeze. */
  @Post(':id/freeze')   freeze(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.write(ctx, id, { status: 'FROZEN' }); }
  @Post(':id/unfreeze') unfreeze(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.write(ctx, id, { status: 'ACTIVE' }); }

  /** Spent today / this month (household-local) vs the limits. */
  @Get(':id/spending')
  spending(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const c = await this.find(tx, id);
      const [r] = await tx.$queryRaw<Array<{ day: string; month: string }>>`
        SELECT COALESCE(sum(t.amount) FILTER (WHERE (t."occurredAt" AT TIME ZONE h.timezone)::date = (now() AT TIME ZONE h.timezone)::date), 0)::text AS day,
               COALESCE(sum(t.amount) FILTER (WHERE date_trunc('month', t."occurredAt" AT TIME ZONE h.timezone) = date_trunc('month', now() AT TIME ZONE h.timezone)), 0)::text AS month
        FROM transactions t JOIN households h ON h.id = t."householdId"
        WHERE t."cardId" = ${id}::uuid AND t.type IN ('EXPENSE', 'ALLOWANCE') AND t.status <> 'REVERSED'`;
      const left = (lim: unknown, used: number) => (lim == null ? null : Math.max(0, Number(lim) - used).toFixed(2));
      const day = Number(r?.day ?? 0), month = Number(r?.month ?? 0);
      return { cardId: id, status: c.status, today: day.toFixed(2), thisMonth: month.toFixed(2), limits: dto(c).limits,
               remaining: { daily: left(c.dailyLimit, day), monthly: left(c.monthlyLimit, month) } };
    });
  }

  private write(ctx: RequestContext, id: string, data: Record<string, unknown>) {
    return this.db.withRls(ctx, async (tx) => {
      const c = await this.find(tx, id);
      const { count } = await tx.card.updateMany({ where: { id }, data: { ...data, updatedAt: new Date() } });
      await assertWritten(count, async () => c, 'card');
      return dto(await this.find(tx, id));
    });
  }

  private async find(tx: Tx, id: string) {
    const c = await tx.card.findFirst({ where: { id } });
    if (!c) throw new NotFoundException('card not found');
    return c;
  }
}
