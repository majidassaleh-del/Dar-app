import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { Acknowledge, Reason, RecordSalaryPayment, SalaryListQuery } from './staff.schemas';
import { contractMonthly, salaryDto } from './staff.dto';
import { assertProof } from './salary-proof';

const StatementQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

/**
 * Domestic-worker salary log: Musaned transfer, direct bank transfer, cash or
 * wallet. Deliberately no WPS / Mudad rules (households are outside WPS): no
 * SIF file, no Saudi-bank IBAN requirement, cash is allowed. What is enforced
 * is the evidence trail:
 *   - MUSANED / BANK_TRANSFER need the transfer reference or a screenshot of it (DB CHECK too);
 *   - rows are immutable; corrections are REVERSED + a new row;
 *   - only the worker can ACKNOWLEDGE or DISPUTE their own pay (DB trigger).
 */
@Controller()
export class SalaryPaymentsController {
  constructor(private readonly db: PrismaService) {}

  @Get('salary-payments')
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(SalaryListQuery)) q: z.infer<typeof SalaryListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.salaryPayment.findMany({
        where: { periodYear: q.year, periodMonth: q.month, staffId: q.staffId, status: q.status },
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { paidAt: 'desc' }],
      })).map(salaryDto),
    }));
  }

  @Post('staff/:staffId/salary-payments')
  record(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(RecordSalaryPayment)) b: z.infer<typeof RecordSalaryPayment>) {
    return this.db.withRls(ctx, async (tx) => {
      const staff = await tx.staffProfile.findFirst({ where: { id: staffId, deletedAt: null } });
      if (!staff) throw new NotFoundException('staff member not found');
      const contract = await tx.employmentContract.findFirst({ where: { staffId, isActive: true }, orderBy: { startDate: 'desc' } });
      const expected = contract ? contractMonthly(contract) : null;
      const amount = b.amount ?? expected;
      if (amount == null) throw new BadRequestException('amount: required when the worker has no active contract');
      const channel = b.channel ?? staff.defaultPayoutChannel;
      if (!channel) throw new BadRequestException('channel: required (the worker has no default payout channel)');
      if ((channel === 'MUSANED' || channel === 'BANK_TRANSFER') && !b.externalRef && !b.proofFileId) {
        throw new BadRequestException(`externalRef: the ${channel === 'MUSANED' ? 'Musaned transfer' : 'bank transfer'} reference is required, or attach a screenshot of the transfer (proofFileId)`);
      }
      await assertProof(tx, b.proofFileId, staffId);
      const payoutLast4 = channel === 'BANK_TRANSFER' ? staff.payoutIbanLast4
        : channel === 'MUSANED' || channel === 'DIGITAL_WALLET' ? staff.payoutWalletRef?.slice(-4) ?? null : null;

      const row = await tx.salaryPayment.create({ data: {
        householdId: ctx.householdId!, staffId, periodYear: b.periodYear, periodMonth: b.periodMonth, amount,
        currency: b.currency ?? contract?.currency ?? 'SAR', channel, externalRef: b.externalRef, payoutLast4,
        paidAt: b.paidAt ?? new Date(), note: b.note, proofFileId: b.proofFileId, recordedById: ctx.membershipId!,
      } });
      const period = await this.periodSummary(tx, staffId, b.periodYear, b.periodMonth, expected);
      const warnings = period.expected != null && Number(period.paid) > period.expected
        ? [`total paid for ${row.periodYear}-${String(row.periodMonth).padStart(2, '0')} (${period.paid}) exceeds the contract amount (${period.expected.toFixed(2)})`] : [];
      return { ...salaryDto(row), period, warnings };
    });
  }

  @Get('staff/:staffId/salary-payments')
  forStaff(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.salaryPayment.findMany({ where: { staffId }, orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { paidAt: 'desc' }] })).map(salaryDto),
    }));
  }

  /**
   * Month-by-month view for a year: due under the contract vs paid vs confirmed by the worker.
   * UNPAID months are the first thing a labour office asks about.
   */
  @Get('staff/:staffId/salary-statement')
  statement(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Query(new ZodQuery(StatementQuery)) q: z.infer<typeof StatementQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      const staff = await tx.staffProfile.findFirst({ where: { id: staffId }, select: { id: true, hireDate: true, terminationDate: true } });
      if (!staff) throw new NotFoundException('staff member not found');
      const [contracts, payments] = await Promise.all([
        tx.employmentContract.findMany({ where: { staffId }, orderBy: { startDate: 'asc' } }),
        tx.salaryPayment.findMany({ where: { staffId, periodYear: q.year, status: { not: 'REVERSED' } } }),
      ]);
      const now = new Date();
      const lastMonth = q.year < now.getUTCFullYear() ? 12 : q.year > now.getUTCFullYear() ? 0 : now.getUTCMonth() + 1;
      const months = [];
      for (let m = 1; m <= lastMonth; m++) {
        const monthStart = new Date(Date.UTC(q.year, m - 1, 1)), monthEnd = new Date(Date.UTC(q.year, m, 0));
        const c = contracts.filter((x) => x.startDate <= monthEnd && (!x.endDate || x.endDate >= monthStart)).at(-1);
        if (!c) continue;
        if (staff.terminationDate && staff.terminationDate < monthStart) continue;
        const ps = payments.filter((p) => p.periodMonth === m);
        const expected = contractMonthly(c);
        const paid = ps.reduce((s, p) => s + Number(p.amount), 0);
        const confirmed = ps.filter((p) => p.status === 'ACKNOWLEDGED').reduce((s, p) => s + Number(p.amount), 0);
        const status = ps.some((p) => p.status === 'DISPUTED') ? 'DISPUTED'
          : paid === 0 ? 'UNPAID' : paid + 0.005 < expected ? 'PARTIAL'
          : confirmed + 0.005 >= expected ? 'PAID_CONFIRMED' : 'PAID_UNCONFIRMED';
        months.push({ month: m, expected: expected.toFixed(2), paid: paid.toFixed(2), confirmedByWorker: confirmed.toFixed(2),
                      outstanding: Math.max(0, expected - paid).toFixed(2), status });
      }
      const outstanding = months.reduce((s, x) => s + Number(x.outstanding), 0);
      return { staffId, year: q.year, months, totals: { outstanding: outstanding.toFixed(2), unpaidMonths: months.filter((x) => x.status === 'UNPAID').length,
                                                         disputedMonths: months.filter((x) => x.status === 'DISPUTED').length } };
    });
  }

  @Post('salary-payments/:id/acknowledge')
  acknowledge(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Acknowledge)) b: z.infer<typeof Acknowledge>) {
    return this.transition(ctx, id, { status: 'ACKNOWLEDGED', ackMethod: b.method ?? 'TAP_TO_ACCEPT' });
  }

  @Post('salary-payments/:id/dispute')
  dispute(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Reason)) b: z.infer<typeof Reason>) {
    return this.transition(ctx, id, { status: 'DISPUTED', disputeReason: b.reason });
  }

  @Post('salary-payments/:id/reverse')
  reverse(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Reason)) b: z.infer<typeof Reason>) {
    return this.transition(ctx, id, { status: 'REVERSED', reversalReason: b.reason });
  }

  /** Status changes go through updateMany so only the granted columns are written; the DB trigger enforces who may do what. */
  private transition(ctx: RequestContext, id: string, data: Record<string, string>) {
    return this.db.withRls(ctx, async (tx) => {
      const before = await tx.salaryPayment.findFirst({ where: { id } });
      if (!before) throw new NotFoundException('salary payment not found');
      if (before.status === data.status) throw new UnprocessableEntityException(`payment is already ${before.status}`);
      const { count } = await tx.salaryPayment.updateMany({ where: { id }, data });
      await assertWritten(count, async () => before, 'salary payment');
      return salaryDto((await tx.salaryPayment.findFirst({ where: { id } }))!);
    });
  }

  private async periodSummary(tx: Tx, staffId: string, year: number, month: number, expected: number | null) {
    const ps = await tx.salaryPayment.findMany({ where: { staffId, periodYear: year, periodMonth: month, status: { not: 'REVERSED' } }, select: { amount: true } });
    const paid = ps.reduce((s, p) => s + Number(p.amount), 0);
    return { expected, paid: paid.toFixed(2), outstanding: expected == null ? null : Math.max(0, expected - paid).toFixed(2) };
  }
}
