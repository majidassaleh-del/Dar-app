import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { PayrollLine, PayrollRun, Prisma } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { PAYOUT_CHANNELS } from './staff.schemas';
import { monthlyWage, unpaidLeaveDeduction } from '../hr/esb';
import { assertProof, proofProblem } from './salary-proof';

const CreateRun = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) }).strict();
const AddLine = z.object({
  staffId: z.guid(), type: z.enum(['BONUS', 'OVERTIME', 'ALLOWANCE', 'DEDUCTION']),
  amount: z.number().positive().max(1_000_000), description: z.string().trim().min(1).max(200),
}).strict();
const EditLine = z.object({ amount: z.number().max(1_000_000).optional(), description: z.string().trim().min(1).max(200).optional() }).strict();
const PayOne = z.object({ channel: z.enum(PAYOUT_CHANNELS).optional(), externalRef: z.string().trim().min(1).max(80).optional(), proofFileId: z.guid().optional() }).strict();
const Pay = z.object({
  paidAt: z.string().datetime({ offset: true }).optional(),
  payments: z.array(PayOne.extend({ staffId: z.guid() }).strict()).default([]),
}).strict();
const PayWorker = PayOne.extend({ paidAt: z.string().datetime({ offset: true }).optional() }).strict();
const ListQuery = z.object({ year: z.coerce.number().int().optional(), month: z.coerce.number().int().min(1).max(12).optional() });

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
type LineDraft = Omit<Prisma.PayrollLineCreateManyInput, 'householdId' | 'payrollRunId'>;

/** Pure: lines for one worker for one month (exported for unit testing). */
export function buildLines(input: {
  staffId: string; year: number; month: number; basic: number; allowances: Array<{ code: string; amount: number }>;
  employedFrom: Date; employedTo: Date | null; unpaidLeaveDays: number;
  advances: Array<{ id: string; outstanding: number; installment: number }>;
}): LineDraft[] {
  const mStart = Date.UTC(input.year, input.month - 1, 1), mEnd = Date.UTC(input.year, input.month, 0);
  const daysInMonth = (mEnd - mStart) / DAY + 1;
  const from = Math.max(mStart, input.employedFrom.getTime()), to = Math.min(mEnd, input.employedTo?.getTime() ?? mEnd);
  if (to < from) return [];
  const days = (to - from) / DAY + 1;
  const factor = days / daysInMonth;
  const prorated = days < daysInMonth ? ` (${days}/${daysInMonth})` : '';
  const lines: LineDraft[] = [{ staffId: input.staffId, type: 'BASIC_SALARY', amount: round2(input.basic * factor),
    descriptionI18n: { en: `Basic salary${prorated}`, ar: `الراتب الأساسي${prorated}` } }];
  for (const a of input.allowances) {
    if (a.amount > 0) lines.push({ staffId: input.staffId, type: 'ALLOWANCE', amount: round2(a.amount * factor),
      descriptionI18n: { en: `Allowance: ${a.code}${prorated}`, ar: `بدل: ${a.code}${prorated}` } });
  }
  // Unpaid leave: (monthly wage / 30) × unpaid days, wage = basic + fixed allowances, exact to the halala.
  if (input.unpaidLeaveDays > 0) {
    const wage = monthlyWage({ basicSalary: input.basic, allowances: input.allowances });
    const h = unpaidLeaveDeduction(wage, input.unpaidLeaveDays);
    lines.push({ staffId: input.staffId, type: 'UNPAID_LEAVE', amount: -h / 100,
      descriptionI18n: { en: `Unpaid leave: ${input.unpaidLeaveDays} day(s) × ${(wage / 3000).toFixed(2)}`, ar: `إجازة بدون راتب: ${input.unpaidLeaveDays} يوم × ${(wage / 3000).toFixed(2)}` } });
  }
  // Domestic Workers Regulation Art. 9: deductions (advance recovery included) never take more than half the wage earned.
  const earned = lines.reduce((s, l) => s + Number(l.amount), 0);
  let headroom = round2(Math.max(0, earned) * 0.5);
  for (const adv of input.advances) {
    const take = round2(Math.min(adv.installment, adv.outstanding, Math.max(0, headroom)));
    if (take <= 0) continue;
    headroom = round2(headroom - take);
    lines.push({ staffId: input.staffId, type: 'ADVANCE_RECOVERY', amount: -take, advanceId: adv.id,
      descriptionI18n: { en: 'Salary advance recovery', ar: 'استرداد سلفة' } });
  }
  return lines;
}

function overlapDays(aStart: Date, aEnd: Date, bStart: number, bEnd: number) {
  const s = Math.max(aStart.getTime(), bStart), e = Math.min(aEnd.getTime(), bEnd);
  return e < s ? 0 : (e - s) / DAY + 1;
}

type LineWithStaff = PayrollLine & { staff: { fullNameI18n: Prisma.JsonValue } };
export function groupByStaff(lines: LineWithStaff[], locale: RequestContext['locale']) {
  const by = new Map<string, LineWithStaff[]>();
  for (const l of lines) by.set(l.staffId, [...(by.get(l.staffId) ?? []), l]);
  return [...by.entries()].map(([staffId, ls]) => {
    const gross = ls.filter((l) => Number(l.amount) > 0).reduce((s, l) => s + Number(l.amount), 0);
    const deductions = ls.filter((l) => Number(l.amount) < 0).reduce((s, l) => s + Number(l.amount), 0);
    return {
      staffId, name: resolveI18n(ls[0]!.staff.fullNameI18n as I18nText, { locale }).text,
      lines: ls.map((l) => ({ id: l.id, type: l.type, amount: money(l.amount),
        description: resolveI18n(l.descriptionI18n as I18nText, { locale, originalLocale: 'en' }).text })),
      gross: gross.toFixed(2), deductions: deductions.toFixed(2), net: (gross + deductions).toFixed(2),
    };
  });
}

const runDto = (r: PayrollRun) => ({ id: r.id, period: `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}`, periodYear: r.periodYear,
  periodMonth: r.periodMonth, status: r.status, totalAmount: money(r.totalAmount), currency: r.currency, approvedAt: r.approvedAt, paidAt: r.paidAt });

/**
 * Monthly payroll for domestic workers: DRAFT (generated, editable) → APPROVED → PAID.
 * Paying logs one SalaryPayment per worker (Musaned / bank / cash / wallet, no WPS)
 * and reduces salary advances. Line immutability and status transitions are DB-enforced.
 */
@Controller('payroll-runs')
export class PayrollController {
  constructor(private readonly db: PrismaService) {}

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateRun)) b: z.infer<typeof CreateRun>) {
    return this.db.withRls(ctx, async (tx) => {
      const run = await tx.payrollRun.create({ data: { householdId: ctx.householdId!, periodYear: b.year, periodMonth: b.month } });
      const warnings = await this.generate(tx, ctx, run);
      return { ...(await this.detail(tx, ctx, run.id)), warnings };
    });
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.payrollRun.findMany({ where: { periodYear: q.year, periodMonth: q.month }, orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }] })).map(runDto),
    }));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, (tx) => this.detail(tx, ctx, id));
  }

  @Post(':id/lines')
  addLine(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(AddLine)) b: z.infer<typeof AddLine>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.find(tx, id);
      await tx.payrollLine.create({ data: { householdId: ctx.householdId!, payrollRunId: id, staffId: b.staffId, type: b.type,
        amount: b.type === 'DEDUCTION' ? -b.amount : b.amount, descriptionI18n: { [ctx.locale]: b.description } } });
      return this.detail(tx, ctx, id);
    });
  }

  @Patch(':id/lines/:lineId')
  editLine(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string,
           @Body(new ZodBody(EditLine)) b: z.infer<typeof EditLine>) {
    return this.db.withRls(ctx, async (tx) => {
      const line = await tx.payrollLine.findFirst({ where: { id: lineId, payrollRunId: id } });
      if (!line) throw new NotFoundException('payroll line not found');
      const { count } = await tx.payrollLine.updateMany({ where: { id: lineId }, data: {
        amount: b.amount, ...(b.description ? { descriptionI18n: { ...(line.descriptionI18n as object), [ctx.locale]: b.description } } : {}) } });
      await assertWritten(count, async () => line, 'payroll line');
      return this.detail(tx, ctx, id);
    });
  }

  @Delete(':id/lines/:lineId')
  deleteLine(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.db.withRls(ctx, async (tx) => {
      const line = await tx.payrollLine.findFirst({ where: { id: lineId, payrollRunId: id } });
      if (!line) throw new NotFoundException('payroll line not found');
      const { count } = await tx.payrollLine.deleteMany({ where: { id: lineId } });
      await assertWritten(count, async () => line, 'payroll line');
      return this.detail(tx, ctx, id);
    });
  }

  @Post(':id/approve') approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.setStatus(ctx, id, 'APPROVED'); }
  @Post(':id/reopen')  reopen(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.setStatus(ctx, id, 'DRAFT'); }
  @Post(':id/cancel')  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.setStatus(ctx, id, 'CANCELLED'); }

  /** Pay the whole (APPROVED) run at once. Workers already paid one by one are skipped. Validates everyone first: no partial write. */
  @Post(':id/pay')
  pay(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Pay)) b: z.infer<typeof Pay>) {
    return this.db.withRls(ctx, async (tx) => {
      const run = await this.find(tx, id);
      if (run.status !== 'APPROVED') throw new UnprocessableEntityException(`only an APPROVED run can be paid (this one is ${run.status})`);
      const { nets, paid } = await this.runState(tx, id);
      const staff = await tx.staffProfile.findMany({ where: { id: { in: [...nets.keys()] } } });
      const override = new Map(b.payments.map((p) => [p.staffId, p]));
      const plan = []; const problems: string[] = [];
      for (const s of staff) {
        const net = nets.get(s.id)!;
        if (net <= 0 || paid.has(s.id)) continue;
        const o = override.get(s.id);
        const channel = o?.channel ?? s.defaultPayoutChannel;
        const name = resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text;
        if (!channel) { problems.push(`${name}: no payout channel`); continue; }
        const problem = proofProblem(channel, o?.externalRef, o?.proofFileId);
        if (problem) { problems.push(`${name}: ${problem}`); continue; }
        await assertProof(tx, o?.proofFileId, s.id);
        plan.push({ s, net, channel, externalRef: o?.externalRef, proofFileId: o?.proofFileId });
      }
      if (problems.length) throw new BadRequestException(problems);
      for (const p of plan) await this.recordPayment(tx, ctx, run, p, b.paidAt);
      await this.closeIfDone(tx, run);
      return { ...(await this.detail(tx, ctx, id)), paymentsRecorded: plan.length };
    });
  }

  /**
   * Pay one worker of an APPROVED run (transfers are usually made one by one): their net from the
   * run's lines, with the transfer reference or a screenshot. The run becomes PAID with the last worker.
   */
  @Post(':id/pay/:staffId')
  payWorker(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('staffId', ParseUUIDPipe) staffId: string,
            @Body(new ZodBody(PayWorker)) b: z.infer<typeof PayWorker>) {
    return this.db.withRls(ctx, async (tx) => {
      const run = await this.find(tx, id);
      if (run.status !== 'APPROVED') throw new UnprocessableEntityException(`only an APPROVED run can be paid (this one is ${run.status})`);
      const { nets, paid } = await this.runState(tx, id);
      const net = nets.get(staffId);
      if (net == null) throw new NotFoundException('this worker is not in the run');
      if (net <= 0) throw new UnprocessableEntityException('nothing to pay this worker for this month');
      if (paid.has(staffId)) throw new ConflictException('this worker is already paid for this run');
      const s = await tx.staffProfile.findFirst({ where: { id: staffId } });
      if (!s) throw new NotFoundException('staff member not found');
      const channel = b.channel ?? s.defaultPayoutChannel;
      if (!channel) throw new BadRequestException('channel: required (the worker has no default payout channel)');
      const problem = proofProblem(channel, b.externalRef, b.proofFileId);
      if (problem) throw new BadRequestException(problem);
      await assertProof(tx, b.proofFileId, staffId);
      await this.recordPayment(tx, ctx, run, { s, net, channel, externalRef: b.externalRef, proofFileId: b.proofFileId }, b.paidAt);
      await this.closeIfDone(tx, run);
      return this.detail(tx, ctx, id);
    });
  }

  private async runState(tx: Tx, id: string) {
    const lines = await tx.payrollLine.findMany({ where: { payrollRunId: id } });
    const nets = new Map<string, number>();
    for (const l of lines) nets.set(l.staffId, round2((nets.get(l.staffId) ?? 0) + Number(l.amount)));
    const payments = await tx.salaryPayment.findMany({ where: { payrollRunId: id, status: { not: 'REVERSED' } }, select: { staffId: true } });
    return { lines, nets, paid: new Set(payments.map((p) => p.staffId)) };
  }

  private async recordPayment(tx: Tx, ctx: RequestContext, run: PayrollRun,
    p: { s: { id: string; payoutIbanLast4: string | null; payoutWalletRef: string | null }; net: number; channel: string; externalRef?: string; proofFileId?: string }, paidAt?: string) {
    await tx.salaryPayment.create({ data: {
      householdId: ctx.householdId!, staffId: p.s.id, payrollRunId: run.id, periodYear: run.periodYear, periodMonth: run.periodMonth,
      amount: p.net, currency: run.currency, channel: p.channel as never, externalRef: p.externalRef, proofFileId: p.proofFileId,
      payoutLast4: p.channel === 'BANK_TRANSFER' ? p.s.payoutIbanLast4 : p.channel === 'CASH' ? null : p.s.payoutWalletRef?.slice(-4) ?? null,
      paidAt: paidAt ? new Date(paidAt) : new Date(), recordedById: ctx.membershipId!, note: `Payroll ${runDto(run).period}`,
    } });
    // Advance instalments on this worker's lines are recovered with this payment.
    const recov = await tx.payrollLine.findMany({ where: { payrollRunId: run.id, staffId: p.s.id, type: 'ADVANCE_RECOVERY', advanceId: { not: null } } });
    for (const l of recov) {
      await tx.salaryAdvance.updateMany({ where: { id: l.advanceId! }, data: { outstanding: { decrement: Math.abs(Number(l.amount)) } } });
      await tx.salaryAdvance.updateMany({ where: { id: l.advanceId!, outstanding: { lte: 0 }, settledAt: null }, data: { settledAt: new Date() } });
    }
  }

  /** The run is PAID once every worker with something to pay has a (non-reversed) payment. */
  private async closeIfDone(tx: Tx, run: PayrollRun) {
    const { nets, paid } = await this.runState(tx, run.id);
    if ([...nets.entries()].some(([staffId, net]) => net > 0 && !paid.has(staffId))) return;
    const { count } = await tx.payrollRun.updateMany({ where: { id: run.id }, data: { status: 'PAID' } });
    await assertWritten(count, async () => run, 'payroll run');
  }

  private setStatus(ctx: RequestContext, id: string, status: 'APPROVED' | 'DRAFT' | 'CANCELLED') {
    return this.db.withRls(ctx, async (tx) => {
      const run = await this.find(tx, id);
      const { count } = await tx.payrollRun.updateMany({ where: { id }, data: { status } });
      await assertWritten(count, async () => run, 'payroll run');
      return this.detail(tx, ctx, id);
    });
  }

  private async generate(tx: Tx, ctx: RequestContext, run: PayrollRun): Promise<string[]> {
    const mStart = Date.UTC(run.periodYear, run.periodMonth - 1, 1), mEnd = Date.UTC(run.periodYear, run.periodMonth, 0);
    const staff = await tx.staffProfile.findMany({ where: { deletedAt: null, status: { notIn: ['RECRUITING'] } },
      include: { contracts: { orderBy: { startDate: 'desc' } } } });
    const warnings: string[] = []; const all: LineDraft[] = [];
    for (const s of staff) {
      const name = resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text;
      if (s.terminationDate && s.terminationDate.getTime() < mStart) continue;
      const c = s.contracts.find((x) => x.startDate.getTime() <= mEnd && (!x.endDate || x.endDate.getTime() >= mStart));
      if (!c) { if (s.status === 'ACTIVE' || s.status === 'ON_PROBATION') warnings.push(`${name}: no contract covering this month — skipped`); continue; }
      if (s.status === 'ABSCONDED') { warnings.push(`${name}: ABSCONDED — excluded; settle manually`); continue; }
      const leaves = await tx.leaveRecord.findMany({ where: { staffId: s.id, paid: false, startDate: { lte: new Date(mEnd) }, endDate: { gte: new Date(mStart) } } });
      const advances = await tx.salaryAdvance.findMany({ where: { staffId: s.id, settledAt: null, outstanding: { gt: 0 }, issuedAt: { lte: new Date(mEnd) } }, orderBy: { issuedAt: 'asc' } });
      const employedFrom = new Date(Math.max(c.startDate.getTime(), s.hireDate?.getTime() ?? 0));
      const ends = [c.endDate, s.terminationDate].filter(Boolean).map((d) => d!.getTime());
      all.push(...buildLines({
        staffId: s.id, year: run.periodYear, month: run.periodMonth, basic: Number(c.basicSalary),
        allowances: Array.isArray(c.allowances) ? (c.allowances as Array<{ code: string; amount: number }>) : [],
        employedFrom, employedTo: ends.length ? new Date(Math.min(...ends)) : null,
        unpaidLeaveDays: leaves.reduce((n, l) => n + overlapDays(l.startDate, l.endDate, mStart, mEnd), 0),
        advances: advances.map((a) => ({ id: a.id, outstanding: Number(a.outstanding), installment: Number(a.monthlyInstallment) })),
      }));
    }
    if (all.length) await tx.payrollLine.createMany({ data: all.map((l) => ({ ...l, householdId: ctx.householdId!, payrollRunId: run.id })) });
    return warnings;
  }

  private async find(tx: Tx, id: string) {
    const r = await tx.payrollRun.findFirst({ where: { id } });
    if (!r) throw new NotFoundException('payroll run not found');
    return r;
  }

  private async detail(tx: Tx, ctx: RequestContext, id: string) {
    const run = await this.find(tx, id);
    const lines = await tx.payrollLine.findMany({ where: { payrollRunId: id }, include: { staff: { select: { fullNameI18n: true } } }, orderBy: [{ staffId: 'asc' }, { type: 'asc' }] });
    return { ...runDto(run), staff: groupByStaff(lines, ctx.locale) };
  }
}
