import 'server-only';
import { cookies } from 'next/headers';

/**
 * Server-side API client. The bearer token never reaches the browser:
 *  - production: the `herp_session` cookie (httpOnly) set by the sign-in flow
 *    (device-session token from POST /v1/auth/unlock);
 *  - development only: HERP_DEV_TOKEN, a token for a local API.
 * The active household is the `herp_household` cookie (validated by the API:
 * a household the user is not a member of resolves to nothing).
 */
export const API_URL = process.env.HERP_API_URL ?? 'http://localhost:4000';
export const HOUSEHOLD_COOKIE = 'herp_household';

export async function authToken(): Promise<string | null> {
  const c = (await cookies()).get('herp_session')?.value;
  if (c) return c;
  return process.env.NODE_ENV !== 'production' ? process.env.HERP_DEV_TOKEN ?? null : null;
}

export async function activeHouseholdCookie() { return (await cookies()).get(HOUSEHOLD_COOKIE)?.value ?? null; }

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

/**
 * The household a request works in: the switcher cookie if the user is a member there,
 * else their first household. Page and API routes use the same rule.
 */
export async function resolveHousehold(locale = 'ar'): Promise<{ id: string; households: Array<{ householdId: string; name: string; role: string }> } | null> {
  const me = await apiGet<{ households: Array<{ householdId: string; name: string; role: string }> }>('/v1/me', { locale });
  if (!me?.households?.length) return null;
  const wanted = await activeHouseholdCookie();
  return { id: me.households.find((h) => h.householdId === wanted)?.householdId ?? me.households[0]!.householdId, households: me.households };
}
