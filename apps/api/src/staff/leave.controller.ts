import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodQuery } from '../common/zod.pipe';
import { isoDate } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { leaveFor } from '../hr/esb';

const ListQuery = z.object({ staffId: z.guid().optional(), year: z.coerce.number().int().optional() });
const BalanceQuery = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), year: z.coerce.number().int().min(2000).max(2100).optional() });

/** Leave records are created by approving a LEAVE request (POST /v1/requests); this is the read side. */
@Controller()
export class LeaveController {
  constructor(private readonly db: PrismaService) {}

  @Get('leaves')
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      const range = q.year ? { gte: new Date(Date.UTC(q.year, 0, 1)), lte: new Date(Date.UTC(q.year, 11, 31)) } : undefined;
      const rows = await tx.leaveRecord.findMany({ where: { staffId: q.staffId, startDate: range }, orderBy: { startDate: 'desc' } });
      return { data: rows.map((l) => ({ id: l.id, staffId: l.staffId, requestId: l.requestId, type: l.type, startDate: isoDate(l.startDate),
                                        endDate: isoDate(l.endDate), days: Number(l.days), paid: l.paid })) };
    });
  }

  /**
   * Art. 10 leave position: 30 paid days per 2 completed years of service (accruing at
   * 15 days a year unless the contract grants more), days taken, balance, what is
   * already vested, and the unused-leave payout if the contract ended on `asOf`
   * ((monthly wage / 30) × unused days). `year` adds that year's days by leave type.
   */
  @Get('staff/:staffId/leave-balance')
  balance(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Query(new ZodQuery(BalanceQuery)) q: z.infer<typeof BalanceQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      if (!(await tx.staffProfile.findFirst({ where: { id: staffId }, select: { id: true } }))) throw new NotFoundException('staff member not found');
      const asOf = q.asOf ? new Date(`${q.asOf}T00:00:00Z`) : new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date())}T00:00:00Z`);
      const leave = await leaveFor(tx, staffId, asOf);
      if (!leave) throw new NotFoundException('no employment contract visible for this worker');
      const year = q.year ?? asOf.getUTCFullYear();
      const byType = await tx.leaveRecord.groupBy({ by: ['type'], where: { staffId, startDate: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }, _sum: { days: true } });
      return { staffId, asOf: isoDate(asOf), ...leave, year, byType: Object.fromEntries(byType.map((t) => [t.type, Number(t._sum.days ?? 0)])) };
    });
  }
}
