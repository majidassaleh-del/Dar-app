'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiAuth, currentTenantSlug } from './api';
import { webConfig } from './config';
import { parseAddress, requestCode, signOutProvider, verifyCode, type Address } from './idp';

/**
 * Web sign-in, as server actions:
 *   1. address (phone or email) → the identity provider sends a code;
 *   2. code → provider token (kept 10 minutes, httpOnly) → where the user stands in onboarding;
 *   3. first time only: verify phone, email and enrol an authenticator (the API's onboarding);
 *   4. authenticator code → POST /v1/auth/web/session → session cookie until 04:00 Riyadh.
 * Nothing here is readable by page scripts; every step is re-checked by the API.
 */
const STEP_COOKIE = 'herp_signin', IDP_COOKIE = 'herp_idp', SETUP_COOKIE = 'herp_setup', TOTP_COOKIE = 'herp_totp', ENTRY_COOKIE = 'herp_entry';
/** Which door of the landing page this sign-in came through. The API enforces the owner door. */
async function entry(): Promise<'owner' | 'member'> { return (await cookies()).get(ENTRY_COOKIE)?.value === 'owner' ? 'owner' : 'member'; }
const short = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: webConfig.secureCookies, path: '/', maxAge: 600, domain: webConfig.cookieDomain });
const loc = (f: FormData) => { const l = String(f.get('locale') ?? 'ar'); return /^[a-z]{2}$/.test(l) ? l : 'ar'; };
const go = (l: string, step: string, err?: string): never => redirect(`/${l}/sign-in?step=${step}${err ? `&e=${err}` : ''}`);

async function address(): Promise<Address | null> {
  const raw = (await cookies()).get(STEP_COOKIE)?.value;
  if (!raw) return null;
  const [kind, ...v] = raw.split(':');
  return kind === 'phone' || kind === 'email' ? { kind, value: v.join(':') } : null;
}
async function idpToken() { return (await cookies()).get(IDP_COOKIE)?.value ?? null; }

type Onboarding = { complete: boolean; next: 'phone' | 'email' | 'authenticator' | 'device'; authenticator: { enrolled: boolean; verified: boolean } };
/** After the provider sign-in: send the user to the first thing still missing. */
async function nextStep(l: string, token: string): Promise<never> {
  const s = await apiAuth<Onboarding>('GET', '/v1/auth/onboarding', token, undefined, l);
  // 403: the provider knows this identity but nobody invited it (invitation-only accounts).
  if (s.status === 403) { (await cookies()).delete({ name: IDP_COOKIE, path: '/', domain: webConfig.cookieDomain }); return go(l, 'address', 'denied'); }
  if (s.status !== 200) return go(l, 'address', s.status === 401 ? 'expired' : 'unavailable');
  if (s.body.next === 'phone') return go(l, 'setup-phone');
  if (s.body.next === 'email') return go(l, 'setup-email');
  if (s.body.next === 'authenticator' || !s.body.authenticator.enrolled) return go(l, 'enrol');
  return go(l, 'totp');
}

export async function startSignIn(f: FormData) {
  const l = loc(f);
  const a = parseAddress(String(f.get('address') ?? ''));
  if (!a) return go(l, 'address', 'address');
  if (!(await requestCode(a))) return go(l, 'address', 'unavailable');
  (await cookies()).set(ENTRY_COOKIE, f.get('as') === 'owner' ? 'owner' : 'member', { ...short(), maxAge: 1800 });
  (await cookies()).set(STEP_COOKIE, `${a.kind}:${a.value}`, short());
  return go(l, 'code');
}

export async function verifySignIn(f: FormData) {
  const l = loc(f);
  const a = await address();
  if (!a) return go(l, 'address', 'expired');
  const code = String(f.get('code') ?? '').replace(/\D/g, '');
  const token = code.length === 6 ? await verifyCode(a, code) : null;
  if (!token) return go(l, 'code', 'code');
  (await cookies()).set(IDP_COOKIE, token, short());
  return nextStep(l, token);
}

export async function resendCode(f: FormData) {
  const l = loc(f);
  const a = await address();
  if (!a) return go(l, 'address', 'expired');
  await requestCode(a);
  return go(l, 'code', 'resent');
}

/** First-time setup: phone and email are verified by the API itself (its own codes). */
export async function setupStart(f: FormData) {
  const l = loc(f), kind = String(f.get('kind')) === 'email' ? 'email' : 'phone';
  const token = await idpToken();
  if (!token) return go(l, 'address', 'expired');
  const a = parseAddress(String(f.get('address') ?? ''));
  if (!a || a.kind !== kind) return go(l, `setup-${kind}`, 'address');
  const r = await apiAuth<{ challengeId?: string }>('POST', `/v1/auth/onboarding/${kind}`, token, kind === 'phone' ? { phone: a.value } : { email: a.value }, l);
  if (r.status === 429) return go(l, `setup-${kind}`, 'tooMany');
  if (!r.body.challengeId) return go(l, `setup-${kind}`, r.status === 401 ? 'expired' : 'unavailable');
  (await cookies()).set(SETUP_COOKIE, `${kind}:${r.body.challengeId}:${a.value}`, short());
  return go(l, `setup-${kind}-code`);
}

export async function setupVerify(f: FormData) {
  const l = loc(f);
  const token = await idpToken();
  const raw = (await cookies()).get(SETUP_COOKIE)?.value ?? '';
  const [kind, challengeId] = raw.split(':');
  if (!token || !challengeId || (kind !== 'phone' && kind !== 'email')) return go(l, 'address', 'expired');
  const code = String(f.get('code') ?? '').replace(/\D/g, '');
  const r = await apiAuth('POST', `/v1/auth/onboarding/${kind}/verify`, token, { challengeId, code }, l);
  if (r.status >= 400) return go(l, `setup-${kind}-code`, 'code');
  (await cookies()).delete(SETUP_COOKIE);
  return nextStep(l, token);
}

/** Authenticator enrolment: the API returns the otpauth URI (shown as a QR code for 10 minutes). */
export async function enrolStart(f: FormData) {
  const l = loc(f);
  const token = await idpToken();
  if (!token) return go(l, 'address', 'expired');
  const r = await apiAuth<{ otpauthUri?: string }>('POST', '/v1/auth/onboarding/totp', token, undefined, l);
  if (!r.body.otpauthUri) return go(l, 'enrol', r.status === 401 ? 'expired' : 'unavailable');
  (await cookies()).set(TOTP_COOKIE, r.body.otpauthUri, short());
  return go(l, 'enrol-scan');
}

export async function enrolConfirm(f: FormData) {
  const l = loc(f);
  const token = await idpToken();
  if (!token) return go(l, 'address', 'expired');
  const code = String(f.get('code') ?? '').replace(/\D/g, '');
  const r = await apiAuth('POST', '/v1/auth/onboarding/totp/verify', token, { code }, l);
  if (r.status === 429) return go(l, 'enrol-scan', 'locked');
  if (r.status >= 400) return go(l, 'enrol-scan', 'code');
  (await cookies()).delete(TOTP_COOKIE);
  return go(l, 'totp', 'enrolled');
}

export async function finishSignIn(f: FormData) {
  const l = loc(f);
  const token = await idpToken();
  if (!token) return go(l, 'address', 'expired');
  const code = String(f.get('code') ?? '').replace(/\D/g, '');
  const door = await entry();
  const r = await apiAuth<{ token?: string; expiresAt?: string }>('POST', '/v1/auth/web/session', token, { code, entry: door }, l);
  if (r.status === 401) return go(l, 'address', 'expired');
  if (r.status === 403 && door === 'owner') { // signed in correctly, but heads no household: this door stays shut
    const jar = await cookies();
    for (const c of [STEP_COOKIE, IDP_COOKIE, SETUP_COOKIE, TOTP_COOKIE, ENTRY_COOKIE]) jar.delete(c);
    await signOutProvider(token);
    redirect(`/${l}/sign-in?as=member&e=notOwner`);
  }
  if (r.status === 429) return go(l, 'totp', 'locked');
  if (r.status === 422) return go(l, 'totp', 'used');
  if (!r.body.token || !r.body.expiresAt) return go(l, 'totp', r.status === 400 ? 'code' : 'unavailable');
  const jar = await cookies();
  jar.set(webConfig.sessionCookie, r.body.token, { httpOnly: true, sameSite: 'lax', secure: webConfig.secureCookies, path: '/', domain: webConfig.cookieDomain, expires: new Date(r.body.expiresAt) });
  for (const c of [STEP_COOKIE, IDP_COOKIE, SETUP_COOKIE, TOTP_COOKIE, ENTRY_COOKIE]) jar.delete(c);
  // Through the owner door, open the household they own (they may also be a member elsewhere).
  if (door === 'owner' && !(await currentTenantSlug())) {
    const me = await apiAuth<{ households?: Array<{ householdId: string; systemRole: string }> }>('GET', '/v1/me', r.body.token, undefined, l);
    const own = me.body.households?.find((h) => h.systemRole === 'HOUSEHOLD_HEAD');
    if (own) jar.set(webConfig.householdCookie, own.householdId, { httpOnly: true, sameSite: 'lax', secure: webConfig.secureCookies, path: '/', domain: webConfig.cookieDomain, maxAge: 31_536_000 });
  }
  await signOutProvider(token); // the provider session is no longer needed: the browser now holds only the day's session
  redirect(`/${l}`);
}

export async function signOut(f: FormData) {
  const l = loc(f);
  const jar = await cookies();
  const idp = jar.get(IDP_COOKIE)?.value;
  if (idp) await signOutProvider(idp);
  for (const c of [webConfig.sessionCookie, STEP_COOKIE, IDP_COOKIE, SETUP_COOKIE, TOTP_COOKIE, ENTRY_COOKIE]) jar.delete({ name: c, path: '/', domain: webConfig.cookieDomain });
  redirect(`/${l}/sign-in?e=signedOut`);
}

/** What the sign-in page may show about the current attempt (masked address, QR URI). */
export async function signInState() {
  const jar = await cookies();
  const a = await address();
  const setup = jar.get(SETUP_COOKIE)?.value?.split(':') ?? [];
  return {
    address: a ? (a.kind === 'phone' ? `${a.value.slice(0, 4)}•••${a.value.slice(-3)}` : a.value.replace(/^(.).*(@.*)$/, '$1•••$2')) : null,
    addressKind: a?.kind ?? null,
    rawPhone: a?.kind === 'phone' ? a.value : null, rawEmail: a?.kind === 'email' ? a.value : null,
    setupTo: setup[2] ?? null,
    otpauthUri: jar.get(TOTP_COOKIE)?.value ?? null,
    hasProviderToken: !!jar.get(IDP_COOKIE)?.value,
    entry: jar.get(ENTRY_COOKIE)?.value === 'owner' ? 'owner' as const : jar.get(ENTRY_COOKIE)?.value === 'member' ? 'member' as const : null,
  };
}
