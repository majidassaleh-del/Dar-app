import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { tenantSlugFromHost, webConfig } from './config';

/**
 * Server-side API client. The bearer token never reaches the browser:
 *  - production: the session cookie (httpOnly, HERP_SESSION_COOKIE) set by the sign-in flow
 *    (device-session token from POST /v1/auth/unlock);
 *  - development only: HERP_DEV_TOKEN, a token for a local API.
 * The active household is the tenant subdomain (efa.darerp.net) or, on the app host, the
 * switcher cookie. Either way the API decides: it requires an active membership.
 */
export const API_URL = webConfig.apiUrl;
export const HOUSEHOLD_COOKIE = webConfig.householdCookie;

export async function authToken(): Promise<string | null> {
  return (await cookies()).get(webConfig.sessionCookie)?.value ?? webConfig.devToken;
}

export async function activeHouseholdCookie() { return (await cookies()).get(HOUSEHOLD_COOKIE)?.value ?? null; }

/** Host the request came in on (the reverse proxy must preserve Host). */
export async function requestHost() { return (await headers()).get('host') ?? ''; }

/** The household slug of the tenant subdomain this request is on, or null on the app host. */
export async function currentTenantSlug() { return tenantSlugFromHost(await requestHost()); }

/** GET from the API; null when the API is not configured, unreachable or refuses. */
export async function apiGet<T>(path: string, opts: { household?: string | null; locale?: string } = {}): Promise<T | null> {
  const token = await authToken();
  if (!token) return null;
  let signedOut = false;
  try {
    const r = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Language': opts.locale ?? 'ar', ...(opts.household ? { 'X-Household-Id': opts.household } : {}) },
      cache: 'no-store', signal: AbortSignal.timeout(4000),
    });
    if (r.status === 401) signedOut = true;
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
  finally { if (signedOut) redirect(`/${opts.locale ?? 'ar'}/sign-in?expired=1`); }
}

export interface MeHousehold { householdId: string; slug: string; name: string; role: string }

/** Any write under the user's session; returns status + JSON (or the problem detail) instead of throwing. */
export async function apiSend<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, opts: { household: string; locale?: string },
  body?: unknown, raw?: Buffer): Promise<{ ok: boolean; status: number; body: T; detail?: string }> {
  const token = await authToken();
  if (!token) return { ok: false, status: 401, body: {} as T, detail: 'signed out' };
  const r = await fetch(`${API_URL}${path}`, {
    method, cache: 'no-store', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': opts.locale ?? 'ar', 'X-Household-Id': opts.household,
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!r) return { ok: false, status: 503, body: {} as T, detail: 'the service is not responding' };
  const j = (await r.json().catch(() => ({}))) as T & { detail?: string | string[] };
  return { ok: r.ok, status: r.status, body: j, detail: Array.isArray(j?.detail) ? j.detail.join(' · ') : j?.detail };
}

/** Upload a file the three-step way (declare, send bytes, sha256 checked by the API); returns its id. */
export async function apiUpload(file: File, meta: { entityType: string; entityId: string; staffId?: string }, opts: { household: string; locale?: string }) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const { createHash } = await import('node:crypto');
  const d = await apiSend<{ id?: string; upload?: { url: string } }>('POST', '/v1/files', opts, { ...meta, fileName: file.name.slice(0, 200) || 'upload',
    mimeType: file.type || 'application/octet-stream', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  if (!d.ok || !d.body.id || !d.body.upload) return { id: null, detail: d.detail };
  const u = await apiSend('PUT', d.body.upload.url, opts, undefined, bytes);
  return u.ok ? { id: d.body.id, detail: undefined } : { id: null, detail: u.detail };
}

/**
 * Sign-in steps: call the API with the identity provider's token (not a session yet), no household.
 * Returns the status and JSON so the caller can tell the user what to do next.
 */
export async function apiAuth<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown, locale = 'ar'): Promise<{ status: number; body: T }> {
  const r = await fetch(`${API_URL}${path}`, {
    method, cache: 'no-store', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': locale, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!r) return { status: 503, body: {} as T };
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

/** POST to the API under the user's session (server actions only). Throws with the API's problem detail. */
export async function apiPost<T>(path: string, body: unknown, opts: { household: string; locale?: string }): Promise<T> {
  const token = await authToken();
  if (!token) throw new Error('not signed in');
  const r = await fetch(`${API_URL}${path}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Language': opts.locale ?? 'ar', 'X-Household-Id': opts.household },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { detail?: string }).detail ?? `HTTP ${r.status}`);
  return j as T;
}

/**
 * The household a request works in, one rule for pages and API routes:
 *  - on a tenant subdomain, that household, and nothing if the user is not a member there
 *    (never a silent fall-back to another household);
 *  - on the app host, the switcher cookie if the user is a member there, else their first household.
 */
export async function resolveHousehold(locale = 'ar'): Promise<{ id: string; pinned: boolean; households: MeHousehold[] } | null> {
  const me = await apiGet<{ households: MeHousehold[] }>('/v1/me', { locale });
  if (!me?.households?.length) return null;
  const slug = await currentTenantSlug();
  if (slug) {
    const h = me.households.find((x) => x.slug === slug);
    return h ? { id: h.householdId, pinned: true, households: me.households } : null;
  }
  const wanted = await activeHouseholdCookie();
  return { id: me.households.find((h) => h.householdId === wanted)?.householdId ?? me.households[0]!.householdId, pinned: false, households: me.households };
}
