import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { RecurringRule } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { assertWritten } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { iso, money } from './banking.common';

const FREQ = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
const Template = z.object({ type: z.enum(['EXPENSE', 'INCOME', 'TRANSFER']), accountId: z.guid(), amount: money, categoryId: z.guid().optional(),
  cardId: z.guid().optional(), counterAccountId: z.guid().optional(), merchantName: z.string().max(120).optional(), description: z.string().max(300).optional() }).strict()
  .refine((t) => (t.type === 'TRANSFER') === !!t.counterAccountId, { message: 'transfers (and only transfers) need counterAccountId', path: ['counterAccountId'] });
const Create = z.object({ name: z.string().trim().min(1).max(80), template: Template, frequency: z.enum(FREQ), interval: z.number().int().min(1).max(24).default(1),
  dayOfPeriod: z.number().int().min(1).max(31).optional(), firstRunAt: iso, endsAt: iso.optional(), autoPost: z.boolean().default(false) }).strict();
const Update = z.object({ name: z.string().trim().min(1).max(80).optional(), template: Template.optional(), nextRunAt: iso.optional(),
  endsAt: iso.nullable().optional(), autoPost: z.boolean().optional(), isActive: z.boolean().optional() }).strict();

const dto = (r: RecurringRule, locale: RequestContext['locale']) => ({ id: r.id, name: resolveI18n(r.nameI18n as I18nText, { locale }).text, template: r.template,
  frequency: r.frequency, interval: r.interval, dayOfPeriod: r.dayOfPeriod, nextRunAt: r.nextRunAt, endsAt: r.endsAt, autoPost: r.autoPost,
  isActive: r.isActive, lastRunAt: r.lastRunAt, createdById: r.createdById });

/**
 * Recurring bills (rent, SEC electricity, STC internet, school fees…). The
 * worker (node dist/worker.js recurring:run) creates one transaction per due
 * occurrence, idempotently. autoPost=false leaves them PENDING for review.
 */
@Controller('recurring')
export class RecurringController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.recurringRule.findMany({ orderBy: { nextRunAt: 'asc' } })).map((r) => dto(r, ctx.locale)) }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => dto(await tx.recurringRule.create({ data: {
      householdId: ctx.householdId!, nameI18n: { [ctx.locale]: b.name }, template: b.template, frequency: b.frequency, interval: b.interval,
      dayOfPeriod: b.dayOfPeriod, nextRunAt: new Date(b.firstRunAt), endsAt: b.endsAt ? new Date(b.endsAt) : undefined, autoPost: b.autoPost,
      createdById: ctx.membershipId! } }), ctx.locale));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Update)) b: z.infer<typeof Update>) {
    return this.db.withRls(ctx, async (tx) => {
      const r = await this.find(tx, id);
      const { name, nextRunAt, endsAt, ...rest } = b;
      const { count } = await tx.recurringRule.updateMany({ where: { id }, data: { ...rest, ...(name ? { nameI18n: { ...(r.nameI18n as object), [ctx.locale]: name } } : {}),
        ...(nextRunAt ? { nextRunAt: new Date(nextRunAt) } : {}), ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}) } });
      await assertWritten(count, async () => r, 'recurring bill');
      return dto(await this.find(tx, id), ctx.locale);
    });
  }

  @Delete(':id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const r = await this.find(tx, id);
      const { count } = await tx.recurringRule.deleteMany({ where: { id } });
      await assertWritten(count, async () => r, 'recurring bill');
      return { deleted: true };
    });
  }

  private async find(tx: Tx, id: string) {
    const r = await tx.recurringRule.findFirst({ where: { id } });
    if (!r) throw new NotFoundException('recurring bill not found');
    return r;
  }
}
