import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { OtpDeliveryService } from '../src/auth/otp-delivery.service';
import { base32Decode, hotp, totpStep } from '../src/auth/totp';
import { ServiceDb } from '../src/worker/service-db';
import { H1, H2, USERS, as, testEnv, token } from './helpers';

/**
 * Invitation-only accounts. A new account exists only after the household owner issued a
 * single-use, expiring invitation and its token was accepted; everything else is 403.
 * The identity provider's admin API (Supabase Auth) is a local stub that records what it is asked.
 */
const PHONE = '+966500004401', EMAIL = 'invited.cook@example.test';
const PHONE2 = '+966500004402';
let app: INestApplication, worker: ServiceDb, otp: OtpDeliveryService, idp: Server;
const idpCalls: Array<{ method: string; url: string; key?: string; body?: Record<string, unknown> }> = [];
const idpUsers: Array<{ id: string; phone?: string; email?: string }> = [];
let staffRole = '', staffRole2 = '', invitedUser = '', secret = '';
const http = () => request(app.getHttpServer());
const bearer = async (sub: string, household?: string) => ({ Authorization: `Bearer ${await token(sub)}`, 'Accept-Language': 'en', ...(household ? { 'X-Household-Id': household } : {}) });
const invite = async (who: string, household: string, body: Record<string, unknown>) => http().post('/v1/invitations').set(await as(who, household)).send(body);
const codeAt = () => hotp(base32Decode(secret), totpStep(Date.now()));

beforeAll(async () => {
  testEnv();
  process.env.AUTH_TOTP_KEY = randomBytes(32).toString('base64');
  process.env.SESSION_SIGNING_SECRET = randomBytes(32).toString('hex');
  idp = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, string> : undefined;
      idpCalls.push({ method: req.method!, url: req.url!, key: req.headers.apikey as string | undefined, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/auth/v1/admin/users') {
        if (idpUsers.some((u) => u.phone === body!.phone || (!!body!.email && u.email === body!.email))) { res.statusCode = 422; return res.end('{"error_code":"phone_exists"}'); }
        const u = { id: randomUUID(), phone: body!.phone, email: body!.email };
        idpUsers.push(u);
        return res.end(JSON.stringify(u));
      }
      if (req.method === 'GET' && req.url!.startsWith('/auth/v1/admin/users?')) {
        // Like GoTrue: phones are stored without "+", and the filter is a substring match.
        const f = new URL(req.url!, 'http://x').searchParams.get('filter') ?? '';
        return res.end(JSON.stringify({ users: idpUsers.filter((u) => u.email?.includes(f) || u.phone?.replace('+', '').includes(f)).map((u) => ({ ...u, phone: u.phone?.replace('+', '') })) }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  process.env.AUTH_ADMIN_URL = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/auth/v1`;
  process.env.AUTH_ADMIN_KEY = 'test-service-role-key-0123456789';
  process.env.PUBLIC_APP_URL = 'http://localhost:3000';
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await worker.run(async (tx) => {
    staffRole = (await tx.role.findFirstOrThrow({ where: { householdId: H1, systemRole: 'STAFF', isDefault: true } })).id;
    staffRole2 = (await tx.role.findFirstOrThrow({ where: { householdId: H2, systemRole: 'STAFF', isDefault: true } })).id;
  });
  app = await createApp(); await app.init();
  otp = app.get(OtpDeliveryService);
});
afterAll(async () => {
  await worker?.run(async (tx) => {
    const ids = idpUsers.map((u) => u.id);
    await tx.invitation.deleteMany({ where: { phone: { startsWith: '+9665000044' } } });
    await tx.membership.deleteMany({ where: { userId: { in: ids } } });
    await tx.user.deleteMany({ where: { id: { in: ids } } });
  });
  await app?.close(); await worker?.close();
  await new Promise((r) => idp?.close(r));
  for (const k of ['AUTH_TOTP_KEY', 'SESSION_SIGNING_SECRET', 'AUTH_ADMIN_URL', 'AUTH_ADMIN_KEY', 'PUBLIC_APP_URL']) delete process.env[k];
});

describe('no invitation, no account', () => {
  it('a signed-in identity nobody invited is refused everywhere with 403, onboarding included', async () => {
    const stranger = await bearer(randomUUID());
    for (const [method, path, body] of [['get', '/v1/auth/onboarding'], ['post', '/v1/auth/onboarding/phone', { phone: '+966500004499' }],
      ['post', '/v1/auth/onboarding/email', { email: 'stranger@example.test' }], ['post', '/v1/auth/onboarding/totp'],
      ['post', '/v1/auth/web/session', { code: '123456' }], ['get', '/v1/me'], ['get', '/v1/auth/devices']] as const) {
      const r = await http()[method](path).set(stranger).send(body);
      expect([path, r.status]).toEqual([path, 403]);
      expect(r.body.detail).toMatch(/access denied/i);
    }
    await http().get('/v1/staff').set({ ...stranger, 'X-Household-Id': H1 }).expect(403);
    expect(otp.outbox.some((m) => m.to === '+966500004499' || m.to === 'stranger@example.test')).toBe(false);
  });

  it('accepting without a token, or with a malformed or unknown one, is 403', async () => {
    for (const body of [undefined, {}, { token: '' }, { token: 'short' }, { token: 42 }, { token: randomBytes(32).toString('base64url') }, { token: "x' OR '1'='1".padEnd(40, 'x') }]) {
      for (const path of ['/v1/auth/invitations/accept', '/v1/auth/invitations/preview']) {
        const r = await http().post(path).send(body);
        expect([path, JSON.stringify(body), r.status]).toEqual([path, JSON.stringify(body), 403]);
        expect(r.body.detail).toMatch(/access denied/i);
      }
    }
    expect(idpCalls).toHaveLength(0); // nothing was created at the identity provider
  });
});

describe('only the household owner issues invitations', () => {
  it('EFA office admin, spouse and staff are refused; the other household\'s owner cannot reach this household', async () => {
    const body = { phone: PHONE, roleId: staffRole };
    for (const who of [USERS.efa, USERS.spouse, USERS.maid]) {
      expect((await invite(who, H1, body)).status).toBe(403);
      await http().get('/v1/invitations').set(await as(who, H1)).expect(403);
    }
    expect((await invite(USERS.head2, H1, body)).status).toBe(404);
    // …and an owner cannot invite into a role of another household.
    expect((await invite(USERS.head2, H2, body)).status).toBeGreaterThanOrEqual(403);
    await worker.run(async (tx) => { expect(await tx.invitation.count({ where: { phone: PHONE } })).toBe(0); });
  });

  it('validates the invitation: E.164 phone, at most 7 days', async () => {
    expect((await invite(USERS.head, H1, { phone: '0500004401', roleId: staffRole })).status).toBe(400);
    expect((await invite(USERS.head, H1, { phone: PHONE, roleId: staffRole, expiresInHours: 169 })).status).toBe(400);
  });
});

describe('accepting an invitation creates the account', () => {
  let tok = '', invitationId = '';

  it('the owner gets the token once; the database keeps only its hash', async () => {
    const r = await invite(USERS.head, H1, { phone: PHONE, email: EMAIL, roleId: staffRole, displayName: 'Invited cook', locale: 'en', expiresInHours: 48 });
    expect(r.status).toBe(201);
    tok = r.body.token; invitationId = r.body.id;
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.url).toBe(`http://localhost:3000/en/invite/${tok}`);
    await worker.run(async (tx) => {
      const row = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(row.tokenHash).toBe(createHash('sha256').update(tok).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(tok);
    });
    const list = (await http().get('/v1/invitations').set(await as(USERS.head, H1)).expect(200)).body.data;
    expect(list.find((i: { id: string }) => i.id === invitationId)).toMatchObject({ status: 'PENDING', phone: PHONE, role: { systemRole: 'STAFF' } });
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|token"/);
    // Not visible from the other household.
    expect((await http().get('/v1/invitations').set(await as(USERS.head2, H2)).expect(200)).body.data.some((i: { id: string }) => i.id === invitationId)).toBe(false);
    await http().delete(`/v1/invitations/${invitationId}`).set(await as(USERS.head2, H2)).expect(404);
  });

  it('preview shows the household and a masked address; it does not consume the token', async () => {
    const p = (await http().post('/v1/auth/invitations/preview').set('Accept-Language', 'en').send({ token: tok }).expect(200)).body;
    expect(p).toMatchObject({ household: 'Majid household', phone: expect.stringMatching(/^•+4401$/), email: 'i•••@example.test' });
    expect(idpCalls).toHaveLength(0);
  });

  it('accept: the identity is created at the provider with the invited phone / e-mail, the user and a pending membership in ours', async () => {
    const r = (await http().post('/v1/auth/invitations/accept').set('Accept-Language', 'en').send({ token: tok }).expect(201)).body;
    expect(r).toMatchObject({ accepted: true, household: 'Majid household' });
    expect(idpCalls).toEqual([{ method: 'POST', url: '/auth/v1/admin/users', key: 'test-service-role-key-0123456789',
      body: { phone: PHONE, email: EMAIL, email_confirm: true, phone_confirm: true } }]);
    invitedUser = idpUsers[0]!.id;
    await worker.run(async (tx) => {
      expect(await tx.user.findUniqueOrThrow({ where: { id: invitedUser } })).toMatchObject({ phone: PHONE, email: EMAIL, preferredLocale: 'en' });
      const m = await tx.membership.findMany({ where: { userId: invitedUser } });
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ householdId: H1, roleId: staffRole, status: 'INVITED', displayName: 'Invited cook' });
    });
  });

  it('the token is single use', async () => {
    expect((await http().post('/v1/auth/invitations/accept').send({ token: tok }).expect(403)).body.detail).toMatch(/access denied/i);
    await http().post('/v1/auth/invitations/preview').send({ token: tok }).expect(403);
    expect(idpCalls).toHaveLength(1);
    const list = (await http().get('/v1/invitations').set(await as(USERS.head, H1)).expect(200)).body.data;
    expect(list.find((i: { id: string }) => i.id === invitationId).status).toBe('ACCEPTED');
    await http().delete(`/v1/invitations/${invitationId}`).set(await as(USERS.head, H1)).expect(404); // accepted: nothing left to revoke
  });

  it('pending membership: onboarding is open, the household is not; messages carry the household\'s name', async () => {
    const h = await bearer(invitedUser);
    expect((await http().get('/v1/auth/onboarding').set(h).expect(200)).body).toMatchObject({ complete: false, next: 'phone' });
    await http().get('/v1/staff').set({ ...h, 'X-Household-Id': H1 }).expect(403); // onboarding first
    const p = (await http().post('/v1/auth/onboarding/phone').set(h).send({ phone: PHONE }).expect(201)).body;
    const sms = [...otp.outbox].reverse().find((m) => m.to === PHONE)!;
    expect(sms.text).toContain('Majid household'); expect(sms.text).not.toMatch(/EFA/);
    await http().post('/v1/auth/onboarding/phone/verify').set(h).send({ challengeId: p.challengeId, code: otp.lastCodeFor(PHONE) }).expect(201);
    const e = (await http().post('/v1/auth/onboarding/email').set(h).send({ email: EMAIL }).expect(201)).body;
    expect([...otp.outbox].reverse().find((m) => m.to === EMAIL)!.subject).toMatch(/^Majid household — /);
    await http().post('/v1/auth/onboarding/email/verify').set(h).send({ challengeId: e.challengeId, code: otp.lastCodeFor(EMAIL) }).expect(201);
    const t = (await http().post('/v1/auth/onboarding/totp').set(h).expect(201)).body;
    expect(t.issuer).toBe('Majid household');
    expect(t.otpauthUri).toContain('issuer=Majid%20household');
    secret = t.secret;
    await worker.run(async (tx) => { expect((await tx.membership.findFirstOrThrow({ where: { userId: invitedUser } })).status).toBe('INVITED'); });
  });

  it('finishing onboarding activates the membership: that household opens, the other one does not', async () => {
    const h = await bearer(invitedUser);
    expect((await http().post('/v1/auth/onboarding/totp/verify').set(h).send({ code: codeAt() }).expect(201)).body.complete).toBe(true);
    await worker.run(async (tx) => {
      const m = await tx.membership.findFirstOrThrow({ where: { userId: invitedUser } });
      expect(m.status).toBe('ACTIVE'); expect(m.joinedAt).toBeInstanceOf(Date);
    });
    const me = (await http().get('/v1/me').set(h).expect(200)).body;
    expect(me.households.map((x: { householdId: string }) => x.householdId)).toEqual([H1]);
    await http().get('/v1/members').set({ ...h, 'X-Household-Id': H1 }).expect(200);
    await http().get('/v1/members').set({ ...h, 'X-Household-Id': H2 }).expect(404);
    // A member who is not the owner cannot invite anyone either.
    await http().post('/v1/invitations').set({ ...h, 'X-Household-Id': H1 }).send({ phone: PHONE2, roleId: staffRole }).expect(403);
  });

  it('an existing account invited to a second household: no new identity; active only after the next full sign-in', async () => {
    const r = await invite(USERS.head2, H2, { phone: PHONE, roleId: staffRole2 });
    expect(r.status).toBe(201);
    await http().post('/v1/auth/invitations/accept').send({ token: r.body.token }).expect(201);
    expect(idpCalls).toHaveLength(1); // matched by phone: nothing asked of the identity provider
    const h = await bearer(invitedUser);
    await http().get('/v1/members').set({ ...h, 'X-Household-Id': H2 }).expect(404); // holding the link is not enough
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000); // an authenticator step not used yet
    const fresh = await bearer(invitedUser);
    await http().post('/v1/auth/web/session').set(fresh).send({ code: codeAt() }).expect(201);
    spy.mockRestore();
    await http().get('/v1/members').set({ ...h, 'X-Household-Id': H2 }).expect(200);
    // Already a member: a further invitation for the same person cannot be accepted (and stays unused).
    const again = await invite(USERS.head2, H2, { phone: PHONE, roleId: staffRole2 });
    expect((await http().post('/v1/auth/invitations/accept').send({ token: again.body.token }).expect(422)).body.detail).toMatch(/already a member/);
  });
});

describe('expired, revoked, and interrupted', () => {
  it('an expired invitation is refused', async () => {
    const r = await invite(USERS.head, H1, { phone: PHONE2, roleId: staffRole, expiresInHours: 1 });
    await worker.run(async (tx) => { await tx.invitation.update({ where: { id: r.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); });
    await http().post('/v1/auth/invitations/accept').send({ token: r.body.token }).expect(403);
    const list = (await http().get('/v1/invitations').set(await as(USERS.head, H1)).expect(200)).body.data;
    expect(list.find((i: { id: string }) => i.id === r.body.id).status).toBe('EXPIRED');
  });

  it('a revoked invitation is refused; only the owner revokes', async () => {
    const r = await invite(USERS.head, H1, { phone: PHONE2, roleId: staffRole });
    await http().delete(`/v1/invitations/${r.body.id}`).set(await as(USERS.efa, H1)).expect(403);
    await http().delete(`/v1/invitations/${r.body.id}`).set(await as(USERS.head, H1)).expect(200);
    await http().delete(`/v1/invitations/${r.body.id}`).set(await as(USERS.head, H1)).expect(404);
    await http().post('/v1/auth/invitations/accept').send({ token: r.body.token }).expect(403);
    await worker.run(async (tx) => { expect(await tx.user.count({ where: { phone: PHONE2 } })).toBe(0); });
    expect(idpCalls).toHaveLength(1);
  });

  it('an identity left at the provider by an interrupted acceptance is reused, not duplicated', async () => {
    const orphan = { id: randomUUID(), phone: PHONE2 };
    idpUsers.push(orphan); // exists at the provider, unknown to us: on its own it is refused
    await http().get('/v1/auth/onboarding').set(await bearer(orphan.id)).expect(403);
    const r = await invite(USERS.head, H1, { phone: PHONE2, roleId: staffRole });
    await http().post('/v1/auth/invitations/accept').send({ token: r.body.token }).expect(201);
    expect(idpCalls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /auth/v1/admin/users', 'GET /auth/v1/admin/users?per_page=50&filter=966500004402']);
    await worker.run(async (tx) => { expect((await tx.user.findFirstOrThrow({ where: { phone: PHONE2 } })).id).toBe(orphan.id); });
    await http().get('/v1/auth/onboarding').set(await bearer(orphan.id)).expect(200);
  });
});
