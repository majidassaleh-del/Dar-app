import 'server-only';
import { webConfig } from './config';

/**
 * The identity provider's three calls (Supabase Auth / GoTrue REST), made from the server only:
 * the browser never sees its tokens. In development scripts/dev-idp.mjs answers the same calls.
 */
export type Address = { kind: 'phone'; value: string } | { kind: 'email'; value: string };

/** "05xxxxxxxx", "5xxxxxxxx", "9665…", "+9665…" → +9665…; anything with "@" → lower-cased email. */
export function parseAddress(input: string): Address | null {
  const s = input.trim();
  if (s.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { kind: 'email', value: s.toLowerCase() } : null;
  const d = s.replace(/[\s\-()]/g, '').replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
  const e164 = d.startsWith('+') ? d : d.startsWith('00') ? `+${d.slice(2)}` : d.startsWith('05') ? `+966${d.slice(1)}` : d.startsWith('5') && d.length === 9 ? `+966${d}` : d.startsWith('966') ? `+${d}` : null;
  return e164 && /^\+[1-9]\d{7,14}$/.test(e164) ? { kind: 'phone', value: e164 } : null;
}

const call = (path: string, body: unknown, token?: string) => fetch(`${webConfig.authUrl}${path}`, {
  method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  headers: { 'Content-Type': 'application/json', ...(webConfig.authKey ? { apikey: webConfig.authKey } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

/** Sends a code. Existing users only (no sign-up from the web): unknown addresses get the same answer. */
export async function requestCode(a: Address): Promise<boolean> {
  const r = await call('/otp', a.kind === 'phone' ? { phone: a.value, create_user: false } : { email: a.value, create_user: false }).catch(() => null);
  // GoTrue answers an error for unknown users when create_user is false; treat it like success so addresses cannot be probed.
  return !!r && (r.ok || r.status === 400 || r.status === 422);
}

/** The provider's access token for a correct code, or null. */
export async function verifyCode(a: Address, code: string): Promise<string | null> {
  const r = await call('/verify', a.kind === 'phone' ? { type: 'sms', phone: a.value, token: code } : { type: 'email', email: a.value, token: code }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { access_token?: string };
  return j.access_token ?? null;
}

export async function signOutProvider(token: string) { await call('/logout', {}, token).catch(() => null); }
