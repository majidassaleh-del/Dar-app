import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodQuery } from '../common/zod.pipe';
import { isoDate } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const ListQuery = z.object({ staffId: z.guid().optional(), year: z.coerce.number().int().optional() });
const YearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

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
   * Annual leave: entitlement from the active contract (annualLeaveDays,
   * pro-rated for the part of the year employed), taken = approved ANNUAL days.
   */
  @Get('staff/:staffId/leave-balance')
  balance(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Query(new ZodQuery(YearQuery)) q: z.infer<typeof YearQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      const staff = await tx.staffProfile.findFirst({ where: { id: staffId }, select: { hireDate: true, terminationDate: true } });
      if (!staff) throw new NotFoundException('staff member not found');
      const contract = await tx.employmentContract.findFirst({ where: { staffId, isActive: true } });
      const yStart = Date.UTC(q.year, 0, 1), yEnd = Date.UTC(q.year, 11, 31);
      const from = Math.max(yStart, staff.hireDate?.getTime() ?? yStart, contract?.startDate.getTime() ?? yStart);
      const to = Math.min(yEnd, staff.terminationDate?.getTime() ?? yEnd);
      const fraction = to < from ? 0 : (to - from + 86_400_000) / (yEnd - yStart + 86_400_000);
      const entitlement = Math.round((contract?.annualLeaveDays ?? 0) * fraction * 10) / 10;
      const taken = (await tx.leaveRecord.findMany({ where: { staffId, type: 'ANNUAL', startDate: { gte: new Date(yStart), lte: new Date(yEnd) } }, select: { days: true } }))
        .reduce((s, l) => s + Number(l.days), 0);
      const byType = await tx.leaveRecord.groupBy({ by: ['type'], where: { staffId, startDate: { gte: new Date(yStart), lte: new Date(yEnd) } }, _sum: { days: true } });
      return { staffId, year: q.year, annual: { entitlement, taken, remaining: Math.round((entitlement - taken) * 10) / 10 },
               byType: Object.fromEntries(byType.map((t) => [t.type, Number(t._sum.days ?? 0)])) };
    });
  }
}
