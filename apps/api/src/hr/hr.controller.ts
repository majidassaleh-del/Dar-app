import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { seal, unseal } from '@herp/crypto';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { AssetHandover, MedicalCheckup, StaffEvaluation, StaffTraining } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { CryptoService } from '../crypto/crypto.module';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { assertWritten, isoDate } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { todayIn } from '../staff/staff.dto';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const BLOOD = ['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN'] as const;
const Health = z.object({ bloodType: z.enum(BLOOD).optional(), conditions: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  allergies: z.array(z.string().trim().min(1).max(120)).max(30).optional() }).strict();
const Checkup = z.object({ checkupDate: ymd, validUntil: ymd.optional(), result: z.enum(['PENDING_RESULTS', 'FIT', 'FIT_WITH_RESTRICTIONS', 'UNFIT']),
  clinicName: z.string().max(120).optional(), restrictions: z.string().max(2000).optional(), reportAttachmentId: z.guid().optional() }).strict();
const CheckupUpdate = z.object({ result: z.enum(['PENDING_RESULTS', 'FIT', 'FIT_WITH_RESTRICTIONS', 'UNFIT']).optional(), restrictions: z.string().max(2000).optional(),
  reportAttachmentId: z.guid().optional() }).strict();
const ITEMS = ['VEHICLE_KEY', 'HOUSE_KEY', 'PHONE', 'PAYMENT_CARD', 'UNIFORM', 'EQUIPMENT', 'OTHER'] as const;
const Issue = z.object({ itemType: z.enum(ITEMS), description: z.string().trim().min(1).max(200), serialOrTag: z.string().max(80).optional(),
  quantity: z.number().int().min(1).max(1000).default(1), vehicleId: z.guid().optional(), cardId: z.guid().optional(), conditionOut: z.string().max(200).optional(),
  expectedReturnAt: z.string().datetime({ offset: true }).optional() }).strict();
const Ack = z.object({ method: z.enum(['TAP_TO_ACCEPT', 'TYPED_NAME', 'DRAWN_SIGNATURE', 'OTP_CONFIRMED']).optional() }).strict();
const Return = z.object({ conditionIn: z.string().max(200).optional() }).strict();
const Lost = z.object({ note: z.string().trim().min(3).max(500) }).strict();
const score = z.number().int().min(1).max(5);
const Evaluation = z.object({ periodStart: ymd, periodEnd: ymd, comments: z.string().max(2000).optional(),
  scores: z.object({ punctuality: score, quality: score, conduct: score, safety: score, communication: score }).strict() }).strict();
const EvalAck = z.object({ comment: z.string().max(1000).optional() }).strict();
const TRAIN = ['FIRST_AID', 'FIRE_SAFETY', 'CHILD_SAFETY', 'FOOD_HYGIENE', 'DEFENSIVE_DRIVING', 'HOUSEHOLD_POLICY', 'EQUIPMENT_SAFETY', 'OTHER'] as const;
const Training = z.object({ category: z.enum(TRAIN), title: z.string().trim().min(1).max(160), provider: z.string().max(120).optional(), completedAt: ymd,
  validUntil: ymd.optional(), hours: z.number().min(0).max(1000).optional(), certificateAttachmentId: z.guid().optional() }).strict();

const checkupDto = (c: MedicalCheckup, restrictions?: string | null) => ({ id: c.id, staffId: c.staffId, checkupDate: isoDate(c.checkupDate), validUntil: isoDate(c.validUntil),
  result: c.result, clinicName: c.clinicName, reportAttachmentId: c.reportAttachmentId, ...(restrictions !== undefined ? { restrictions } : {}) });
const handoverDto = (h: AssetHandover, locale: RequestContext['locale']) => ({ id: h.id, staffId: h.staffId, itemType: h.itemType,
  description: resolveI18n(h.descriptionI18n as I18nText, { locale }).text, serialOrTag: h.serialOrTag, quantity: h.quantity, vehicleId: h.vehicleId, cardId: h.cardId,
  conditionOut: h.conditionOut, issuedAt: h.issuedAt, expectedReturnAt: h.expectedReturnAt, status: h.status, ackAt: h.ackAt, ackMethod: h.ackMethod,
  ackContentHash: h.ackContentHash, returnedAt: h.returnedAt, conditionIn: h.conditionIn, lostNote: h.lostNote });
const evalDto = (e: StaffEvaluation, locale: RequestContext['locale']) => ({ id: e.id, staffId: e.staffId, periodStart: isoDate(e.periodStart), periodEnd: isoDate(e.periodEnd),
  scores: e.scores, overall: Number(e.overall), comments: resolveI18n(e.commentsI18n as I18nText, { locale }).text || null, status: e.status,
  sharedAt: e.sharedAt, acknowledgedAt: e.acknowledgedAt, workerComment: e.workerComment });
const trainingDto = (t: StaffTraining, locale: RequestContext['locale']) => ({ id: t.id, staffId: t.staffId, category: t.category,
  title: resolveI18n(t.titleI18n as I18nText, { locale }).text, provider: t.provider, completedAt: isoDate(t.completedAt), validUntil: isoDate(t.validUntil),
  hours: t.hours == null ? null : Number(t.hours), certificateAttachmentId: t.certificateAttachmentId, workerAckAt: t.workerAckAt });

const parseList = (s: string | null) => (s ? (JSON.parse(s) as string[]) : []);

/**
 * Staff HR extension: health record (encrypted), mandatory annual medical
 * checkups (every role), compliance view, asset handover with worker sign-off,
 * evaluations and training logs. Who may see / do what is enforced by RLS and
 * triggers (prisma/rls.sql); this layer validates input, encrypts, and shapes.
 */
@Controller()
export class HrController {
  constructor(private readonly db: PrismaService, private readonly crypto: CryptoService) {}

  // ---- health record -------------------------------------------------------------
  @Get('staff/:staffId/health')
  health(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staff(tx, staffId);
      const h = await tx.staffHealthProfile.findFirst({ where: { staffId } });
      const checkups = await tx.medicalCheckup.findMany({ where: { staffId }, orderBy: { checkupDate: 'desc' } });
      const sick = await tx.leaveRecord.findMany({ where: { staffId, type: 'SICK' }, orderBy: { startDate: 'desc' } });
      if (!h && !checkups.length && !(await this.canReadHealth(tx))) throw new NotFoundException('health record not found'); // no oracle for non-readers
      const row = (h ?? {}) as Record<string, unknown>;
      return {
        staffId, bloodType: h?.bloodType ?? 'UNKNOWN', disclosedAt: h?.disclosedAt ?? null,
        conditions: parseList(h ? await unseal(this.crypto.cipher, 'staff_health_profiles.conditions', ctx.householdId!, row) : null),
        allergies: parseList(h ? await unseal(this.crypto.cipher, 'staff_health_profiles.allergies', ctx.householdId!, row) : null),
        medical: await this.medicalStatus(tx, ctx, checkups),
        checkups: await Promise.all(checkups.map(async (c) => checkupDto(c, await unseal(this.crypto.cipher, 'medical_checkups.restrictions', ctx.householdId!, c as never)))),
        sickLeave: sick.map((l) => ({ id: l.id, requestId: l.requestId, startDate: isoDate(l.startDate), endDate: isoDate(l.endDate), days: Number(l.days) })),
      };
    });
  }

  /** The worker can disclose their own information; Head / EFA can record it. */
  @Put('staff/:staffId/health')
  setHealth(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(Health)) b: z.infer<typeof Health>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staff(tx, staffId);
      const data = { ...(b.bloodType ? { bloodType: b.bloodType } : {}), disclosedById: ctx.membershipId, disclosedAt: new Date(),
        ...(b.conditions ? await seal(this.crypto.cipher, 'staff_health_profiles.conditions', ctx.householdId!, JSON.stringify(b.conditions)) : {}),
        ...(b.allergies ? await seal(this.crypto.cipher, 'staff_health_profiles.allergies', ctx.householdId!, JSON.stringify(b.allergies)) : {}) };
      const existing = await tx.staffHealthProfile.findFirst({ where: { staffId }, select: { id: true } });
      if (existing) {
        const { count } = await tx.staffHealthProfile.updateMany({ where: { id: existing.id }, data });
        await assertWritten(count, async () => existing, 'health record');
      } else {
        await tx.staffHealthProfile.createMany({ data: [{ ...data, householdId: ctx.householdId!, staffId }] });
      }
      return { saved: true };
    });
  }

  @Post('staff/:staffId/medical-checkups')
  addCheckup(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(Checkup)) b: z.infer<typeof Checkup>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staff(tx, staffId);
      const validUntil = b.validUntil ? d(b.validUntil) : new Date(d(b.checkupDate).getTime() + 365 * 86_400_000);
      const c = await tx.medicalCheckup.create({ data: { householdId: ctx.householdId!, staffId, checkupDate: d(b.checkupDate), validUntil, result: b.result,
        clinicName: b.clinicName, reportAttachmentId: b.reportAttachmentId, recordedById: ctx.membershipId!,
        ...(await seal(this.crypto.cipher, 'medical_checkups.restrictions', ctx.householdId!, b.restrictions)) } });
      return checkupDto(c, b.restrictions ?? null);
    });
  }

  @Patch('medical-checkups/:id')
  updateCheckup(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(CheckupUpdate)) b: z.infer<typeof CheckupUpdate>) {
    return this.db.withRls(ctx, async (tx) => {
      const c = await tx.medicalCheckup.findFirst({ where: { id } });
      if (!c) throw new NotFoundException('checkup not found');
      const { count } = await tx.medicalCheckup.updateMany({ where: { id }, data: { result: b.result, reportAttachmentId: b.reportAttachmentId,
        ...(await seal(this.crypto.cipher, 'medical_checkups.restrictions', ctx.householdId!, b.restrictions)) } });
      await assertWritten(count, async () => c, 'medical checkup');
      return checkupDto((await tx.medicalCheckup.findFirst({ where: { id } }))!);
    });
  }

  /** Household-wide compliance: medical status (every role), open handovers, trainings due. Head / EFA (staff.health.read). */
  @Get('compliance/staff') // not /staff/compliance: that would collide with /staff/:id
  compliance(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      if (!(await this.canReadHealth(tx))) throw new ForbiddenException('needs staff.health.read');
      const staff = await tx.staffProfile.findMany({ where: { deletedAt: null, status: { notIn: ['TERMINATED', 'FINAL_EXIT'] } },
        include: { medicalCheckups: true, handovers: { where: { status: { in: ['PENDING_ACK', 'ISSUED'] } } }, trainings: true }, orderBy: { createdAt: 'asc' } });
      const data = await Promise.all(staff.map(async (s) => ({
        staffId: s.id, name: resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text, staffType: s.staffType, status: s.status,
        medical: await this.medicalStatus(tx, ctx, s.medicalCheckups, s.hireDate ?? s.createdAt),
        openHandovers: s.handovers.length, overdueHandovers: s.handovers.filter((h) => h.expectedReturnAt && h.expectedReturnAt < new Date()).length,
        trainingsExpiring: s.trainings.filter((t) => t.validUntil && t.validUntil.getTime() - Date.now() < 30 * 86_400_000).length,
      })));
      return { summary: { workers: data.length, medicalOverdue: data.filter((x) => x.medical.status === 'OVERDUE' || x.medical.status === 'MISSING').length,
                          medicalDueSoon: data.filter((x) => x.medical.status === 'DUE_SOON').length,
                          openHandovers: data.reduce((n, x) => n + x.openHandovers, 0) }, data };
    });
  }

  // ---- asset handover -------------------------------------------------------------
  @Get('staff/:staffId/handovers')
  handovers(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.assetHandover.findMany({ where: { staffId }, orderBy: { issuedAt: 'desc' } })).map((h) => handoverDto(h, ctx.locale)) }));
  }

  @Post('staff/:staffId/handovers')
  issue(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(Issue)) b: z.infer<typeof Issue>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staff(tx, staffId);
      const { description, expectedReturnAt, ...rest } = b;
      return handoverDto(await tx.assetHandover.create({ data: { ...rest, householdId: ctx.householdId!, staffId, issuedById: ctx.membershipId!,
        descriptionI18n: { [ctx.locale]: description }, expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt) : undefined } }), ctx.locale);
    });
  }

  @Post('handovers/:id/acknowledge') acknowledge(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Ack)) b: z.infer<typeof Ack>) {
    return this.handoverUpdate(c, id, { status: 'ISSUED', ackMethod: b.method });
  }
  @Post('handovers/:id/return') giveBack(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Return)) b: z.infer<typeof Return>) {
    return this.handoverUpdate(c, id, { status: 'RETURNED', conditionIn: b.conditionIn });
  }
  @Post('handovers/:id/lost') lost(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Lost)) b: z.infer<typeof Lost>) {
    return this.handoverUpdate(c, id, { status: 'LOST', lostNote: b.note });
  }

  // ---- evaluations ----------------------------------------------------------------
  @Get('staff/:staffId/evaluations')
  evaluations(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.staffEvaluation.findMany({ where: { staffId }, orderBy: { periodEnd: 'desc' } })).map((e) => evalDto(e, ctx.locale)) }));
  }

  @Post('staff/:staffId/evaluations')
  evaluate(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(Evaluation)) b: z.infer<typeof Evaluation>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staff(tx, staffId);
      if (b.periodEnd < b.periodStart) throw new BadRequestException('periodEnd: before periodStart');
      const vals = Object.values(b.scores);
      return evalDto(await tx.staffEvaluation.create({ data: { householdId: ctx.householdId!, staffId, periodStart: d(b.periodStart), periodEnd: d(b.periodEnd),
        evaluatorId: ctx.membershipId!, scores: b.scores, overall: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100,
        commentsI18n: b.comments ? { [ctx.locale]: b.comments } : {} } }), ctx.locale);
    });
  }

  @Post('evaluations/:id/share') share(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.evalUpdate(c, id, { status: 'SHARED' }); }
  @Post('evaluations/:id/acknowledge') ackEval(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(EvalAck)) b: z.infer<typeof EvalAck>) {
    return this.evalUpdate(c, id, { status: 'ACKNOWLEDGED', workerComment: b.comment });
  }

  // ---- training & safety log ------------------------------------------------------
  @Get('staff/:staffId/trainings')
  trainings(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.staffTraining.findMany({ where: { staffId }, orderBy: { completedAt: 'desc' } })).map((t) => trainingDto(t, ctx.locale)) }));
  }

  @Post('staff/:staffId/trainings')
  train(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(Training)) b: z.infer<typeof Training>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staff(tx, staffId);
      if (b.validUntil && b.validUntil <= b.completedAt) throw new BadRequestException('validUntil: must be after completedAt');
      return trainingDto(await tx.staffTraining.create({ data: { householdId: ctx.householdId!, staffId, category: b.category, titleI18n: { [ctx.locale]: b.title },
        provider: b.provider, completedAt: d(b.completedAt), validUntil: b.validUntil ? d(b.validUntil) : undefined, hours: b.hours,
        certificateAttachmentId: b.certificateAttachmentId, recordedById: ctx.membershipId! } }), ctx.locale);
    });
  }

  @Post('trainings/:id/acknowledge')
  ackTraining(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const t = await tx.staffTraining.findFirst({ where: { id } });
      if (!t) throw new NotFoundException('training not found');
      const { count } = await tx.staffTraining.updateMany({ where: { id }, data: { workerAckAt: new Date() } });
      await assertWritten(count, async () => t, 'training');
      return trainingDto((await tx.staffTraining.findFirst({ where: { id } }))!, ctx.locale);
    });
  }

  // ---- helpers ----------------------------------------------------------------------
  private handoverUpdate(ctx: RequestContext, id: string, data: Record<string, unknown>) {
    return this.db.withRls(ctx, async (tx) => {
      const h = await tx.assetHandover.findFirst({ where: { id } });
      if (!h) throw new NotFoundException('handover not found');
      const { count } = await tx.assetHandover.updateMany({ where: { id }, data });
      await assertWritten(count, async () => h, 'handover');
      return handoverDto((await tx.assetHandover.findFirst({ where: { id } }))!, ctx.locale);
    });
  }

  private evalUpdate(ctx: RequestContext, id: string, data: Record<string, unknown>) {
    return this.db.withRls(ctx, async (tx) => {
      const e = await tx.staffEvaluation.findFirst({ where: { id } });
      if (!e) throw new NotFoundException('evaluation not found');
      const { count } = await tx.staffEvaluation.updateMany({ where: { id }, data });
      await assertWritten(count, async () => e, 'evaluation');
      return evalDto((await tx.staffEvaluation.findFirst({ where: { id } }))!, ctx.locale);
    });
  }

  private async medicalStatus(tx: Tx, ctx: RequestContext, checkups: MedicalCheckup[], hiredOn?: Date) {
    const h = await tx.household.findFirst({ where: { id: ctx.householdId }, select: { timezone: true } });
    const today = todayIn(h?.timezone ?? 'Asia/Riyadh');
    const valid = checkups.filter((c) => c.result === 'FIT' || c.result === 'FIT_WITH_RESTRICTIONS').sort((a, b) => b.validUntil.getTime() - a.validUntil.getTime())[0];
    if (!valid) {
      const due = hiredOn ? new Date(Date.UTC(hiredOn.getUTCFullYear(), hiredOn.getUTCMonth(), hiredOn.getUTCDate() + 30)) : today;
      return { status: due < today ? 'OVERDUE' : 'MISSING', validUntil: null, dueDate: isoDate(due), lastResult: checkups[0]?.result ?? null };
    }
    const days = Math.round((valid.validUntil.getTime() - today.getTime()) / 86_400_000);
    return { status: days < 0 ? 'OVERDUE' : days <= 30 ? 'DUE_SOON' : 'VALID', validUntil: isoDate(valid.validUntil), dueDate: isoDate(valid.validUntil), daysLeft: days, lastResult: valid.result };
  }

  private async canReadHealth(tx: Tx) {
    const [r] = await tx.$queryRaw<Array<{ s: string | null }>>`SELECT app.perm_scope('staff.health.read') AS s`;
    return r?.s === 'ALL';
  }

  private async staff(tx: Tx, id: string) {
    if (!(await tx.staffProfile.findFirst({ where: { id, deletedAt: null }, select: { id: true } }))) throw new NotFoundException('staff member not found');
  }
}
