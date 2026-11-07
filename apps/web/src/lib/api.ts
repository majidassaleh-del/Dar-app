import 'server-only';
import { cookies, headers } from 'next/headers';
import { tenantSlugFromHost, webConfig } from './config';

/**
 * Server-side API client. The bearer token never reaches the browser:
 *  - production: the session cookie (httpOnly, HERP_SESSION_COOKIE) set by the sign-in flow
 *    (device-session token from POST /v1/auth/unlock);
 *  - development only: HERP_DEV_TOKEN, a token for a local API.
 * The active household is the tenant subdomain (efa.darhub.net) or, on the app host, the
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
  try {
    const r = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Language': opts.locale ?? 'ar', ...(opts.household ? { 'X-Household-Id': opts.household } : {}) },
      cache: 'no-store', signal: AbortSignal.timeout(4000),
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

export interface MeHousehold { householdId: string; slug: string; name: string; role: string }

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
