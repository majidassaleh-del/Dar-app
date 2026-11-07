import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodQuery } from '../common/zod.pipe';
import { money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { esbFor, leaveFor } from './esb';

const AsOf = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const todayRiyadh = () => new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date())}T00:00:00Z`);

/**
 * Saudi domestic-labour views: end-of-service benefit per worker and for the
 * household (liability), and the worker's salary-advance breakdown.
 */
@Controller()
export class LaborController {
  constructor(private readonly db: PrismaService) {}

  @Get('staff/:id/end-of-service')
  esb(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(AsOf)) q: z.infer<typeof AsOf>) {
    return this.db.withRls(ctx, async (tx) => {
      const s = await tx.staffProfile.findFirst({ where: { id }, select: { id: true, fullNameI18n: true, status: true } });
      if (!s) throw new NotFoundException('staff member not found');
      const asOf = q.asOf ? new Date(`${q.asOf}T00:00:00Z`) : todayRiyadh();
      const r = await esbFor(tx, id, asOf);
      if (!r) throw new NotFoundException('no employment contract visible for this worker');
      const history = await tx.esbAccrual.findMany({ where: { staffId: id }, orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }], take: 24 });
      return { staffId: id, name: resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text, asOf: asOf.toISOString().slice(0, 10), ...r,
        accruals: history.map((h) => ({ period: `${h.periodYear}-${String(h.periodMonth).padStart(2, '0')}`, vested: money(h.vested), provision: money(h.provision), delta: money(h.delta) })) };
    });
  }

  /**
   * Final settlement if the contract ended on `asOf`: ESB vested (Art. 16) + unused
   * leave ((monthly wage / 30) × unused days, Art. 10). Outstanding salary advances
   * are listed separately: recovering them from the settlement is an agreement with
   * the worker, not an automatic deduction.
   */
  @Get('staff/:id/final-settlement')
  settlement(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(AsOf)) q: z.infer<typeof AsOf>) {
    return this.db.withRls(ctx, async (tx) => {
      if (!(await tx.staffProfile.findFirst({ where: { id }, select: { id: true } }))) throw new NotFoundException('staff member not found');
      const asOf = q.asOf ? new Date(`${q.asOf}T00:00:00Z`) : todayRiyadh();
      const [esb, leave] = await Promise.all([esbFor(tx, id, asOf), leaveFor(tx, id, asOf)]);
      if (!esb || !leave) throw new NotFoundException('no employment contract visible for this worker');
      const advances = await tx.salaryAdvance.aggregate({ where: { staffId: id, settledAt: null }, _sum: { outstanding: true } });
      const outstanding = Number(advances._sum.outstanding ?? 0);
      const total = Number(esb.vested) + Number(leave.unusedLeavePayout);
      return { staffId: id, asOf: asOf.toISOString().slice(0, 10), currency: 'SAR',
        endOfService: { rule: esb.rule, basis: esb.basis, serviceStart: esb.serviceStart, completedFourYearPeriods: esb.completedFourYearPeriods, amount: esb.vested },
        unusedLeave: { basis: leave.basis, days: Math.max(0, leave.balanceDays), dailyRate: leave.dailyRate, amount: leave.unusedLeavePayout },
        totalDue: total.toFixed(2), advancesOutstanding: outstanding.toFixed(2), totalAfterAdvances: Math.max(0, total - outstanding).toFixed(2) };
    });
  }

  /** Household ESB liability (Head / EFA): every current worker. */
  @Get('hr/end-of-service')
  liability(@Ctx() ctx: RequestContext, @Query(new ZodQuery(AsOf)) q: z.infer<typeof AsOf>) {
    return this.db.withRls(ctx, async (tx) => {
      const [admin] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.is_household_admin() AS ok`;
      if (!admin?.ok) throw new ForbiddenException('the end-of-service liability is for the Household Head and the EFA office');
      const asOf = q.asOf ? new Date(`${q.asOf}T00:00:00Z`) : todayRiyadh();
      const staff = await tx.staffProfile.findMany({ where: { deletedAt: null, status: { notIn: ['TERMINATED', 'FINAL_EXIT'] } }, select: { id: true, fullNameI18n: true, staffType: true } });
      const rows: Array<NonNullable<Awaited<ReturnType<typeof esbFor>>> & { staffId: string; name: string; staffType: string }> = [];
      for (const s of staff) {
        const r = await esbFor(tx, s.id, asOf);
        if (r) rows.push({ staffId: s.id, name: resolveI18n(s.fullNameI18n as I18nText, { locale: ctx.locale }).text, staffType: s.staffType, ...r });
      }
      const sum = (k: 'vested' | 'provision') => rows.reduce((t, r) => t + Number(r[k]), 0).toFixed(2);
      return { asOf: asOf.toISOString().slice(0, 10), workers: rows.length, totalVested: sum('vested'), totalProvision: sum('provision'), data: rows };
    });
  }

  /** The worker's own advances: granted, repaid, outstanding, with each recovery. */
  @Get('me/advances')
  mine(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const s = await tx.staffProfile.findFirst({ where: { membershipId: ctx.membershipId }, select: { id: true } });
      if (!s) throw new NotFoundException('you have no staff profile in this household');
      return this.advances(tx, s.id);
    });
  }

  @Get('staff/:id/advances')
  forStaff(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      if (!(await tx.staffProfile.findFirst({ where: { id }, select: { id: true } }))) throw new NotFoundException('staff member not found');
      return this.advances(tx, id);
    });
  }

  private async advances(tx: Tx, staffId: string) {
    const advs = await tx.salaryAdvance.findMany({ where: { staffId }, orderBy: { issuedAt: 'desc' } });
    const lines = await tx.payrollLine.findMany({ where: { staffId, type: 'ADVANCE_RECOVERY', advanceId: { in: advs.map((a) => a.id) } } });
    // Run status/period: managers read runs; workers get only their own runs through app.my_payslip_runs().
    const runIds = [...new Set(lines.map((l) => l.payrollRunId))];
    const runs = new Map<string, { period: string; status: string }>();
    for (const r of await tx.payrollRun.findMany({ where: { id: { in: runIds } } })) runs.set(r.id, { period: `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}`, status: r.status });
    if (runs.size < runIds.length) {
      for (const r of await tx.$queryRaw<Array<{ id: string; period_year: number; period_month: number; status: string }>>`SELECT * FROM app.my_payslip_runs()`) {
        runs.set(r.id, { period: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`, status: r.status });
      }
    }
    const data = advs.map((a) => {
      const rec = lines.filter((l) => l.advanceId === a.id).map((l) => ({ period: runs.get(l.payrollRunId)?.period ?? null, status: runs.get(l.payrollRunId)?.status ?? 'DRAFT', amount: (-Number(l.amount)).toFixed(2) }))
        .filter((r) => r.status !== 'DRAFT').sort((x, y) => String(x.period).localeCompare(String(y.period)));
      const granted = Number(a.amount), outstanding = Number(a.outstanding);
      return { id: a.id, issuedAt: a.issuedAt.toISOString().slice(0, 10), currency: a.currency, granted: granted.toFixed(2), repaid: (granted - outstanding).toFixed(2),
        outstanding: outstanding.toFixed(2), monthlyInstallment: money(a.monthlyInstallment), settledAt: a.settledAt ? a.settledAt.toISOString().slice(0, 10) : null,
        installmentsLeft: outstanding > 0 ? Math.ceil(outstanding / Number(a.monthlyInstallment)) : 0,
        recoveries: rec.filter((r) => r.status === 'PAID'), scheduled: rec.filter((r) => r.status !== 'PAID') };
    });
    const t = (k: 'granted' | 'repaid' | 'outstanding') => data.reduce((s, a) => s + Number(a[k]), 0).toFixed(2);
    return { staffId, currency: advs[0]?.currency ?? 'SAR', totalGranted: t('granted'), totalRepaid: t('repaid'), currentOutstanding: t('outstanding'),
      openAdvances: data.filter((a) => Number(a.outstanding) > 0).length, data };
  }
}
