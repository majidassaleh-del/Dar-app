import { BadRequestException, Body, Controller, ForbiddenException, UnprocessableEntityException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { Request as RequestRow, Approval } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const common = { title: z.string().trim().min(1).max(200).optional(), reason: z.string().max(1000).optional(),
                 priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), draft: z.boolean().optional() };
export const CreateRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LEAVE'), leaveType: z.enum(['ANNUAL', 'SICK', 'EMERGENCY', 'UNPAID', 'HAJJ_UMRAH', 'VACATION_TRAVEL']),
             startDate: ymd, endDate: ymd, needsExitReentry: z.boolean().default(false),
             /** Managers may file on a worker's behalf. */ staffId: z.guid().optional(),
             /** SICK leave over one day: a SICK_LEAVE_CERTIFICATE file of the worker (DB-enforced). */ certificateAttachmentId: z.guid().optional(), ...common }).strict()
    .refine((r) => r.endDate >= r.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] }),
  z.object({ type: z.literal('SALARY_ADVANCE'), amount: z.number().positive().max(100_000), currency: z.string().regex(/^[A-Z]{3}$/).default('SAR'),
             installments: z.number().int().min(1).max(12).default(1), ...common }).strict(),
  z.object({ type: z.enum(['PURCHASE', 'REIMBURSEMENT', 'ALLOWANCE_TOPUP', 'VEHICLE_USAGE', 'MAINTENANCE', 'GENERAL']),
             amount: z.number().positive().max(10_000_000).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
             payload: z.record(z.string(), z.unknown()).default({}), ...common }).strict(),
]);
const ListQuery = z.object({
  mine: z.enum(['true', 'false']).optional(), awaitingMe: z.enum(['true', 'false']).optional(),
  status: z.enum(['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'FULFILLED']).optional(),
  type: z.string().optional(),
});
const Decide = z.object({ comment: z.string().trim().max(1000).optional() }).strict();

export function requestDto(r: RequestRow & { approvals?: Approval[] }, locale: RequestContext['locale']) {
  const title = resolveI18n(r.titleI18n as I18nText, { locale, originalLocale: r.originalLocale });
  return {
    id: r.id, type: r.type, status: r.status, priority: r.priority, requesterId: r.requesterId,
    title: title.text, titleTranslated: title.translated, payload: r.payload, amount: money(r.amount), currency: r.currency,
    currentStep: r.currentStep, resolvedAt: r.resolvedAt, createdAt: r.createdAt,
    approvals: r.approvals?.map((a) => ({ id: a.id, step: a.step, approverId: a.approverId, decision: a.decision, comment: a.comment, decidedAt: a.decidedAt })),
  };
}

/**
 * Generic request + approval workflow. Routing (who approves, in which steps),
 * advancing steps, final approval and fulfilment (LEAVE → leave record,
 * SALARY_ADVANCE → advance with instalments) all happen in the database.
 */
@Controller('requests')
export class RequestsController {
  constructor(private readonly db: PrismaService) {}

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateRequest)) b: z.infer<typeof CreateRequest>) {
    return this.db.withRls(ctx, async (tx) => {
      let payload: Record<string, unknown> = {};
      let amount: number | undefined; let currency: string | undefined;
      const titleDefault: Record<string, string> = { LEAVE: 'Leave request', SALARY_ADVANCE: 'Salary advance' };
      if (b.type === 'LEAVE') {
        if (b.staffId) await this.assertCanFileFor(tx, ctx, b.staffId);
        else if (!(await tx.staffProfile.findFirst({ where: { membershipId: ctx.membershipId }, select: { id: true } }))) {
          throw new BadRequestException('staffId: required when the requester is not a staff member');
        }
        payload = { leaveType: b.leaveType, startDate: b.startDate, endDate: b.endDate, needsExitReentry: b.needsExitReentry,
                    ...(b.staffId ? { staffId: b.staffId } : {}), ...(b.reason ? { reason: b.reason } : {}),
                    ...(b.certificateAttachmentId ? { certificateAttachmentId: b.certificateAttachmentId } : {}) };
      } else if (b.type === 'SALARY_ADVANCE') {
        payload = { installments: b.installments, ...(b.reason ? { reason: b.reason } : {}) };
        amount = b.amount; currency = b.currency;
      } else {
        payload = { ...b.payload, ...(b.reason ? { reason: b.reason } : {}) };
        amount = b.amount; currency = b.currency;
      }
      const r = await tx.request.create({ data: {
        householdId: ctx.householdId!, requesterId: ctx.membershipId!, type: b.type, status: b.draft ? 'DRAFT' : 'SUBMITTED',
        priority: b.priority ?? 'NORMAL', titleI18n: { [ctx.locale]: b.title ?? titleDefault[b.type] ?? b.type }, originalLocale: ctx.locale,
        payload: payload as never, amount, currency,
      } });
      return requestDto(await this.load(tx, r.id), ctx.locale);
    });
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      const rows = await tx.request.findMany({
        where: {
          status: q.status, type: q.type as never,
          ...(q.mine === 'true' ? { requesterId: ctx.membershipId } : {}),
          ...(q.awaitingMe === 'true' ? { status: 'IN_REVIEW', approvals: { some: { approverId: ctx.membershipId, decision: 'PENDING' } } } : {}),
        },
        include: { approvals: { orderBy: { step: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 200,
      });
      // awaitingMe: only requests whose CURRENT step is mine
      const data = q.awaitingMe === 'true'
        ? rows.filter((r) => r.approvals.some((a) => a.approverId === ctx.membershipId && a.decision === 'PENDING' && a.step === r.currentStep))
        : rows;
      return { data: data.map((r) => requestDto(r, ctx.locale)) };
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => requestDto(await this.load(tx, id), ctx.locale));
  }

  @Post(':id/approve')
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Decide)) b: z.infer<typeof Decide>) {
    return this.decide(ctx, id, 'APPROVED', b.comment);
  }

  @Post(':id/reject')
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Decide)) b: z.infer<typeof Decide>) {
    return this.decide(ctx, id, 'REJECTED', b.comment);
  }

  @Post(':id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const r = await this.load(tx, id);
      const { count } = await tx.request.updateMany({ where: { id }, data: { status: 'CANCELLED' } });
      await assertWritten(count, async () => r, 'request');
      return requestDto(await this.load(tx, id), ctx.locale);
    });
  }

  private decide(ctx: RequestContext, id: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
    return this.db.withRls(ctx, async (tx) => {
      const r = await this.load(tx, id);
      if (r.status !== 'IN_REVIEW' && r.approvals.some((a) => a.approverId === ctx.membershipId)) {
        throw new UnprocessableEntityException(`request is already ${r.status}; nothing to decide`);
      }
      const mine = r.approvals.find((a) => a.approverId === ctx.membershipId && a.decision === 'PENDING' && a.step === r.currentStep);
      if (!mine) {
        if (r.approvals.some((a) => a.approverId === ctx.membershipId)) {
          throw new ForbiddenException(`nothing for you to decide: request is ${r.status}${r.status === 'IN_REVIEW' ? ` at step ${r.currentStep}` : ''}`);
        }
        throw new ForbiddenException('you are not an approver of this request');
      }
      await tx.approval.updateMany({ where: { id: mine.id }, data: { decision, comment } });
      return requestDto(await this.load(tx, id), ctx.locale);
    });
  }

  private async load(tx: Tx, id: string) {
    const r = await tx.request.findFirst({ where: { id }, include: { approvals: { orderBy: [{ step: 'asc' }, { id: 'asc' }] } } });
    if (!r) throw new NotFoundException('request not found');
    return r;
  }

  /** Filing leave for another worker needs payroll management rights. */
  private async assertCanFileFor(tx: Tx, ctx: RequestContext, staffId: string) {
    const staff = await tx.staffProfile.findFirst({ where: { id: staffId }, select: { membershipId: true } });
    if (!staff) throw new NotFoundException('staff member not found');
    if (staff.membershipId === ctx.membershipId) return;
    const [p] = await tx.$queryRaw<Array<{ s: string | null }>>`SELECT app.perm_scope('staff.payroll.manage') AS s`;
    if (p?.s !== 'ALL') throw new ForbiddenException('only payroll managers can request leave for another worker');
  }
}
