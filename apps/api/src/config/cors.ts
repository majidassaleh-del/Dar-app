/**
 * Browser origins allowed to call the API (CORS_ORIGINS, comma-separated).
 *
 *   https://darerp.net,https://app.darerp.net,https://*.darerp.net
 *
 * An entry is either an exact origin or a one-label wildcard (`https://*.darerp.net`
 * matches `https://efa.darerp.net`, not `https://a.b.darerp.net` and not the apex).
 * A bare `*` is refused: tenant data must never be readable from an arbitrary site.
 * Server-to-server calls (the web app's server components) and the mobile app send
 * no Origin and are unaffected.
 */
const ENTRY = /^(https?):\/\/(\*\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(:\d{1,5})?$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseCorsOrigins(spec: string | undefined): string[] {
  return (spec ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
}

/** Why an entry is not acceptable, or null when it is. */
export function corsEntryError(entry: string, production: boolean): string | null {
  const m = ENTRY.exec(entry);
  if (!m) return `"${entry}" is not an origin (scheme://host[:port], optionally https://*.domain)`;
  if (production && m[1] !== 'https') return `"${entry}" must use https in production`;
  // *.localhost (efa.localhost:3000) is the local stand-in for tenant subdomains; never in production.
  if (m[2] && !m[3]!.includes('.') && (production || m[3] !== 'localhost')) return `"${entry}": a wildcard needs a registrable domain (https://*.example.com)`;
  return null;
}

export function corsMatcher(entries: string[]): (origin: string) => boolean {
  const res = entries.map((e) => {
    const m = ENTRY.exec(e)!;
    return new RegExp(`^${m[1]}://${m[2] ? `${LABEL}\\.` : ''}${esc(m[3]!)}${esc(m[4] ?? '')}$`);
  });
  return (origin) => res.some((r) => r.test(origin.toLowerCase()));
}

/** Request headers browsers may send; X-Request-Id is echoed back for support tickets. */
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'Accept-Language', 'X-Household-Id', 'X-Request-Id', 'Idempotency-Key'];
