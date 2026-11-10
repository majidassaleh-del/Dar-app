'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiPublic, apiSend } from './api';
import { webConfig } from './config';
import { loadSession } from './dashboard';
import { parseAddress } from './idp';

/**
 * Invitations. Issuing and revoking run under the owner's session (the API refuses anyone
 * else); accepting needs no session, only the token from the link. A new link is shown briefly:
 * it travels to the next page in a two-minute httpOnly cookie and is never stored readable.
 */
const NEW_LINK = 'herp_invite_new';
const loc = (f: FormData) => { const l = String(f.get('locale') ?? 'ar'); return /^[a-z]{2}$/.test(l) ? l : 'ar'; };
const LOCALES = ['ar', 'en', 'hi', 'tl', 'am', 'bn'];

export async function createInvitation(f: FormData) {
  const l = loc(f);
  const back = (e?: string): never => redirect(`/${l}/invitations${e ? `?e=${e}` : '?created=1'}`);
  const s = await loadSession(l);
  if (!s.opts) return back('failed');
  const rawPhone = String(f.get('phone') ?? '').trim();
  const phone = rawPhone ? parseAddress(rawPhone) : null;
  if (rawPhone && (!phone || phone.kind !== 'phone')) return back('phone');
  const rawEmail = String(f.get('email') ?? '').trim();
  const email = rawEmail ? parseAddress(rawEmail) : null;
  if (rawEmail && (!email || email.kind !== 'email')) return back('email');
  if (!phone && !email) return back('contact');
  const roleId = String(f.get('roleId') ?? ''), name = String(f.get('name') ?? '').trim().slice(0, 80), lang = String(f.get('language') ?? l);
  const hours = Number(f.get('hours') ?? 72);
  const r = await apiSend<{ path?: string; url?: string | null; expiresAt?: string }>('POST', '/v1/invitations', s.opts, {
    ...(phone ? { phone: phone.value } : {}), ...(email ? { email: email.value } : {}), roleId, ...(name ? { displayName: name } : {}),
    locale: LOCALES.includes(lang) ? lang : l, expiresInHours: [24, 72, 168].includes(hours) ? hours : 72 });
  if (!r.ok || !r.body.path) return back(r.status === 403 ? 'owner' : 'failed');
  (await cookies()).set(NEW_LINK, JSON.stringify({ path: r.body.path, url: r.body.url ?? null, to: phone?.value ?? email!.value }),
    { httpOnly: true, sameSite: 'lax', secure: webConfig.secureCookies, path: `/${l}/invitations`, maxAge: 120 });
  revalidatePath(`/${l}/invitations`);
  return back();
}

export async function revokeInvitation(f: FormData) {
  const l = loc(f), id = String(f.get('id') ?? '');
  const s = await loadSession(l);
  if (s.opts && /^[0-9a-f-]{36}$/.test(id)) await apiSend('DELETE', `/v1/invitations/${id}`, s.opts);
  revalidatePath(`/${l}/invitations`);
  redirect(`/${l}/invitations`);
}

/** The link just created, for the two minutes its cookie lives (null afterwards). */
export async function newInvitationLink(): Promise<{ path: string; url: string | null; to: string } | null> {
  try { return JSON.parse((await cookies()).get(NEW_LINK)?.value ?? 'null'); } catch { return null; }
}

/** The button on the invitation page: consume the token, then on to sign-in. */
export async function acceptInvitation(f: FormData) {
  const l = loc(f), token = String(f.get('token') ?? '');
  const r = await apiPublic<{ accepted?: boolean }>('/v1/auth/invitations/accept', { token }, l);
  if (r.status === 201 && r.body.accepted) redirect(`/${l}/sign-in?e=invited`);
  redirect(`/${l}/invite/${encodeURIComponent(token)}?e=${r.status === 403 ? 'denied' : r.status === 422 ? 'member' : 'unavailable'}`);
}

/** Landing page: a pasted invitation link or bare token → its invitation page (which answers "access denied" unless the token is live). */
export async function openInvitation(f: FormData) {
  const l = loc(f), raw = String(f.get('token') ?? '').trim();
  const token = (raw.match(/\/invite\/([A-Za-z0-9_-]{8,128})/)?.[1] ?? raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  if (!token) redirect(`/${l}?e=token`);
  redirect(`/${l}/invite/${token}`);
}
