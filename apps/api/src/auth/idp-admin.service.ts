import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env';

export interface IdpIdentity { phone: string; email?: string | null }
interface IdpUser { id: string; phone?: string | null; email?: string | null }

const digits = (s?: string | null) => (s ?? '').replace(/\D/g, '');

/**
 * Creates sign-in identities at the identity provider (Supabase Auth / GoTrue admin API).
 * Public sign-up is switched off at the provider, so this, called only while an owner-issued
 * invitation is being accepted, is the one place an identity comes into existence.
 * With AUTH_ADMIN_URL unset (dev, tests) identities are kept in memory; production refuses
 * to start without it. NOT exercised against a live Supabase project here.
 */
@Injectable()
export class IdpAdminService {
  private readonly log = new Logger('IdpAdmin');
  /** Dev / tests: identities "created" while no provider is configured. */
  readonly local: Array<IdpUser> = [];
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** The provider user id for this phone / e-mail, creating the identity if it does not exist yet. */
  async ensureUser(who: IdpIdentity): Promise<string> {
    const base = this.env.AUTH_ADMIN_URL?.replace(/\/+$/, '');
    if (!base) {
      const known = this.local.find((u) => u.phone === who.phone || (!!who.email && u.email === who.email));
      if (known) return known.id;
      const u = { id: randomUUID(), phone: who.phone, email: who.email ?? null };
      this.local.push(u);
      return u.id;
    }
    const headers = { 'Content-Type': 'application/json', apikey: this.env.AUTH_ADMIN_KEY!, Authorization: `Bearer ${this.env.AUTH_ADMIN_KEY}` };
    const create = await fetch(`${base}/admin/users`, { method: 'POST', headers,
      body: JSON.stringify({ phone: who.phone, ...(who.email ? { email: who.email, email_confirm: true } : {}), phone_confirm: true }) }).catch(() => undefined);
    if (create?.ok) {
      const u = (await create.json()) as IdpUser;
      if (u?.id) return u.id;
    }
    // Already registered (an earlier, interrupted acceptance): find that identity; exact match only.
    if (create && (create.status === 422 || create.status === 409 || create.status === 400)) {
      for (const needle of [who.email, digits(who.phone)].filter(Boolean) as string[]) {
        const r = await fetch(`${base}/admin/users?per_page=50&filter=${encodeURIComponent(needle)}`, { headers }).catch(() => undefined);
        if (!r?.ok) continue;
        const body = (await r.json()) as { users?: IdpUser[] } | IdpUser[];
        const hit = (Array.isArray(body) ? body : body.users ?? [])
          .find((u) => (!!who.email && u.email?.toLowerCase() === who.email.toLowerCase()) || (!!u.phone && digits(u.phone) === digits(who.phone)));
        if (hit?.id) return hit.id;
      }
    }
    this.log.warn(`identity provider answered ${create?.status ?? 'no response'} while creating an invited identity`);
    throw new ServiceUnavailableException('could not prepare the sign-in for this invitation; try again shortly');
  }
}
