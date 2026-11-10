import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { OtpDeliveryService } from '../src/auth/otp-delivery.service';
import { base32Decode, base32Encode, hotp, totpStep, verifyTotp } from '../src/auth/totp';
import { H1, H2, as, testEnv } from './helpers';

const NEW_USER = 'a0000000-0000-0000-0000-0000000000a1';
const OTHER_USER = 'a0000000-0000-0000-0000-0000000000a2';
const PHONE = '+966500000777';
const EMAIL = 'new.staff@example.com';
let app: INestApplication;
let enforced: INestApplication;
let worker: ServiceDb;
let otp: OtpDeliveryService;
let totpSecret = '';
let deviceKeyId = '';
const DEVICE = 'iphone-15-install-a1b2c3';
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = keys.publicKey.export({ format: 'jwk' });
const http = (a: INestApplication = app) => request(a.getHttpServer());
const me = (user = NEW_USER) => as(user, H1);
const codeAt = (offsetSteps = 0) => hotp(base32Decode(totpSecret), totpStep(Date.now()) + BigInt(offsetSteps));

describe('TOTP (RFC 6238 / RFC 4226 vectors)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('HOTP and TOTP reference values', () => {
    expect(['755224', '287082', '359152'].map((c, i) => hotp(secret, BigInt(i)) === c)).toEqual([true, true, true]);
    expect(hotp(secret, totpStep(59_000), 8)).toBe('94287082');
    expect(hotp(secret, totpStep(1_111_111_109_000), 8)).toBe('07081804');
  });
  it('base32 round-trip and ±1 step drift window', () => {
    const b32 = base32Encode(secret);
    expect(b32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const t = 1_700_000_000_000;
    expect(verifyTotp(b32, hotp(secret, totpStep(t) + 1n), t)).toBe(totpStep(t) + 1n);
    expect(verifyTotp(b32, hotp(secret, totpStep(t) + 2n), t)).toBeNull();
    expect(verifyTotp(b32, '12345', t)).toBeNull();
  });
});

beforeAll(async () => {
  testEnv();
  process.env.AUTH_TOTP_KEY = randomBytes(32).toString('base64');          // shared by both app instances
  process.env.SESSION_SIGNING_SECRET = randomBytes(32).toString('hex');
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await worker.run(async (tx) => {
    for (const id of [NEW_USER, OTHER_USER]) await tx.user.upsert({ where: { id }, create: { id, fullNameI18n: { en: 'New staff' }, preferredLocale: 'en' }, update: {} });
    const role = await tx.role.findFirstOrThrow({ where: { householdId: H1, systemRole: 'STAFF' } });
    await tx.membership.create({ data: { householdId: H1, userId: NEW_USER, roleId: role.id, status: 'ACTIVE', displayName: 'New staff' } });
    // Admitted (a member of the other household), so refusals below are about onboarding and ownership, not about invitations.
    const role2 = await tx.role.findFirstOrThrow({ where: { householdId: H2, systemRole: 'STAFF' } });
    await tx.membership.create({ data: { householdId: H2, userId: OTHER_USER, roleId: role2.id, status: 'ACTIVE', displayName: 'Other staff' } });
  });
  app = await createApp(); await app.init();
  otp = app.get(OtpDeliveryService);
  process.env.AUTH_REQUIRE_DEVICE_SESSION = 'true';
  enforced = await createApp(); await enforced.init();
  delete process.env.AUTH_REQUIRE_DEVICE_SESSION;
});
afterAll(async () => {
  await worker?.run(async (tx) => { await tx.membership.deleteMany({ where: { userId: { in: [NEW_USER, OTHER_USER] } } }); await tx.user.deleteMany({ where: { id: { in: [NEW_USER, OTHER_USER] } } }); });
  await app?.close(); await enforced?.close(); await worker?.close();
  delete process.env.AUTH_TOTP_KEY; delete process.env.SESSION_SIGNING_SECRET;
});

describe('first-time onboarding: SMS OTP → email OTP → authenticator', () => {
  it('nothing in the household is reachable before onboarding', async () => {
    expect((await http().get('/v1/tasks').set(await me()).expect(403)).body.detail).toMatch(/complete onboarding/);
    expect((await http().get('/v1/auth/onboarding').set(await me()).expect(200)).body).toMatchObject({ complete: false, next: 'phone' });
  });

  it('phone: a 6-digit SMS code, stored only as a hash; 5 wrong tries lock it', async () => {
    const c1 = await http().post('/v1/auth/onboarding/phone').set(await me()).send({ phone: PHONE }).expect(201);
    expect(c1.body.sentTo).toMatch(/0777$/);
    const code = otp.lastCodeFor(PHONE)!;
    expect(code).toMatch(/^\d{6}$/);
    const [row] = await worker.run((tx) => tx.authChallenge.findMany({ where: { id: c1.body.challengeId } }));
    expect(row!.codeHash).not.toContain(code);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await http().post('/v1/auth/onboarding/phone/verify').set(await me()).send({ challengeId: c1.body.challengeId, code: wrong }).expect(400);
    expect((await http().post('/v1/auth/onboarding/phone/verify').set(await me()).send({ challengeId: c1.body.challengeId, code: wrong }).expect(400)).body.detail).toMatch(/locked/);
    expect((await http().post('/v1/auth/onboarding/phone/verify').set(await me()).send({ challengeId: c1.body.challengeId, code }).expect(400)).body.detail).toMatch(/locked/);

    const c2 = await http().post('/v1/auth/onboarding/phone').set(await me()).send({ phone: PHONE }).expect(201);
    const ok = await http().post('/v1/auth/onboarding/phone/verify').set(await me()).send({ challengeId: c2.body.challengeId, code: otp.lastCodeFor(PHONE) }).expect(201);
    expect(ok.body).toMatchObject({ phone: { verified: true }, next: 'email' });
    expect((await worker.run((tx) => tx.user.findUniqueOrThrow({ where: { id: NEW_USER } }))).phone).toBe(PHONE);
  });

  it('codes are single-use, private to their user, and rate limited', async () => {
    const c = await http().post('/v1/auth/onboarding/phone').set(await me()).send({ phone: PHONE }).expect(201);
    const code = otp.lastCodeFor(PHONE)!;
    await http().post('/v1/auth/onboarding/phone/verify').set(await me(OTHER_USER)).send({ challengeId: c.body.challengeId, code }).expect(404);
    await http().post('/v1/auth/onboarding/phone/verify').set(await me()).send({ challengeId: c.body.challengeId, code }).expect(201);
    expect((await http().post('/v1/auth/onboarding/phone/verify').set(await me()).send({ challengeId: c.body.challengeId, code }).expect(400)).body.detail).toMatch(/used/);
    await http().post('/v1/auth/onboarding/phone').set(await me()).send({ phone: PHONE }).expect(201);
    await http().post('/v1/auth/onboarding/phone').set(await me()).send({ phone: PHONE }).expect(201);
    await http().post('/v1/auth/onboarding/phone').set(await me()).send({ phone: PHONE }).expect(429);
  });

  it('the authenticator needs phone and email first; email verifies by code', async () => {
    await http().post('/v1/auth/onboarding/totp').set(await me()).expect(403);
    const c = await http().post('/v1/auth/onboarding/email').set(await me()).send({ email: EMAIL }).expect(201);
    expect(otp.outbox.at(-1)).toMatchObject({ channel: 'email', to: EMAIL });
    const r = await http().post('/v1/auth/onboarding/email/verify').set(await me()).send({ challengeId: c.body.challengeId, code: otp.lastCodeFor(EMAIL) }).expect(201);
    expect(r.body).toMatchObject({ email: { verified: true, value: 'n•••@example.com' }, next: 'authenticator' });
  });

  it('Microsoft Authenticator: otpauth QR, confirmed by a code; secret encrypted at rest; codes cannot be replayed', async () => {
    const t = await http().post('/v1/auth/onboarding/totp').set(await me()).expect(201);
    expect(t.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Majid%20household%3Anew\.staff%40example\.com\?secret=[A-Z2-7]{32}&issuer=Majid%20household&algorithm=SHA1&digits=6&period=30$/);
    totpSecret = t.body.secret;
    const [f] = await worker.run((tx) => tx.userAuthFactor.findMany({ where: { userId: NEW_USER } }));
    expect(f!.totpSecretCiphertext).toMatch(/^t1\./);
    expect(f!.totpSecretCiphertext).not.toContain(totpSecret);
    await http().post('/v1/auth/onboarding/totp/verify').set(await me()).send({ code: '000000' === codeAt() ? '111111' : '000000' }).expect(400);
    const code = codeAt();
    const done = await http().post('/v1/auth/onboarding/totp/verify').set(await me()).send({ code }).expect(201);
    expect(done.body).toMatchObject({ complete: true, next: 'device' });
    expect((await http().post('/v1/auth/onboarding/totp/verify').set(await me()).send({ code }).expect(422)).body.detail).toMatch(/already used/);
    await http().post('/v1/auth/onboarding/totp').set(await me()).expect(422); // enrolled: cannot be swapped silently
  });

  it('now the household is reachable', async () => {
    await http().get('/v1/tasks').set(await me()).expect(200);
  });
});

describe('daily unlock with Face ID / Touch ID (device-bound key)', () => {
  it('registering the device needs a fresh sign-in and an authenticator code', async () => {
    const r = await http().post('/v1/auth/devices').set(await me()).send({ deviceId: DEVICE, label: 'iPhone 15', publicKeyJwk: jwk, totpCode: codeAt(1) }).expect(201);
    deviceKeyId = r.body.id;
    await http().post('/v1/auth/devices').set(await me()).send({ deviceId: 'x'.repeat(10), publicKeyJwk: { ...jwk, x: 'A'.repeat(43) }, totpCode: '123456' }).expect(400);
    await http().post('/v1/auth/devices').set(await me(OTHER_USER)).send({ deviceId: DEVICE, publicKeyJwk: jwk, totpCode: '123456' }).expect(403);
  });

  const unlock = async (key = keys.privateKey) => {
    const ch = (await http().post('/v1/auth/unlock/challenge').set(await me()).send({ deviceId: DEVICE }).expect(201)).body;
    const signature = sign('sha256', Buffer.from(ch.message), key).toString('base64url'); // DER, as the Secure Enclave returns
    return { ch, signature };
  };

  it('signing the nonce returns a session valid until 04:00 Riyadh; a wrong key or a replay is refused', async () => {
    const { ch, signature } = await unlock();
    const s = await http().post('/v1/auth/unlock').set(await me()).send({ challengeId: ch.challengeId, nonce: ch.nonce, signature }).expect(201);
    expect(s.body.deviceKeyId).toBe(deviceKeyId);
    expect(new Date(s.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    expect(new Date(s.body.expiresAt).toISOString()).toMatch(/T01:00:00\.000Z$/); // 04:00 Asia/Riyadh
    await http().post('/v1/auth/unlock').set(await me()).send({ challengeId: ch.challengeId, nonce: ch.nonce, signature }).expect(401);
    const bad = await unlock(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
    await http().post('/v1/auth/unlock').set(await me()).send({ challengeId: bad.ch.challengeId, nonce: bad.ch.nonce, signature: bad.signature }).expect(401);
    const tampered = await unlock();
    await http().post('/v1/auth/unlock').set(await me()).send({ challengeId: tampered.ch.challengeId, nonce: 'A'.repeat(43), signature: tampered.signature }).expect(401);
  });

  it('when sessions are required, the IdP token alone is not enough; the unlocked session is', async () => {
    const { ch, signature } = await unlock();
    const s = (await http(enforced).post('/v1/auth/unlock').set(await me()).send({ challengeId: ch.challengeId, nonce: ch.nonce, signature }).expect(201)).body;
    expect((await http(enforced).get('/v1/tasks').set(await me()).expect(401)).body.detail).toMatch(/unlock the app/);
    await http(enforced).get('/v1/tasks').set({ Authorization: `Bearer ${s.token}`, 'X-Household-Id': H1 }).expect(200);
    await http(enforced).get('/v1/auth/onboarding').set(await me()).expect(200); // auth flow stays reachable
  });

  it('authenticator fallback (biometrics changed): fresh sign-in + code → session; revoking the device ends its sessions', async () => {
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 90_000); // three steps later: a code not used before
    const s = (await http(enforced).post('/v1/auth/unlock/totp').set(await me()).send({ deviceId: DEVICE, code: codeAt() }).expect(201)).body;
    spy.mockRestore();
    const headers = { Authorization: `Bearer ${s.token}`, 'X-Household-Id': H1 };
    await http(enforced).get('/v1/tasks').set(headers).expect(200);
    await http(enforced).delete(`/v1/auth/devices/${deviceKeyId}`).set(headers).expect(200);
    await http(enforced).get('/v1/tasks').set(headers).expect(401);
    await http(enforced).post('/v1/auth/unlock/challenge').set(await me()).send({ deviceId: DEVICE }).expect(404);
  });

  it('five wrong authenticator codes lock the factor for 15 minutes, even for the right code', async () => {
    const wrong = (n: number) => String((Number(codeAt()) + 1 + n) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 4; i++) await http().post('/v1/auth/unlock/totp').set(await me()).send({ deviceId: DEVICE, code: wrong(i) }).expect(404); // device revoked: no check reached
    const d2 = 'ipad-install-77aa88bb';
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 180_000);
    await http().post('/v1/auth/devices').set(await me()).send({ deviceId: d2, publicKeyJwk: jwk, totpCode: codeAt() }).expect(201);
    for (let i = 0; i < 4; i++) await http().post('/v1/auth/unlock/totp').set(await me()).send({ deviceId: d2, code: wrong(i) }).expect(400);
    await http().post('/v1/auth/unlock/totp').set(await me()).send({ deviceId: d2, code: wrong(9) }).expect(429);
    spy.mockReturnValue(real + 270_000);
    expect((await http().post('/v1/auth/unlock/totp').set(await me()).send({ deviceId: d2, code: codeAt() }).expect(429)).body.detail).toMatch(/15 minutes/);
    spy.mockRestore();
  });
});
