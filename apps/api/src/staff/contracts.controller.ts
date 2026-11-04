import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { isoDate, money } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { CreateContract } from './staff.schemas';
import { contractMonthly } from './staff.dto';

type ContractRow = { id: string; startDate: Date; endDate: Date | null; basicSalary: { toFixed(n: number): string }; currency: string;
  allowances: unknown; annualLeaveDays: number; ticketEntitlement: boolean; isActive: boolean; workingHoursPerDay: number | null };
const contractDto = (c: ContractRow) => ({
  id: c.id, startDate: isoDate(c.startDate), endDate: isoDate(c.endDate), basicSalary: money(c.basicSalary), currency: c.currency,
  allowances: c.allowances, monthlyTotal: contractMonthly(c as never).toFixed(2), annualLeaveDays: c.annualLeaveDays,
  ticketEntitlement: c.ticketEntitlement, workingHoursPerDay: c.workingHoursPerDay, isActive: c.isActive,
});

@Controller('staff/:staffId/contracts')
export class ContractsController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.employmentContract.findMany({ where: { staffId }, orderBy: { startDate: 'desc' } })).map(contractDto),
    }));
  }

  /** A new contract supersedes the active one in the same transaction (RLS: staff.payroll.manage). */
  @Post()
  create(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(CreateContract)) b: z.infer<typeof CreateContract>) {
    return this.db.withRls(ctx, async (tx) => {
      if (!(await tx.staffProfile.findFirst({ where: { id: staffId, deletedAt: null }, select: { id: true } }))) throw new NotFoundException('staff member not found');
      await tx.employmentContract.updateMany({ where: { staffId, isActive: true }, data: { isActive: false } });
      const c = await tx.employmentContract.create({ data: { ...b, staffId, householdId: ctx.householdId!, isActive: true } });
      return contractDto(c);
    });
  }
}
