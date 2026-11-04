import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Attendance } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { isoDate } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const CheckIn = z.object({ geo: z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().optional() }).optional() }).strict();
const ListQuery = z.object({ from: ymd.optional(), to: ymd.optional(), staffId: z.guid().optional() });
const Correct = z.object({
  status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'DAY_OFF', 'ON_LEAVE']),
  checkInAt: z.string().datetime({ offset: true }).optional(), checkOutAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().max(500).optional(),
}).strict();

const dto = (a: Attendance) => ({ id: a.id, staffId: a.staffId, date: isoDate(a.date), status: a.status,
  checkInAt: a.checkInAt, checkOutAt: a.checkOutAt, note: a.note });

/**
 * Self check-in/out from the staff app (today only, server-stamped times, geo
 * opt-in at check-in) and manager corrections. Rules live in app.guard_attendance.
 */
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly db: PrismaService) {}

  @Post('check-in')
  checkIn(@Ctx() ctx: RequestContext, @Body(new ZodBody(CheckIn)) b: z.infer<typeof CheckIn>) {
    return this.db.withRls(ctx, async (tx) => {
      const staffId = await this.myStaffId(tx, ctx);
      const today = await this.today(tx, ctx);
      if (await tx.attendance.findFirst({ where: { staffId, date: today }, select: { id: true } })) throw new ConflictException('already checked in today');
      const a = await tx.attendance.create({ data: { householdId: ctx.householdId!, staffId, date: today, status: 'PRESENT',
                                                    checkInAt: new Date(), checkInGeo: b.geo } });
      return dto(a);
    });
  }

  @Post('check-out')
  checkOut(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const staffId = await this.myStaffId(tx, ctx);
      const today = await this.today(tx, ctx);
      const a = await tx.attendance.findFirst({ where: { staffId, date: today } });
      if (!a) throw new NotFoundException('no check-in today');
      if (a.checkOutAt) throw new ConflictException('already checked out');
      await tx.attendance.updateMany({ where: { id: a.id }, data: { checkOutAt: new Date() } });
      return dto((await tx.attendance.findFirst({ where: { id: a.id } }))!);
    });
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.attendance.findMany({
        where: { staffId: q.staffId, date: { gte: q.from ? new Date(`${q.from}T00:00:00Z`) : undefined, lte: q.to ? new Date(`${q.to}T00:00:00Z`) : undefined } },
        orderBy: [{ date: 'desc' }, { staffId: 'asc' }], take: 500,
      })).map(dto),
    }));
  }

  /** Manager correction / backfill for any day (absences, day off, forgotten check-out). */
  @Put(':staffId/:date')
  correct(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Param('date') date: string,
          @Body(new ZodBody(Correct)) b: z.infer<typeof Correct>) {
    return this.db.withRls(ctx, async (tx) => {
      const d = new Date(`${ymd.parse(date)}T00:00:00Z`);
      const data = { status: b.status, note: b.note, checkInAt: b.checkInAt ? new Date(b.checkInAt) : undefined,
                     checkOutAt: b.checkOutAt ? new Date(b.checkOutAt) : undefined };
      const existing = await tx.attendance.findFirst({ where: { staffId, date: d } });
      if (existing) {
        const { count } = await tx.attendance.updateMany({ where: { id: existing.id }, data });
        if (!count) throw new ForbiddenException('only a manager can correct attendance');
        return dto((await tx.attendance.findFirst({ where: { id: existing.id } }))!);
      }
      return dto(await tx.attendance.create({ data: { ...data, householdId: ctx.householdId!, staffId, date: d } }));
    });
  }

  private async myStaffId(tx: Tx, ctx: RequestContext) {
    const s = await tx.staffProfile.findFirst({ where: { membershipId: ctx.membershipId, deletedAt: null }, select: { id: true } });
    if (!s) throw new ForbiddenException('only staff members check in');
    return s.id;
  }

  private async today(tx: Tx, ctx: RequestContext): Promise<Date> {
    const [r] = await tx.$queryRaw<Array<{ d: Date }>>`SELECT app.household_today(${ctx.householdId}::uuid) AS d`;
    return r!.d;
  }
}
