import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { seal } from '@herp/crypto';
import { PrismaService, type Tx } from '../db/prisma.service';
import { CryptoService } from '../crypto/crypto.module';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { audit } from '../common/audit';
import { assertWritten } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { ChangeStatus, CreateStaff, STAFF_STATUSES, STAFF_TYPES, STATUS_TRANSITIONS, UpdateStaff, type StaffStatus } from './staff.schemas';
import { staffDto } from './staff.dto';

const ListQuery = z.object({ status: z.enum(STAFF_STATUSES).optional(), staffType: z.enum(STAFF_TYPES).optional() });

/** GET/POST /v1/staff, GET/PATCH /v1/staff/:id, POST /v1/staff/:id/status. Visibility & write rights come from RLS. */
@Controller('staff')
export class StaffController {
  constructor(private readonly db: PrismaService, private readonly crypto: CryptoService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.staffProfile.findMany({ where: { deletedAt: null, status: q.status, staffType: q.staffType }, orderBy: { createdAt: 'asc' } }))
        .map((s) => staffDto(s, ctx.locale)),
    }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateStaff)) b: z.infer<typeof CreateStaff>) {
    return this.db.withRls(ctx, async (tx) => {
      if (b.membershipId) await this.assertMember(tx, b.membershipId);
      const { fullName, borderNumber, payoutIban, ...rest } = b;
      const row = await tx.staffProfile.create({
        data: {
          ...rest, householdId: ctx.householdId!, fullNameI18n: fullName,
          status: b.hireDate ? 'ON_PROBATION' : 'RECRUITING',
          ...(await seal(this.crypto.cipher, 'staff_profiles.borderNumber', ctx.householdId!, borderNumber)),
          ...(await seal(this.crypto.cipher, 'staff_profiles.payoutIban', ctx.householdId!, payoutIban)),
        },
      });
      return staffDto(row, ctx.locale);
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => staffDto(await this.find(tx, id), ctx.locale));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(UpdateStaff)) b: z.infer<typeof UpdateStaff>) {
    return this.db.withRls(ctx, async (tx) => {
      if (b.membershipId) await this.assertMember(tx, b.membershipId);
      const { fullName, borderNumber, payoutIban, ...rest } = b;
      const current = await this.find(tx, id);
      if ((b.defaultPayoutChannel ?? current.defaultPayoutChannel) === 'BANK_TRANSFER' && !payoutIban && !current.payoutIbanCiphertext) {
        throw new BadRequestException('payoutIban: BANK_TRANSFER needs payoutIban');
      }
      const { count } = await tx.staffProfile.updateMany({
        where: { id, deletedAt: null },
        data: {
          ...rest, ...(fullName ? { fullNameI18n: fullName } : {}),
          ...(await seal(this.crypto.cipher, 'staff_profiles.borderNumber', ctx.householdId!, borderNumber)),
          ...(await seal(this.crypto.cipher, 'staff_profiles.payoutIban', ctx.householdId!, payoutIban)),
        },
      });
      await assertWritten(count, async () => current, 'staff profile');
      return staffDto(await this.find(tx, id), ctx.locale);
    });
  }

  /** Lifecycle change (hire → active → leave / absconded (huroob) / terminated / final exit), audited. */
  @Post(':id/status')
  changeStatus(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(ChangeStatus)) b: z.infer<typeof ChangeStatus>) {
    return this.db.withRls(ctx, async (tx) => {
      const s = await this.find(tx, id);
      const from = s.status as StaffStatus;
      if (!STATUS_TRANSITIONS[from].includes(b.status)) {
        throw new UnprocessableEntityException(`cannot move from ${from} to ${b.status}; allowed: ${STATUS_TRANSITIONS[from].join(', ') || 'none (final)'}`);
      }
      const terminal = b.status === 'TERMINATED' || b.status === 'FINAL_EXIT';
      const { count } = await tx.staffProfile.updateMany({
        where: { id }, data: { status: b.status, ...(terminal ? { terminationDate: b.effectiveDate ?? new Date() } : {}) },
      });
      await assertWritten(count, async () => s, 'staff profile');
      await audit(tx, ctx, { action: 'UPDATE', entityType: 'staff_profiles', entityId: id, before: { status: from }, after: { status: b.status, reason: b.reason ?? null } });
      return staffDto(await this.find(tx, id), ctx.locale);
    });
  }

  private async find(tx: Tx, id: string) {
    const s = await tx.staffProfile.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new NotFoundException('staff member not found');
    return s;
  }

  private async assertMember(tx: Tx, membershipId: string) {
    if (!(await tx.membership.findFirst({ where: { id: membershipId }, select: { id: true } }))) {
      throw new UnprocessableEntityException('membershipId is not a member of this household');
    }
  }
}
