import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService, type Tx } from '../db/prisma.service';
import { audit } from '../common/audit';
import { Ctx, NoHousehold } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import type { RequestContext } from '../tenancy/request-context';

const UpdateMember = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  roleId: z.guid().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
}).strict();
export const SCOPES = ['ALL', 'OWN', 'ASSIGNED', 'WARDS'] as const;
const Overrides = z.object({ overrides: z.array(z.object({ permissionId: z.string().min(3).max(80), granted: z.boolean(), scope: z.enum(SCOPES).default('ALL') }).strict()).max(200) }).strict();

/** Member roles, status, custom roles and permissions are the household owner's alone (RLS enforces the same underneath). */
export async function ownerOnly(tx: Tx, what = 'manage members, roles and permissions') {
  const [o] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.is_household_owner() AS ok`;
  if (!o?.ok) throw new ForbiddenException(`only the household owner can ${what}`);
}

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
        select: { id: true, displayName: true, relationship: true, status: true, roleId: true, joinedAt: true, userId: true,
                  user: { select: { fullNameI18n: true } },
                  role: { select: { systemRole: true, nameI18n: true, isDefault: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return { data: rows.map(({ user, userId, ...m }) => ({ ...m, self: userId === ctx.userId,
        name: m.displayName ?? (resolveI18n((user?.fullNameI18n ?? {}) as I18nText, { locale: ctx.locale }).text || null),
        role: { systemRole: m.role.systemRole, custom: !m.role.isDefault,
        name: resolveI18n(m.role.nameI18n as I18nText, { locale: ctx.locale }).text } })) };
    });
  }

  @Patch('members/:id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
         @Body(new ZodBody(UpdateMember)) body: z.infer<typeof UpdateMember>) {
    return this.db.withRls(ctx, async (tx) => {
      const managing = body.roleId !== undefined || body.status !== undefined;
      const before = managing ? await tx.membership.findFirst({ where: { id }, select: { roleId: true, status: true, userId: true } }) : null;
      if (managing && before && before.userId !== ctx.userId) await ownerOnly(tx, 'change a member\'s role or status');
      // An invited person becomes active by signing in and finishing onboarding, never by a switch.
      if (body.status === 'ACTIVE' && before?.status === 'INVITED') throw new UnprocessableEntityException('this member has not finished their first sign-in yet');
      // updateMany: under RLS an invisible row is "0 rows", which we report as 404.
      const { count } = await tx.membership.updateMany({ where: { id }, data: body });
      if (!count) throw new NotFoundException('member not found');
      if (managing) await audit(tx, ctx, { action: 'UPDATE', entityType: 'Membership', entityId: id, before: before ? { roleId: before.roleId, status: before.status } : undefined,
        after: { ...(body.roleId ? { roleId: body.roleId } : {}), ...(body.status ? { status: body.status } : {}) } });
      return tx.membership.findUniqueOrThrow({ where: { id }, select: { id: true, displayName: true, roleId: true, status: true } });
    });
  }

  /** Remove a member: access ends at once; their history (requests, payments, logs) stays. */
  @Delete('members/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx, 'remove a member');
      if (id === ctx.membershipId) throw new UnprocessableEntityException('you cannot remove yourself');
      const { count } = await tx.membership.updateMany({ where: { id, status: { not: 'REVOKED' } }, data: { status: 'REVOKED' } });
      if (!count) throw new NotFoundException('member not found');
      await audit(tx, ctx, { action: 'DELETE', entityType: 'Membership', entityId: id, after: { status: 'REVOKED' } });
      return { removed: true };
    });
  }

  /** The global permission catalogue. */
  @Get('permissions')
  catalogue(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({ data: await tx.permission.findMany({ select: { id: true, module: true, description: true }, orderBy: [{ module: 'asc' }, { id: 'asc' }] }) }));
  }

  /** One member's permissions: what the role gives, the owner's overrides (deny wins), and the result. */
  @Get('members/:id/permissions')
  memberPermissions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const m = await tx.membership.findFirst({ where: { id }, select: { id: true, displayName: true, status: true, roleId: true,
        user: { select: { fullNameI18n: true } }, role: { select: { systemRole: true, nameI18n: true, permissions: true } }, permissionOverrides: true } });
      if (!m) throw new NotFoundException('member not found');
      const role = new Map(m.role.permissions.map((p) => [p.permissionId, p.scope]));
      const ovr = new Map(m.permissionOverrides.map((p) => [p.permissionId, p]));
      const all = await tx.permission.findMany({ select: { id: true, module: true, description: true }, orderBy: [{ module: 'asc' }, { id: 'asc' }] });
      return { member: { id: m.id, status: m.status, roleId: m.roleId, name: m.displayName ?? (resolveI18n((m.user?.fullNameI18n ?? {}) as I18nText, { locale: ctx.locale }).text || null),
          role: { systemRole: m.role.systemRole, name: resolveI18n(m.role.nameI18n as I18nText, { locale: ctx.locale }).text }, locked: m.role.systemRole === 'HOUSEHOLD_HEAD' },
        permissions: all.map((p) => { const o = ovr.get(p.id); const r = role.get(p.id) ?? null;
          return { ...p, role: r, override: o ? { granted: o.granted, scope: o.granted ? o.scope : null } : null, effective: o ? (o.granted ? o.scope : null) : r }; }) };
    });
  }

  /** Replace a member's overrides. `granted: false` denies what the role would give; `granted: true` grants with a scope. */
  @Put('members/:id/permissions')
  setMemberPermissions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Overrides)) b: z.infer<typeof Overrides>) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const m = await tx.membership.findFirst({ where: { id }, select: { id: true, role: { select: { systemRole: true } }, permissionOverrides: true } });
      if (!m) throw new NotFoundException('member not found');
      if (m.role.systemRole === 'HOUSEHOLD_HEAD') throw new UnprocessableEntityException('a Household Head always holds every permission');
      if (new Set(b.overrides.map((o) => o.permissionId)).size !== b.overrides.length) throw new UnprocessableEntityException('each permission may appear once');
      await tx.membershipPermission.deleteMany({ where: { membershipId: id } });
      if (b.overrides.length) await tx.membershipPermission.createMany({ data: b.overrides.map((o) => ({ membershipId: id, permissionId: o.permissionId, granted: o.granted, scope: o.granted ? o.scope : 'ALL' })) });
      await audit(tx, ctx, { action: 'UPDATE', entityType: 'MembershipPermissions', entityId: id,
        before: m.permissionOverrides.map((o) => ({ permissionId: o.permissionId, granted: o.granted, scope: o.scope })), after: b.overrides });
      return { membershipId: id, overrides: b.overrides.length };
    });
  }

  /** Effective permissions and scopes in the active household (drives UI gating). */
  @Get('me/permissions')
  permissions(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; scope: string }>>`
        SELECT id, app.perm_scope(id) AS scope FROM permissions WHERE app.perm_scope(id) IS NOT NULL ORDER BY id`;
      const [admin] = await tx.$queryRaw<Array<{ admin: boolean }>>`SELECT app.is_household_admin() AS admin`;
      const [owner] = await tx.$queryRaw<Array<{ owner: boolean }>>`SELECT app.is_household_owner() AS owner`;
      return { membershipId: ctx.membershipId, householdAdmin: admin?.admin ?? false, householdOwner: owner?.owner ?? false,
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
      const households = await tx.$queryRaw<Array<{ household_id: string; household_slug: string; household_name: I18nText; membership_id: string;
                                                     system_role: string; role_name: I18nText }>>`
        SELECT household_id::text, household_slug, household_name, membership_id::text, system_role, role_name FROM app.my_households()`;
      return {
        ...user, locale: ctx.locale,
        households: households.map((h) => ({
          householdId: h.household_id, slug: h.household_slug, name: resolveI18n(h.household_name, { locale: ctx.locale }).text,
          membershipId: h.membership_id, systemRole: h.system_role,
          role: resolveI18n(h.role_name, { locale: ctx.locale }).text,
        })),
      };
    });
  }
}
