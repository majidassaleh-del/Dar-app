import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { PayrollLine, PayrollRun, Prisma } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { PAYOUT_CHANNELS } from './staff.schemas';

const CreateRun = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) }).strict();
const AddLine = z.object({
  staffId: z.guid(), type: z.enum(['BONUS', 'OVERTIME', 'ALLOWANCE', 'DEDUCTION']),
  amount: z.number().positive().max(1_000_000), description: z.string().trim().min(1).max(200),
}).strict();
const EditLine = z.object({ amount: z.number().max(1_000_000).optional(), description: z.string().trim().min(1).max(200).optional() }).strict();
const Pay = z.object({
  paidAt: z.string().datetime({ offset: true }).optional(),
  payments: z.array(z.object({ staffId: z.guid(), channel: z.enum(PAYOUT_CHANNELS).optional(), externalRef: z.string().trim().min(1).max(80).optional() }).strict()).default([]),
}).strict();
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
  if (input.unpaidLeaveDays > 0) {
    lines.push({ staffId: input.staffId, type: 'DEDUCTION', amount: -round2((input.basic / 30) * input.unpaidLeaveDays),
      descriptionI18n: { en: `Unpaid leave: ${input.unpaidLeaveDays} day(s)`, ar: `إجازة بدون راتب: ${input.unpaidLeaveDays} يوم` } });
  }
  let headroom = lines.reduce((s, l) => s + Number(l.amount), 0);
  for (const adv of input.advances) {
    const take = round2(Math.min(adv.installment, adv.outstanding, Math.max(0, headroom)));
    if (take <= 0) continue;
    headroom -= take;
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

  @Post(':id/pay')
  pay(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Pay)) b: z.infer<typeof Pay>) {
    return this.db.withRls(ctx, async (tx) => {
      const run = await this.find(tx, id);
      if (run.status !== 'APPROVED') throw new UnprocessableEntityException(`only an APPROVED run can be paid (this one is ${run.status})`);
      const lines = await tx.payrollLine.findMany({ where: { payrollRunId: id } });
      const nets = new Map<string, number>();
      for (const l of lines) nets.set(l.staffId, round2((nets.get(l.staffId) ?? 0) + Number(l.amount)));
      const staff = await tx.staffProfile.findMany({ where: { id: { in: [...nets.keys()] } } });
      const override = new Map(b.payments.map((p) => [p.staffId, p]));

      // Validate everything first: no partial payroll.
      const plan = []; const problems: string[] = [];
      for (const s of staff) {
        const net = nets.get(s.id)!;
        if (net <= 0) continue;
        const o = override.get(s.id);
        const channel = o?.channel ?? s.defaultPayoutChannel;
        const name = resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text;
        if (!channel) { problems.push(`${name}: no payout channel`); continue; }
        if ((channel === 'MUSANED' || channel === 'BANK_TRANSFER') && !o?.externalRef) { problems.push(`${name}: ${channel} needs externalRef`); continue; }
        plan.push({ s, net, channel, externalRef: o?.externalRef });
      }
      if (problems.length) throw new BadRequestException(problems);

      for (const p of plan) {
        await tx.salaryPayment.create({ data: {
          householdId: ctx.householdId!, staffId: p.s.id, payrollRunId: id, periodYear: run.periodYear, periodMonth: run.periodMonth,
          amount: p.net, currency: run.currency, channel: p.channel, externalRef: p.externalRef,
          payoutLast4: p.channel === 'BANK_TRANSFER' ? p.s.payoutIbanLast4 : p.channel === 'CASH' ? null : p.s.payoutWalletRef?.slice(-4) ?? null,
          paidAt: b.paidAt ? new Date(b.paidAt) : new Date(), recordedById: ctx.membershipId!, note: `Payroll ${runDto(run).period}`,
        } });
      }
      for (const l of lines.filter((x) => x.type === 'ADVANCE_RECOVERY' && x.advanceId)) {
        await tx.salaryAdvance.updateMany({ where: { id: l.advanceId! }, data: { outstanding: { decrement: Math.abs(Number(l.amount)) } } });
        await tx.salaryAdvance.updateMany({ where: { id: l.advanceId!, outstanding: { lte: 0 }, settledAt: null }, data: { settledAt: new Date() } });
      }
      const { count } = await tx.payrollRun.updateMany({ where: { id }, data: { status: 'PAID' } });
      await assertWritten(count, async () => run, 'payroll run');
      return { ...(await this.detail(tx, ctx, id)), paymentsRecorded: plan.length };
    });
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
