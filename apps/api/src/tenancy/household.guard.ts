import { Injectable, NotFoundException, BadRequestException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../db/prisma.service';
import { IS_PUBLIC, NO_HOUSEHOLD } from '../common/decorators';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Requires X-Household-Id and resolves the caller's membership through the
 * same RLS functions the policies use. A non-member gets 404, never 403, so
 * the API does not confirm that a household exists.
 */
@Injectable()
export class HouseholdGuard implements CanActivate {
  constructor(private readonly db: PrismaService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])
      || this.reflector.getAllAndOverride<boolean>(NO_HOUSEHOLD, [context.getHandler(), context.getClass()]);
    if (skip) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const householdId = req.headers['x-household-id'];
    if (typeof householdId !== 'string' || !UUID.test(householdId)) throw new BadRequestException('X-Household-Id header (uuid) is required');
    const ctx = req.ctx!;
    const [row] = await this.db.withRls({ userId: ctx.userId, householdId }, (tx) =>
      tx.$queryRaw<Array<{ id: string | null }>>`SELECT app.current_membership_id()::text AS id`);
    if (!row?.id) throw new NotFoundException('household not found');
    req.ctx = { ...ctx, householdId, membershipId: row.id };
    return true;
  }
}
