import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { locales, resolveI18n, type I18nText, type Locale } from '@herp/i18n';
import type { Prisma, WorkOrder, WorkOrderInstruction } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const STAFF_TYPES = ['HOUSEMAID', 'COOK', 'NANNY', 'DRIVER', 'GARDENER', 'SECURITY', 'NURSE', 'TUTOR', 'OTHER'] as const;
const CATEGORIES = ['CLEANING', 'COOKING', 'CHILDCARE', 'DRIVING', 'ERRAND', 'GARDENING', 'MAINTENANCE', 'EVENT_PREP', 'OTHER'] as const;
const dt = z.string().datetime({ offset: true });
const Instruction = z.object({
  text: z.string().trim().min(1).max(1000),
  /** Translations the creator provides themselves count as human-reviewed. */
  translations: z.partialRecord(z.enum(locales), z.string().trim().min(1).max(1000)).optional(),
  isSafetyCritical: z.boolean().default(false), requiresPhoto: z.boolean().default(false),
}).strict();
const CreateWO = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), category: z.enum(CATEGORIES).default('OTHER'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  assigneeId: z.guid().optional(), assigneeStaffType: z.enum(STAFF_TYPES).optional(), vendorName: z.string().max(120).optional(),
  propertyId: z.guid().optional(), unitId: z.guid().optional(), vehicleId: z.guid().optional(), tripId: z.guid().optional(),
  scheduledAt: dt.optional(), dueAt: dt.optional(), requiresPhotoProof: z.boolean().default(false),
  estimatedCost: z.number().min(0).max(10_000_000).optional(), instructions: z.array(Instruction).max(50).default([]),
}).strict();
const UpdateWO = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), scheduledAt: dt.optional(), dueAt: dt.optional(),
  status: z.enum(['IN_PROGRESS', 'ON_HOLD', 'COMPLETED']).optional(), estimatedCost: z.number().min(0).optional(), actualCost: z.number().min(0).optional(),
}).strict();
const Assign = z.object({ assigneeId: z.guid().optional(), assigneeStaffType: z.enum(STAFF_TYPES).optional() }).strict()
  .refine((a) => a.assigneeId || a.assigneeStaffType, 'assigneeId or assigneeStaffType');
const Verify = z.object({ rating: z.number().int().min(1).max(5) }).strict();
const CompleteInstruction = z.object({ completed: z.literal(true), note: z.string().max(500).optional(), photoStorageKey: z.string().max(300).optional() }).strict();
const Translate = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
const ListQuery = z.object({ status: z.string().optional(), assignee: z.string().optional(), category: z.enum(CATEGORIES).optional() });

type WOWithInstr = WorkOrder & { instructions: WorkOrderInstruction[] };
function dto(w: WOWithInstr, locale: Locale) {
  const title = resolveI18n(w.titleI18n as I18nText, { locale, originalLocale: w.originalLocale });
  return {
    id: w.id, number: `WO-${String(w.number).padStart(4, '0')}`, title: title.text, titleTranslated: title.translated,
    description: resolveI18n(w.descriptionI18n as I18nText, { locale, originalLocale: w.originalLocale }).text || null,
    category: w.category, priority: w.priority, status: w.status, requesterId: w.requesterId, assigneeId: w.assigneeId,
    assigneeStaffType: w.assigneeStaffType, vendorName: w.vendorName, propertyId: w.propertyId, vehicleId: w.vehicleId, tripId: w.tripId,
    scheduledAt: w.scheduledAt, dueAt: w.dueAt, startedAt: w.startedAt, completedAt: w.completedAt, verifiedAt: w.verifiedAt, rating: w.rating,
    requiresPhotoProof: w.requiresPhotoProof, estimatedCost: money(w.estimatedCost), actualCost: money(w.actualCost), currency: w.currency,
    instructions: w.instructions.sort((a, b) => a.sequence - b.sequence).map((i) => {
      const t = resolveI18n(i.textI18n as I18nText, { locale, originalLocale: i.originalLocale });
      return { sequence: i.sequence, text: t.text, translated: t.translated, originalText: (i.textI18n as I18nText)[i.originalLocale] ?? null,
               originalLocale: i.originalLocale, translationStatus: i.translationStatus, isSafetyCritical: i.isSafetyCritical,
               requiresPhoto: i.requiresPhoto, completedAt: i.completedAt, completedById: i.completedById, note: i.note };
    }),
  };
}

/**
 * Work orders with multilingual instructions. Each instruction is stored in the
 * creator's language. If the assignee reads another language it is PENDING
 * translation (a translation worker or a human fills textI18n[locale]).
 * A safety-critical instruction blocks dispatch until its translation is
 * HUMAN_REVIEWED (DB trigger), so creating one for a different-language
 * assignee defers the assignment and says why.
 */
@Controller('work-orders')
export class WorkOrdersController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.workOrder.findMany({
        where: { deletedAt: null, status: q.status as never, category: q.category, assigneeId: q.assignee === 'me' ? ctx.membershipId : q.assignee },
        include: { instructions: true }, orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { number: 'desc' }], take: 300,
      })).map((w) => dto(w, ctx.locale)),
    }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateWO)) b: z.infer<typeof CreateWO>) {
    return this.db.withRls(ctx, async (tx) => {
      const targetLocales = await this.assigneeLocales(tx, b.assigneeId, b.assigneeStaffType);
      const instructions = b.instructions.map((i, n) => this.instructionData(ctx, i, n + 1, targetLocales));
      const blocking = instructions.filter((i) => i.isSafetyCritical && i.translationStatus === 'PENDING');
      const defer = blocking.length > 0 && !!(b.assigneeId || b.assigneeStaffType);
      const { title, description, instructions: _i, scheduledAt, dueAt, ...rest } = b;
      const wo = await tx.workOrder.create({ data: {
        ...rest, householdId: ctx.householdId!, requesterId: ctx.membershipId!, originalLocale: ctx.locale,
        titleI18n: { [ctx.locale]: title }, descriptionI18n: description ? { [ctx.locale]: description } : {},
        scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined, dueAt: dueAt ? new Date(dueAt) : undefined,
        ...(defer ? { assigneeId: null, assigneeStaffType: null } : {}),
      } });
      if (instructions.length) await tx.workOrderInstruction.createMany({ data: instructions.map((i) => ({ ...i, householdId: ctx.householdId!, workOrderId: wo.id })) });
      const warnings = defer
        ? [`assignment deferred: instruction(s) ${blocking.map((i) => i.sequence).join(', ')} are safety-critical and need a reviewed translation into ${targetLocales.join(', ')}; ` +
           `POST /work-orders/${wo.id}/instructions/{seq}/translations/{locale}, then POST /work-orders/${wo.id}/assign`]
        : [];
      return { ...dto(await this.load(tx, wo.id), ctx.locale), warnings };
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => dto(await this.load(tx, id), ctx.locale));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(UpdateWO)) b: z.infer<typeof UpdateWO>) {
    return this.db.withRls(ctx, async (tx) => {
      const w = await this.load(tx, id);
      const { title, description, scheduledAt, dueAt, ...rest } = b;
      const { count } = await tx.workOrder.updateMany({ where: { id }, data: {
        ...rest, ...(title ? { titleI18n: { ...(w.titleI18n as object), [ctx.locale]: title } } : {}),
        ...(description ? { descriptionI18n: { ...(w.descriptionI18n as object), [ctx.locale]: description } } : {}),
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}), ...(dueAt ? { dueAt: new Date(dueAt) } : {}) } });
      await assertWritten(count, async () => w, 'work order');
      return dto(await this.load(tx, id), ctx.locale);
    });
  }

  @Post(':id/assign')
  assign(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Assign)) b: z.infer<typeof Assign>) {
    return this.db.withRls(ctx, async (tx) => {
      const w = await this.load(tx, id);
      // Re-evaluate translation needs for the new assignee before dispatching.
      const target = await this.assigneeLocales(tx, b.assigneeId, b.assigneeStaffType);
      for (const i of w.instructions) {
        const missing = target.filter((l) => !(i.textI18n as I18nText)[l]);
        if (missing.length && i.translationStatus === 'ORIGINAL_ONLY') {
          await tx.workOrderInstruction.updateMany({ where: { id: i.id }, data: { translationStatus: 'PENDING' } });
        }
      }
      const { count } = await tx.workOrder.updateMany({ where: { id }, data: {
        assigneeId: b.assigneeId ?? null, assigneeStaffType: b.assigneeStaffType ?? null, status: 'ASSIGNED' } });
      await assertWritten(count, async () => w, 'work order');
      return dto(await this.load(tx, id), ctx.locale);
    });
  }

  @Post(':id/verify')
  verify(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Verify)) b: z.infer<typeof Verify>) {
    return this.setStatus(ctx, id, { status: 'VERIFIED', rating: b.rating });
  }

  @Post(':id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.setStatus(ctx, id, { status: 'CANCELLED' });
  }

  @Post(':id/instructions')
  addInstruction(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Instruction)) b: z.infer<typeof Instruction>) {
    return this.db.withRls(ctx, async (tx) => {
      const w = await this.load(tx, id);
      const target = await this.assigneeLocales(tx, w.assigneeId ?? undefined, w.assigneeStaffType ?? undefined);
      const seq = Math.max(0, ...w.instructions.map((i) => i.sequence)) + 1;
      await tx.workOrderInstruction.create({ data: { ...this.instructionData(ctx, b, seq, target), householdId: ctx.householdId!, workOrderId: id } });
      return dto(await this.load(tx, id), ctx.locale);
    });
  }

  /** Assignee ticks an instruction off (photo when required, enforced in the DB). */
  @Patch(':id/instructions/:seq')
  completeInstruction(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('seq', ParseIntPipe) seq: number,
                      @Body(new ZodBody(CompleteInstruction)) b: z.infer<typeof CompleteInstruction>) {
    return this.db.withRls(ctx, async (tx) => {
      const w = await this.load(tx, id);
      const i = w.instructions.find((x) => x.sequence === seq);
      if (!i) throw new NotFoundException('instruction not found');
      const { count } = await tx.workOrderInstruction.updateMany({ where: { id: i.id }, data: { completedAt: new Date(), note: b.note, photoStorageKey: b.photoStorageKey } });
      await assertWritten(count, async () => i, 'instruction');
      return dto(await this.load(tx, id), ctx.locale);
    });
  }

  /** A person supplies or corrects a translation; it becomes HUMAN_REVIEWED (unblocks safety-critical dispatch). */
  @Post(':id/instructions/:seq/translations/:locale')
  translate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('seq', ParseIntPipe) seq: number,
            @Param('locale') locale: string, @Body(new ZodBody(Translate)) b: z.infer<typeof Translate>) {
    return this.db.withRls(ctx, async (tx) => {
      const l = z.enum(locales).parse(locale);
      const w = await this.load(tx, id);
      const i = w.instructions.find((x) => x.sequence === seq);
      if (!i) throw new NotFoundException('instruction not found');
      const meta = { ...(i.translationMeta as object), [l]: { engine: 'human', reviewedById: ctx.membershipId, at: new Date().toISOString() } };
      const { count } = await tx.workOrderInstruction.updateMany({ where: { id: i.id }, data: {
        textI18n: { ...(i.textI18n as object), [l]: b.text }, translationStatus: 'HUMAN_REVIEWED', translationMeta: meta } });
      await assertWritten(count, async () => i, 'instruction');
      return dto(await this.load(tx, id), ctx.locale);
    });
  }

  private setStatus(ctx: RequestContext, id: string, data: Prisma.WorkOrderUpdateManyMutationInput) {
    return this.db.withRls(ctx, async (tx) => {
      const w = await this.load(tx, id);
      const { count } = await tx.workOrder.updateMany({ where: { id }, data });
      await assertWritten(count, async () => w, 'work order');
      return dto(await this.load(tx, id), ctx.locale);
    });
  }

  private instructionData(ctx: RequestContext, i: z.infer<typeof Instruction>, sequence: number, target: Locale[]) {
    const textI18n: I18nText = { ...(i.translations ?? {}), [ctx.locale]: i.text };
    const missing = target.filter((l) => l !== ctx.locale && !textI18n[l]);
    const provided = target.some((l) => l !== ctx.locale && textI18n[l]);
    const translationStatus = missing.length ? 'PENDING' as const : provided ? 'HUMAN_REVIEWED' as const : 'ORIGINAL_ONLY' as const;
    return { sequence, textI18n, originalLocale: ctx.locale, translationStatus, isSafetyCritical: i.isSafetyCritical, requiresPhoto: i.requiresPhoto,
             translationMeta: provided ? Object.fromEntries(target.filter((l) => textI18n[l] && l !== ctx.locale)
               .map((l) => [l, { engine: 'human', reviewedById: ctx.membershipId, at: new Date().toISOString() }])) : {} };
  }

  /** Languages the assignee (or every worker of the pool's staff type) reads. */
  private async assigneeLocales(tx: Tx, assigneeId?: string, staffType?: string): Promise<Locale[]> {
    if (assigneeId) {
      const m = await tx.membership.findFirst({ where: { id: assigneeId }, select: { user: { select: { preferredLocale: true } } } });
      return m ? [m.user.preferredLocale as Locale] : [];
    }
    if (staffType) {
      const s = await tx.staffProfile.findMany({ where: { staffType: staffType as never, deletedAt: null }, select: { preferredLocale: true } });
      return [...new Set(s.map((x) => x.preferredLocale as Locale))];
    }
    return [];
  }

  private async load(tx: Tx, id: string): Promise<WOWithInstr> {
    const w = await tx.workOrder.findFirst({ where: { id, deletedAt: null }, include: { instructions: true } });
    if (!w) throw new NotFoundException('work order not found');
    return w;
  }
}
