import { Body, ConflictException, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { Public } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { IdpAdminService } from '../auth/idp-admin.service';
import { OnboardingGuard } from '../auth/onboarding.guard';

const LOCALES = ['ar', 'en', 'hi', 'tl', 'am', 'bn'] as const;
const RESERVED = new Set(['app', 'www', 'api', 'admin', 'auth', 'static', 'cdn', 'mail', 'status', 'operator', 'invite', 'dar']);
const Names = z.partialRecord(z.enum(LOCALES), z.string().trim().min(1).max(80)).refine((n) => Object.keys(n).length > 0, { message: 'at least one language is required' });
const Create = z.object({
  /** Tenant subdomain: <slug>.darerp.net. */
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/, 'lowercase letters, digits and hyphens, 3–32 characters').refine((s) => !RESERVED.has(s), { message: 'this name is reserved' }),
  name: Names,
  locale: z.enum(LOCALES).default('ar'),
  owner: z.object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +9665XXXXXXXX').optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    name: Names.optional(),
  }).strict().refine((o) => o.phone || o.email, { message: 'a phone number or an e-mail address is required' }),
}).strict();

/**
 * Operator-only provisioning: the one way a new household, and with it a new Household Owner,
 * comes into existence. There is no session here; the caller presents the operator key in
 * X-Operator-Key and the DATABASE checks it against app.operator_keys (SHA-256 only, unreadable
 * by the request role). No key on file, or any other caller: 403. Owners then invite everyone else.
 */
@Controller('operator')
export class OperatorController {
  constructor(private readonly db: PrismaService, private readonly idp: IdpAdminService, private readonly onboarding: OnboardingGuard) {}

  @Public()
  @Post('create-household')
  async createHousehold(@Headers('x-operator-key') key: string | undefined, @Body() raw: unknown) {
    // The key is checked before the body is even validated: an outsider learns nothing about the shape.
    const [ok] = typeof key === 'string' && key.length >= 32 && key.length <= 200
      ? await this.db.withRls({ userId: '' }, (tx) => tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.operator_key_ok(${key}) AS ok`) : [{ ok: false }];
    if (!ok?.ok) throw new ForbiddenException('access denied: operator key required');
    const b = new ZodBody(Create).transform(raw) as z.infer<typeof Create>;
    const { existing, slugTaken } = await this.db.withRls({ userId: '' }, async (tx) => {
      // users / households are not readable without a session: ask through the definer path only what is needed.
      const [r] = await tx.$queryRaw<Array<{ existing: string | null; taken: boolean }>>`SELECT * FROM app.operator_lookup(${key}, ${b.owner.phone ?? null}, ${b.owner.email ?? null}, ${b.slug})`;
      return { existing: r?.existing ?? null, slugTaken: !!r?.taken };
    });
    if (slugTaken) throw new ConflictException('this slug is already taken');
    const ownerId = existing ?? await this.idp.ensureUser({ phone: b.owner.phone, email: b.owner.email });
    const [row] = await this.db.withRls({ userId: '' }, (tx) => tx.$queryRaw<Array<{ id: string }>>`
      SELECT app.operator_create_household(${key}, ${ownerId}::uuid, ${b.owner.phone ?? null}, ${b.owner.email ?? null},
        ${JSON.stringify(b.owner.name ?? {})}::jsonb, ${b.slug}, ${JSON.stringify(b.name)}::jsonb, ${b.locale}::"Locale")::text AS id`);
    this.onboarding.forget(ownerId);
    return { householdId: row!.id, slug: b.slug, name: b.name, owner: { userId: ownerId, existingAccount: !!existing, phone: b.owner.phone ?? null, email: b.owner.email ?? null },
      next: 'the owner signs in at the owner entry with a code sent to this phone / e-mail, then invites members' };
  }
}
