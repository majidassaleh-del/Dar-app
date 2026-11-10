import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, UnprocessableEntityException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { audit } from '../common/audit';
import type { RequestContext } from '../tenancy/request-context';
import { SCOPES, ownerOnly } from './members.controller';

const LOCALES = ['ar', 'en', 'hi', 'tl', 'am', 'bn'] as const;
const BASES = ['SPOUSE', 'DEPENDENT', 'STAFF', 'DRIVER', 'ACCOUNTANT', 'GUEST'] as const;
const Label = z.string().trim().min(1).max(60);
const Names = z.partialRecord(z.enum(LOCALES), Label);
const Create = z.object({ baseRole: z.enum(BASES), name: Label.optional(), nameI18n: Names.optional() }).strict()
  .refine((b) => b.name || Object.keys(b.nameI18n ?? {}).length, { message: 'name or nameI18n is required' });
const Rename = z.object({ name: Label.optional(), nameI18n: Names.optional() }).strict()
  .refine((b) => b.name || Object.keys(b.nameI18n ?? {}).length, { message: 'name or nameI18n is required' });
const Matrix = z.object({ permissions: z.array(z.object({ permissionId: z.string().min(3).max(80), scope: z.enum(SCOPES) }).strict()).max(200) }).strict();

/**
 * Roles. Each household has one seeded role per base (Household Head, EFA Office Admin, Spouse,
 * Dependent, Staff, Driver, Accountant, Guest). The owner may add custom roles: a label of their
 * own on a non-admin base ("Head Driver" on Driver, "Office Staff" on Staff), which starts with a
 * copy of the base role's permissions and is then adjusted on its own. What the system does by
 * base role (driver features, staff self-service) follows the base. Everything here but the
 * list is the household owner's alone.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const rows = await tx.role.findMany({ select: { id: true, systemRole: true, nameI18n: true, isDefault: true, _count: { select: { memberships: true } } }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
      const base = new Map(rows.filter((r) => r.isDefault).map((r) => [r.systemRole, resolveI18n(r.nameI18n as I18nText, { locale: ctx.locale }).text]));
      return { data: rows.map((r) => ({ id: r.id, systemRole: r.systemRole, isDefault: r.isDefault, custom: !r.isDefault, members: r._count.memberships,
        name: resolveI18n(r.nameI18n as I18nText, { locale: ctx.locale }).text || base.get(r.systemRole) || r.systemRole, baseName: base.get(r.systemRole) ?? r.systemRole,
        nameI18n: r.nameI18n })) };
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const base = await tx.role.findFirst({ where: { systemRole: b.baseRole, isDefault: true }, select: { id: true, permissions: true } });
      if (!base) throw new UnprocessableEntityException('this household has no such base role');
      const nameI18n = { ...(b.name ? { [ctx.locale]: b.name } : {}), ...(b.nameI18n ?? {}) };
      const role = await tx.role.create({ data: { householdId: ctx.householdId!, systemRole: b.baseRole, isDefault: false, nameI18n }, select: { id: true } });
      if (base.permissions.length) await tx.rolePermission.createMany({ data: base.permissions.map((p) => ({ roleId: role.id, permissionId: p.permissionId, scope: p.scope })) });
      await audit(tx, ctx, { action: 'CREATE', entityType: 'Role', entityId: role.id, after: { baseRole: b.baseRole, nameI18n } });
      return { id: role.id, systemRole: b.baseRole, custom: true, nameI18n, permissions: base.permissions.length };
    });
  }

  @Patch(':id')
  rename(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Rename)) b: z.infer<typeof Rename>) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const role = await tx.role.findFirst({ where: { id }, select: { nameI18n: true, isDefault: true } });
      if (!role) throw new NotFoundException('role not found');
      if (role.isDefault) throw new UnprocessableEntityException('built-in roles keep their names; create a custom role instead');
      const nameI18n = { ...(role.nameI18n as Record<string, string>), ...(b.name ? { [ctx.locale]: b.name } : {}), ...(b.nameI18n ?? {}) };
      await tx.role.updateMany({ where: { id }, data: { nameI18n } });
      await audit(tx, ctx, { action: 'UPDATE', entityType: 'Role', entityId: id, before: { nameI18n: role.nameI18n as object }, after: { nameI18n } });
      return { id, nameI18n };
    });
  }

  @Delete(':id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const role = await tx.role.findFirst({ where: { id }, select: { isDefault: true, _count: { select: { memberships: true, invitations: true } } } });
      if (!role) throw new NotFoundException('role not found');
      if (role.isDefault) throw new UnprocessableEntityException('built-in roles cannot be deleted');
      if (role._count.memberships) throw new ConflictException('members still hold this role; move them to another role first');
      // Invitations keep pointing at their role: pending ones must be revoked first; history blocks deletion too.
      if (role._count.invitations) throw new ConflictException('invitations were issued for this role; it cannot be deleted');
      await tx.role.deleteMany({ where: { id } });
      await audit(tx, ctx, { action: 'DELETE', entityType: 'Role', entityId: id });
      return { deleted: true };
    });
  }

  @Get(':id/permissions')
  permissions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const role = await tx.role.findFirst({ where: { id }, select: { id: true, systemRole: true, isDefault: true, nameI18n: true, permissions: true, _count: { select: { memberships: true } } } });
      if (!role) throw new NotFoundException('role not found');
      const base = role.isDefault ? null : await tx.role.findFirst({ where: { systemRole: role.systemRole, isDefault: true }, select: { nameI18n: true } });
      const own = resolveI18n(role.nameI18n as I18nText, { locale: ctx.locale }).text;
      const baseName = base ? resolveI18n(base.nameI18n as I18nText, { locale: ctx.locale }).text : null;
      const have = new Map(role.permissions.map((p) => [p.permissionId, p.scope]));
      const all = await tx.permission.findMany({ select: { id: true, module: true, description: true }, orderBy: [{ module: 'asc' }, { id: 'asc' }] });
      return { role: { id: role.id, systemRole: role.systemRole, custom: !role.isDefault, name: own || baseName || role.systemRole, baseName, members: role._count.memberships,
          locked: role.systemRole === 'HOUSEHOLD_HEAD' },
        permissions: all.map((p) => ({ ...p, scope: have.get(p.id) ?? null })) };
    });
  }

  /** Replace the role's permission matrix: listed permissions are granted with their scope, the rest are not granted. */
  @Put(':id/permissions')
  setPermissions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Matrix)) b: z.infer<typeof Matrix>) {
    return this.db.withRls(ctx, async (tx) => {
      await ownerOnly(tx);
      const role = await tx.role.findFirst({ where: { id }, select: { systemRole: true, permissions: true } });
      if (!role) throw new NotFoundException('role not found');
      if (role.systemRole === 'HOUSEHOLD_HEAD') throw new UnprocessableEntityException('the Household Head role always holds every permission');
      if (new Set(b.permissions.map((p) => p.permissionId)).size !== b.permissions.length) throw new UnprocessableEntityException('each permission may appear once');
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (b.permissions.length) await tx.rolePermission.createMany({ data: b.permissions.map((p) => ({ roleId: id, permissionId: p.permissionId, scope: p.scope })) });
      await audit(tx, ctx, { action: 'UPDATE', entityType: 'RolePermissions', entityId: id,
        before: role.permissions.map((p) => ({ permissionId: p.permissionId, scope: p.scope })), after: b.permissions });
      return { roleId: id, permissions: b.permissions.length };
    });
  }
}
