import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { OtpDeliveryService } from '../src/auth/otp-delivery.service';
import { base32Decode, hotp, totpStep } from '../src/auth/totp';
import { ServiceDb } from '../src/worker/service-db';
import { H1, H2, testEnv } from './helpers';

/**
 * Web sign-in: identity-provider sign-in (fresh) + authenticator code → a browser session
 * that satisfies the device-session requirement, until 04:00 Riyadh.
 */
const WEB_USER = 'a0000000-0000-0000-0000-00000000c0de';
const LATE_USER = 'a0000000-0000-0000-0000-00000000c0df';
let app: INestApplication, enforced: INestApplication, worker: ServiceDb, otp: OtpDeliveryService;
let secret = '';
const http = (a: INestApplication = app) => request(a.getHttpServer());
const idp = async (sub = WEB_USER, ageSeconds = 0) => ({
  Authorization: `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
    .setIssuedAt(Math.floor(Date.now() / 1000) - ageSeconds).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET!))}`,
});
const codeAt = () => hotp(base32Decode(secret), totpStep(Date.now()));

beforeAll(async () => {
  testEnv();
  process.env.AUTH_TOTP_KEY = randomBytes(32).toString('base64');
  process.env.SESSION_SIGNING_SECRET = randomBytes(32).toString('hex');
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await worker.run(async (tx) => {
    for (const id of [WEB_USER, LATE_USER]) await tx.user.upsert({ where: { id }, create: { id, fullNameI18n: { en: 'Web user' }, preferredLocale: 'en' }, update: {} });
    // Members of the other household only: admitted, but strangers to H1.
    const role = await tx.role.findFirstOrThrow({ where: { householdId: H2, systemRole: 'STAFF' } });
    for (const userId of [WEB_USER, LATE_USER]) await tx.membership.create({ data: { householdId: H2, userId, roleId: role.id, status: 'ACTIVE' } });
  });
  app = await createApp(); await app.init();
  otp = app.get(OtpDeliveryService);
  process.env.AUTH_REQUIRE_DEVICE_SESSION = 'true';
  enforced = await createApp(); await enforced.init();
  delete process.env.AUTH_REQUIRE_DEVICE_SESSION;
  // Onboard WEB_USER through the real endpoints.
  const h = await idp();
  const p = (await http().post('/v1/auth/onboarding/phone').set(h).send({ phone: '+966500000777' }).expect(201)).body;
  await http().post('/v1/auth/onboarding/phone/verify').set(h).send({ challengeId: p.challengeId, code: otp.lastCodeFor('+966500000777') }).expect(201);
  const e = (await http().post('/v1/auth/onboarding/email').set(h).send({ email: 'web.user@example.test' }).expect(201)).body;
  await http().post('/v1/auth/onboarding/email/verify').set(h).send({ challengeId: e.challengeId, code: otp.lastCodeFor('web.user@example.test') }).expect(201);
  secret = (await http().post('/v1/auth/onboarding/totp').set(h).expect(201)).body.secret;
  await http().post('/v1/auth/onboarding/totp/verify').set(h).send({ code: codeAt() }).expect(201);
});
afterAll(async () => {
  await worker?.run(async (tx) => { await tx.membership.deleteMany({ where: { userId: { in: [WEB_USER, LATE_USER] } } }); await tx.user.deleteMany({ where: { id: { in: [WEB_USER, LATE_USER] } } }); });
  await app?.close(); await enforced?.close(); await worker?.close();
  delete process.env.AUTH_TOTP_KEY; delete process.env.SESSION_SIGNING_SECRET;
});

describe('web session: fresh sign-in + authenticator code', () => {
  it('refuses a user who has not finished onboarding', async () => {
    expect((await http().post('/v1/auth/web/session').set(await idp(LATE_USER)).send({ code: '123456' }).expect(403)).body.detail).toMatch(/onboarding/);
  });

  it('refuses a sign-in older than 10 minutes, and a wrong code', async () => {
    expect((await http().post('/v1/auth/web/session').set(await idp(WEB_USER, 900)).send({ code: '123456' }).expect(401)).body.detail).toMatch(/sign in again/);
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 30_000);
    const wrong = String((Number(codeAt()) + 1) % 1_000_000).padStart(6, '0');
    await http().post('/v1/auth/web/session').set(await idp()).send({ code: wrong }).expect(400);
    spy.mockRestore();
  });

  it('issues a browser session that passes the device-session requirement until 04:00 Riyadh', async () => {
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 60_000); // a step not used before
    const s = (await http(enforced).post('/v1/auth/web/session').set(await idp()).send({ code: codeAt() }).expect(201)).body;
    spy.mockRestore();
    expect(s.token).toEqual(expect.any(String));
    const hours = (Date.parse(s.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0); expect(hours).toBeLessThanOrEqual(24);
    expect(new Date(s.expiresAt).getUTCHours()).toBe(1); // 04:00 in Riyadh
    // The identity-provider token alone is not enough when sessions are required; the browser session is.
    await http(enforced).get('/v1/me').set(await idp()).expect(401);
    const me = (await http(enforced).get('/v1/me').set({ Authorization: `Bearer ${s.token}` }).expect(200)).body;
    expect(me.id).toBe(WEB_USER);
    // A session never counts as a fresh sign-in: it cannot mint another session or register a device.
    await http(enforced).post('/v1/auth/web/session').set({ Authorization: `Bearer ${s.token}` }).send({ code: codeAt() }).expect(401);
    // The same code cannot be replayed with a fresh sign-in either.
    const spy2 = vi.spyOn(Date, 'now').mockReturnValue(real + 60_000);
    await http().post('/v1/auth/web/session').set(await idp()).send({ code: codeAt() }).expect(422);
    spy2.mockRestore();
  });

  it('the owner entry of the landing page refuses someone who heads no household (403, no session)', async () => {
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 90_000);
    const r = await http().post('/v1/auth/web/session').set(await idp()).send({ code: codeAt(), entry: 'owner' }).expect(403);
    spy.mockRestore();
    expect(r.body.detail).toMatch(/access denied: this entry is for household owners/);
    expect(r.body.token).toBeUndefined();
  });

  it('a browser session reaches household data only where the user is a member', async () => {
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 120_000);
    const s = (await http(enforced).post('/v1/auth/web/session').set(await idp()).send({ code: codeAt() }).expect(201)).body;
    spy.mockRestore();
    // Not a member of H1: the household is not even confirmed to exist.
    await http(enforced).get('/v1/staff').set({ Authorization: `Bearer ${s.token}`, 'X-Household-Id': H1 }).expect(404);
  });
});
