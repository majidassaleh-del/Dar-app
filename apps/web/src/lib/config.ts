/**
 * Deployment settings for the web app, all from environment variables (see apps/web/.env.example).
 * Read on the server only; nothing here is a NEXT_PUBLIC_ value.
 *
 * Production on the SaaS domain, for example:
 *   app.darhub.net         → the app with the household switcher
 *   efa.darhub.net         → pinned to the household whose slug is "efa"
 *   api.darhub.net         → HERP_API_URL
 */
const env = process.env;
const list = (s: string | undefined, d: string) => (s ?? d).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export const webConfig = {
  /** Base URL of the API, reached server-to-server (no CORS involved). */
  apiUrl: (env.HERP_API_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
  /** Bearer token cookie (httpOnly), set by the sign-in flow. In production prefer `__Secure-herp_session`. */
  sessionCookie: env.HERP_SESSION_COOKIE ?? 'herp_session',
  /** The household chosen in the switcher (httpOnly). */
  householdCookie: env.HERP_HOUSEHOLD_COOKIE ?? 'herp_household',
  /** Cookie Domain attribute, e.g. `.darhub.net` so one sign-in covers every tenant subdomain. Unset = host-only. */
  cookieDomain: env.HERP_COOKIE_DOMAIN?.trim() || undefined,
  /** `Secure` cookies: always in production; HERP_COOKIE_SECURE=true forces it elsewhere (https staging). */
  secureCookies: env.NODE_ENV === 'production' || env.HERP_COOKIE_SECURE === 'true',
  /** Tenant subdomains live under this domain (darhub.net). Unset = no subdomain routing. */
  tenantBaseDomain: env.HERP_TENANT_BASE_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '') || null,
  /** Subdomains that are never a household slug. */
  reservedSubdomains: new Set(list(env.HERP_TENANT_RESERVED, 'app,www,api,admin,auth,static,cdn,mail,status')),
  /** Identity provider (Supabase Auth / GoTrue) base URL and public key, e.g. https://<project>.supabase.co/auth/v1. */
  authUrl: (env.HERP_AUTH_URL ?? 'http://localhost:9999/auth/v1').replace(/\/+$/, ''),
  authKey: env.HERP_AUTH_KEY ?? '',
  /** Show the labelled sample instead of the sign-in page when nobody is signed in (demos only). */
  demo: env.HERP_DEMO === 'true',
  /** The dev token (local API only) is never honoured in production builds. */
  devToken: env.NODE_ENV !== 'production' ? env.HERP_DEV_TOKEN ?? null : null,
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The household slug a Host header names: `efa.darhub.net` → "efa" when the base domain is
 * darhub.net. Null for the apex, reserved names (app, www, api …), nested labels and other hosts.
 * This only *selects* a household: the API still requires an active membership in it.
 */
export function tenantSlugFromHost(host: string | null | undefined, base = webConfig.tenantBaseDomain,
                                   reserved = webConfig.reservedSubdomains): string | null {
  if (!host || !base) return null;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name.endsWith(`.${base}`)) return null;
  const label = name.slice(0, -(base.length + 1));
  return SLUG.test(label) && !reserved.has(label) ? label : null;
}

/** Origin of a household's subdomain, keeping the scheme and port the user is on. */
export function tenantOrigin(slug: string, host: string, base = webConfig.tenantBaseDomain): string | null {
  if (!base || !SLUG.test(slug)) return null;
  const port = /:(\d+)$/.exec(host)?.[1];
  const scheme = webConfig.secureCookies ? 'https' : 'http';
  return `${scheme}://${slug}.${base}${port ? `:${port}` : ''}`;
}
