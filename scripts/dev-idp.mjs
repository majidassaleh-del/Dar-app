#!/usr/bin/env node
// Local stand-in for the identity provider (Supabase Auth / GoTrue), for development only.
// It speaks the three calls the web app uses, so the web code is the same here and in production:
//   POST /auth/v1/otp      { phone } | { email }                      → sends a 6-digit code (printed here)
//   POST /auth/v1/verify   { type: 'sms'|'email', phone|email, token } → { access_token, refresh_token, ... }
//   POST /auth/v1/logout                                               → 204
// and the two admin calls the API uses while an invitation is accepted (the only way an identity is added):
//   POST /auth/v1/admin/users { phone, email? }   → { id, … }   (422 when the phone / e-mail exists)
//   GET  /auth/v1/admin/users?filter=…             → { users: [...] }
// As at a provider with sign-up disabled, /otp never creates a user.
// Access tokens are HS256 with AUTH_JWT_SECRET, which the API accepts outside production only.
// Users come from scripts/dev-idp-users.json ({ phone, email, id } per user). Unknown addresses get the
// same answer as known ones and simply never receive a code.
//   AUTH_JWT_SECRET=… node scripts/dev-idp.mjs        (port: DEV_IDP_PORT, default 9999)
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';

if (process.env.NODE_ENV === 'production') { console.error('dev-idp is for development only'); process.exit(1); }
const SECRET = process.env.AUTH_JWT_SECRET ?? 'dev-secret-dev-secret-dev-secret-0123';
const PORT = Number(process.env.DEV_IDP_PORT ?? 9999);
const USERS = JSON.parse(readFileSync(new URL('./dev-idp-users.json', import.meta.url), 'utf8'));
const CODES_FILE = process.env.DEV_IDP_CODES_FILE; // optional: append "address code" lines (for scripted checks)
const pending = new Map(); // address → { code, exp, tries }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub) => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'authenticated', role: 'authenticated', iat: now, auth_time: now, exp: now + 3600, iss: 'dev-idp' })}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const addressOf = (b) => (b.phone ? String(b.phone).trim() : b.email ? String(b.email).trim().toLowerCase() : null);
const userOf = (addr) => USERS.find((u) => u.phone === addr || (u.email ?? '').toLowerCase() === addr);
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid json' }); }
  if (req.method === 'POST' && req.url === '/auth/v1/otp') {
    const addr = addressOf(b);
    if (!addr) return send(res, 400, { error: 'phone or email required' });
    if (userOf(addr)) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      pending.set(addr, { code, exp: Date.now() + 5 * 60_000, tries: 0 });
      console.log(`[dev-idp] code for ${addr}: ${code}`);
      if (CODES_FILE) appendFileSync(CODES_FILE, `${addr} ${code}\n`);
    }
    return send(res, 200, {});
  }
  if (req.method === 'POST' && req.url === '/auth/v1/verify') {
    const addr = addressOf(b), p = addr && pending.get(addr), u = addr && userOf(addr);
    if (!p || !u || p.exp < Date.now() || p.tries >= 5) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has expired or is invalid' });
    if (String(b.token) !== p.code) { p.tries++; return send(res, 400, { error: 'invalid_grant', error_description: 'Token has expired or is invalid' }); }
    pending.delete(addr);
    return send(res, 200, { access_token: jwt(u.id), token_type: 'bearer', expires_in: 3600, refresh_token: randomBytes(24).toString('base64url'), user: { id: u.id } });
  }
  if (req.method === 'POST' && req.url === '/auth/v1/logout') return send(res, 204);
  if (req.method === 'POST' && req.url === '/auth/v1/admin/users') {
    const phone = b.phone ? String(b.phone).trim() : undefined, email = b.email ? String(b.email).trim().toLowerCase() : undefined;
    if (!phone && !email) return send(res, 400, { error: 'phone or email required' });
    if ((phone && userOf(phone)) || (email && userOf(email))) return send(res, 422, { error_code: phone && userOf(phone) ? 'phone_exists' : 'email_exists' });
    const u = { id: randomUUID(), phone, email };
    USERS.push(u);
    console.log(`[dev-idp] identity created for ${phone ?? email} (invitation)`);
    return send(res, 200, u);
  }
  if (req.method === 'GET' && req.url.startsWith('/auth/v1/admin/users')) {
    const f = (new URL(req.url, 'http://x').searchParams.get('filter') ?? '').toLowerCase();
    return send(res, 200, { users: USERS.filter((u) => (u.email ?? '').toLowerCase().includes(f) || (u.phone ?? '').replace('+', '').includes(f)) });
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`[dev-idp] listening on http://localhost:${PORT}/auth/v1 (${USERS.length} users)`));
