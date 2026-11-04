import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodQuery } from '../common/zod.pipe';
import type { RequestContext } from '../tenancy/request-context';
import { groupByStaff } from './payroll.controller';
import { salaryDto } from './staff.dto';

const Query_ = z.object({ year: z.coerce.number().int().optional(), month: z.coerce.number().int().min(1).max(12).optional() });

/**
 * Payslips in the viewer's language. Workers see their own APPROVED/PAID
 * payslips (run metadata via app.my_payslip_runs(), never run totals);
 * payroll readers see everyone's, drafts included.
 */
@Controller('payslips')
export class PayslipsController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(Query_)) q: z.infer<typeof Query_>) {
    return this.db.withRls(ctx, async (tx) => {
      const [scope] = await tx.$queryRaw<Array<{ s: string | null }>>`SELECT app.perm_scope('staff.payroll.read') AS s`;
      const runs = scope?.s === 'ALL'
        ? (await tx.payrollRun.findMany({ where: { periodYear: q.year, periodMonth: q.month } }))
            .map((r) => ({ id: r.id, year: r.periodYear, month: r.periodMonth, status: r.status as string, paidAt: r.paidAt, currency: r.currency }))
        : (await tx.$queryRaw<Array<{ id: string; period_year: number; period_month: number; status: string; paid_at: Date | null; currency: string }>>`
            SELECT id::text, period_year, period_month, status, paid_at, currency FROM app.my_payslip_runs()`)
            .filter((r) => (r.status === 'APPROVED' || r.status === 'PAID') && (!q.year || r.period_year === q.year) && (!q.month || r.period_month === q.month))
            .map((r) => ({ id: r.id, year: r.period_year, month: r.period_month, status: r.status, paidAt: r.paid_at, currency: r.currency }));
      if (!runs.length) return { data: [] };
      const ids = runs.map((r) => r.id);
      const [lines, payments] = await Promise.all([
        tx.payrollLine.findMany({ where: { payrollRunId: { in: ids } }, include: { staff: { select: { fullNameI18n: true } } }, orderBy: { type: 'asc' } }),
        tx.salaryPayment.findMany({ where: { payrollRunId: { in: ids } } }),
      ]);
      const data = runs.sort((a, b) => b.year - a.year || b.month - a.month).flatMap((r) =>
        groupByStaff(lines.filter((l) => l.payrollRunId === r.id), ctx.locale).map((slip) => ({
          runId: r.id, period: `${r.year}-${String(r.month).padStart(2, '0')}`, runStatus: r.status, currency: r.currency, ...slip,
          payments: payments.filter((p) => p.payrollRunId === r.id && p.staffId === slip.staffId).map(salaryDto),
        })));
      return { data };
    });
  }
}
