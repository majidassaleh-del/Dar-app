import { Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService, type Tx } from '../db/prisma.service';
import { ENV, type Env } from '../config/env';
import { Ctx } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { audit } from '../common/audit';
import { invitationHash } from '../auth/auth.controller';
import type { RequestContext } from '../tenancy/request-context';

const LOCALES = ['ar', 'en', 'hi', 'tl', 'am', 'bn'] as const;
const Create = z.object({
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +9665XXXXXXXX').optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  roleId: z.guid(),
  displayName: z.string().trim().min(1).max(80).optional(),
  locale: z.enum(LOCALES).optional(),
  expiresInHours: z.number().int().min(1).max(168).default(72),
}).strict().refine((b) => b.phone || b.email, { message: 'a phone number or an e-mail address is required' });

/**
 * Invitations: the only way a new account is created. Only the household owner (an active
 * Household Head) may issue, list or revoke them; RLS enforces the same rule underneath.
 * The token is returned once, at creation; the database keeps its SHA-256 only.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly db: PrismaService, @Inject(ENV) private readonly env: Env) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      await this.ownerOnly(tx);
      const rows = await tx.invitation.findMany({ orderBy: { createdAt: 'desc' }, take: 200,
        select: { id: true, phone: true, email: true, displayName: true, locale: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true,
                  role: { select: { id: true, systemRole: true, nameI18n: true } } } });
      const now = Date.now();
      return { data: rows.map(({ role, ...i }) => ({ ...i,
        status: i.acceptedAt ? 'ACCEPTED' : i.revokedAt ? 'REVOKED' : i.expiresAt.getTime() <= now ? 'EXPIRED' : 'PENDING',
        role: { id: role.id, systemRole: role.systemRole, name: resolveI18n(role.nameI18n as I18nText, { locale: ctx.locale }).text || role.systemRole } })) };
    });
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.ownerOnly(tx);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + b.expiresInHours * 3_600_000);
      const locale = b.locale ?? ctx.locale;
      // Raw insert: the request role cannot read "tokenHash", so a RETURNING * (Prisma create) would be refused.
      const [row] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO invitations (id, "householdId", "roleId", phone, email, "displayName", locale, "tokenHash", "expiresAt", "invitedById")
        VALUES (gen_random_uuid(), ${ctx.householdId}::uuid, ${b.roleId}::uuid, ${b.phone ?? null}, ${b.email ?? null}, ${b.displayName ?? null},
                ${locale}::"Locale", ${invitationHash(token)}, ${expiresAt}, ${ctx.membershipId}::uuid)
        RETURNING id::text`;
      await audit(tx, ctx, { action: 'CREATE', entityType: 'Invitation', entityId: row!.id, after: { phone: b.phone ?? null, email: b.email ?? null, roleId: b.roleId, expiresAt: expiresAt.toISOString() } });
      const path = `/${locale}/invite/${token}`;
      return { id: row!.id, token, path, url: this.env.PUBLIC_APP_URL ? `${this.env.PUBLIC_APP_URL.replace(/\/+$/, '')}${path}` : null, expiresAt: expiresAt.toISOString() };
    });
  }

  /** Revoke a pending invitation; an accepted one is history and stays. */
  @Delete(':id')
  revoke(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      await this.ownerOnly(tx);
      const n = await tx.$executeRaw`UPDATE invitations SET "revokedAt" = now() WHERE id = ${id}::uuid AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`;
      if (!n) throw new NotFoundException('no pending invitation with this id');
      await audit(tx, ctx, { action: 'UPDATE', entityType: 'Invitation', entityId: id, after: { revoked: true } });
      return { revoked: true };
    });
  }

  private async ownerOnly(tx: Tx) {
    const [o] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.is_household_owner() AS ok`;
    if (!o?.ok) throw new ForbiddenException('only the household owner can manage invitations');
  }
}
