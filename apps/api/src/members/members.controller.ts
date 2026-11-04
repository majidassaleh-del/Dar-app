import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService } from '../db/prisma.service';
import { Ctx, NoHousehold } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import type { RequestContext } from '../tenancy/request-context';

const UpdateMember = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  roleId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
}).strict();

/**
 * Reference module. Every handler does its work inside db.withRls(ctx, …):
 * no tenant WHERE clauses, no permission checks duplicated in TypeScript;
 * RLS + triggers decide, and ProblemFilter maps refusals to 403/422.
 */
@Controller()
export class MembersController {
  constructor(private readonly db: PrismaService) {}

  @Get('members')
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const rows = await tx.membership.findMany({
        select: { id: true, displayName: true, relationship: true, status: true, roleId: true,
                  role: { select: { systemRole: true, nameI18n: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return { data: rows.map((m) => ({ ...m, role: { systemRole: m.role.systemRole,
        name: resolveI18n(m.role.nameI18n as I18nText, { locale: ctx.locale }).text } })) };
    });
  }

  @Patch('members/:id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
         @Body(new ZodBody(UpdateMember)) body: z.infer<typeof UpdateMember>) {
    return this.db.withRls(ctx, async (tx) => {
      // updateMany: under RLS an invisible row is "0 rows", which we report as 404.
      const { count } = await tx.membership.updateMany({ where: { id }, data: body });
      if (!count) throw new NotFoundException('member not found');
      return tx.membership.findUniqueOrThrow({ where: { id }, select: { id: true, displayName: true, roleId: true, status: true } });
    });
  }

  /** Effective permissions and scopes in the active household (drives UI gating). */
  @Get('me/permissions')
  permissions(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; scope: string }>>`
        SELECT id, app.perm_scope(id) AS scope FROM permissions WHERE app.perm_scope(id) IS NOT NULL ORDER BY id`;
      const [admin] = await tx.$queryRaw<Array<{ admin: boolean }>>`SELECT app.is_household_admin() AS admin`;
      return { membershipId: ctx.membershipId, householdAdmin: admin?.admin ?? false,
               permissions: Object.fromEntries(rows.map((r) => [r.id, r.scope])) };
    });
  }

  @NoHousehold()
  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const [user] = await tx.$queryRaw<Array<{ id: string; preferredLocale: string }>>`
        SELECT id::text, "preferredLocale"::text AS "preferredLocale" FROM users WHERE id = ${ctx.userId}::uuid`;
      if (!user) throw new NotFoundException('user not found');
      const households = await tx.$queryRaw<Array<{ household_id: string; household_name: I18nText; membership_id: string;
                                                     system_role: string; role_name: I18nText }>>`
        SELECT household_id::text, household_name, membership_id::text, system_role, role_name FROM app.my_households()`;
      return {
        ...user, locale: ctx.locale,
        households: households.map((h) => ({
          householdId: h.household_id, name: resolveI18n(h.household_name, { locale: ctx.locale }).text,
          membershipId: h.membership_id, systemRole: h.system_role,
          role: resolveI18n(h.role_name, { locale: ctx.locale }).text,
        })),
      };
    });
  }
}
