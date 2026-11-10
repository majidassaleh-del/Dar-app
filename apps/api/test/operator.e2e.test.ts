import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { OtpDeliveryService } from '../src/auth/otp-delivery.service';
import { base32Decode, hotp, totpStep } from '../src/auth/totp';
import { ServiceDb } from '../src/worker/service-db';
import { H1, USERS, as, testEnv, token } from './helpers';

/**
 * Operator provisioning (POST /v1/operator/create-household) and the two entries of the landing
 * page: the owner entry admits only people who head a household; the member entry everyone invited.
 */
const KEY = `op-${randomBytes(24).toString('hex')}`;
const PHONE = '+966500004701', EMAIL = 'abo.abdulmalik@example.test';
const body = { slug: 'abdulmalik-test', name: { ar: 'دار أبو عبدالملك', en: 'Dar Abo Abdulmalik' }, owner: { phone: PHONE, email: EMAIL, name: { ar: 'أبو عبدالملك' } } };
let app: INestApplication, worker: ServiceDb, otp: OtpDeliveryService;
let household = '', owner = '', secret = '';
const http = () => request(app.getHttpServer());
const create = (key?: string, b: unknown = body) => { const r = http().post('/v1/operator/create-household'); return (key === undefined ? r : r.set('X-Operator-Key', key)).send(b as object); };
const bearer = async (sub: string) => ({ Authorization: `Bearer ${await token(sub)}`, 'Accept-Language': 'en' });
const codeAt = () => hotp(base32Decode(secret), totpStep(Date.now()));
const hash = (k: string) => createHash('sha256').update(k).digest('hex');

beforeAll(async () => {
  testEnv();
  process.env.AUTH_TOTP_KEY = randomBytes(32).toString('base64');
  process.env.SESSION_SIGNING_SECRET = randomBytes(32).toString('hex');
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  app = await createApp(); await app.init();
  otp = app.get(OtpDeliveryService);
});
afterAll(async () => {
  await worker?.run(async (tx) => {
    await tx.$executeRaw`DELETE FROM app.operator_keys WHERE hash = ${hash(KEY)}`;
    // Households are never hard-deleted (their ledger forbids it); the test database is rebuilt for every run.
  });
  await app?.close(); await worker?.close();
  delete process.env.AUTH_TOTP_KEY; delete process.env.SESSION_SIGNING_SECRET;
});

describe('create-household is the operator\'s alone', () => {
  it('no key on file: closed to everyone, including a signed-in household owner', async () => {
    for (const r of [await create(), await create(''), await create('short'), await create(KEY), await create(KEY, { nonsense: true }),
                     await http().post('/v1/operator/create-household').set(await as(USERS.head)).send(body)]) {
      expect(r.status).toBe(403);
      expect(r.body.detail).toMatch(/access denied/i);
    }
    await worker.run(async (tx) => { expect(await tx.household.count({ where: { slug: body.slug } })).toBe(0); });
  });

  it('with the operator key: validates, then creates the household and its owner', async () => {
    await worker.run(async (tx) => { await tx.$executeRaw`INSERT INTO app.operator_keys (hash, label) VALUES (${hash(KEY)}, 'e2e')`; });
    await create(`${KEY}x`).expect(403); // a near miss is still a miss
    for (const bad of [{ ...body, slug: 'API' }, { ...body, slug: 'api' }, { ...body, slug: 'a' }, { ...body, name: {} }, { ...body, owner: { name: { ar: 'x' } } }, { ...body, extra: 1 }]) await create(KEY, bad).expect(400);
    const r = (await create(KEY).expect(201)).body;
    household = r.householdId; owner = r.owner.userId;
    expect(r).toMatchObject({ slug: 'abdulmalik-test', owner: { existingAccount: false, phone: PHONE, email: EMAIL } });
    await worker.run(async (tx) => {
      expect(await tx.user.findUniqueOrThrow({ where: { id: owner } })).toMatchObject({ phone: PHONE, email: EMAIL });
      const m = await tx.membership.findMany({ where: { userId: owner }, include: { role: true } });
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ householdId: household, status: 'ACTIVE', role: { systemRole: 'HOUSEHOLD_HEAD' } });
      expect(await tx.role.count({ where: { householdId: household, isDefault: true } })).toBe(8);
    });
    // The slug is unique; the same person may own a second household (no second account).
    await create(KEY).expect(409);
    const second = (await create(KEY, { ...body, slug: 'second-test', name: { en: 'Second house' }, owner: { phone: PHONE } }).expect(201)).body;
    expect(second.owner).toMatchObject({ userId: owner, existingAccount: true });
    // A phone that belongs to one account with an e-mail that belongs to another: refused, nothing created.
    await worker.run(async (tx) => { await tx.user.create({ data: { id: '00000000-0000-4000-8000-0000000047ff', email: 'someone.else@example.test', fullNameI18n: {} } }); });
    await create(KEY, { ...body, slug: 'third-test', owner: { phone: PHONE, email: 'someone.else@example.test' } }).expect(422);
    await worker.run(async (tx) => { expect(await tx.household.count({ where: { slug: 'third-test' } })).toBe(0); await tx.user.delete({ where: { id: '00000000-0000-4000-8000-0000000047ff' } }); });
  });
});

describe('landing page entries', () => {
  it('the new owner onboards under their own household\'s name and enters through the owner entry', async () => {
    const h = await bearer(owner);
    const p = (await http().post('/v1/auth/onboarding/phone').set({ ...h, 'X-Household-Id': household }).send({ phone: PHONE }).expect(201)).body;
    expect([...otp.outbox].reverse().find((m) => m.to === PHONE)!.text).toContain('Dar Abo Abdulmalik');
    await http().post('/v1/auth/onboarding/phone/verify').set(h).send({ challengeId: p.challengeId, code: otp.lastCodeFor(PHONE) }).expect(201);
    const e = (await http().post('/v1/auth/onboarding/email').set(h).send({ email: EMAIL }).expect(201)).body;
    await http().post('/v1/auth/onboarding/email/verify').set(h).send({ challengeId: e.challengeId, code: otp.lastCodeFor(EMAIL) }).expect(201);
    secret = (await http().post('/v1/auth/onboarding/totp').set({ ...h, 'X-Household-Id': household }).expect(201)).body.secret;
    await http().post('/v1/auth/onboarding/totp/verify').set(h).send({ code: codeAt() }).expect(201);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const s = (await http().post('/v1/auth/web/session').set(await bearer(owner)).send({ code: codeAt(), entry: 'owner' }).expect(201)).body;
    spy.mockRestore();
    const session = { Authorization: `Bearer ${s.token}`, 'Accept-Language': 'en' };
    const me = (await http().get('/v1/me').set(session).expect(200)).body;
    expect(me.households.map((x: { slug: string; name: string; systemRole: string }) => [x.slug, x.name, x.systemRole]))
      .toEqual([['abdulmalik-test', 'Dar Abo Abdulmalik', 'HOUSEHOLD_HEAD'], ['second-test', 'Second house', 'HOUSEHOLD_HEAD']]);
    // Sole authority to invite in their household; nothing in anybody else's.
    const staff = (await http().get('/v1/roles').set({ ...session, 'X-Household-Id': household }).expect(200)).body.data.find((r: { systemRole: string }) => r.systemRole === 'STAFF');
    await http().post('/v1/invitations').set({ ...session, 'X-Household-Id': household }).send({ phone: '+966500004703', roleId: staff.id }).expect(201);
    await http().get('/v1/members').set({ ...session, 'X-Household-Id': H1 }).expect(404);
    await http().post('/v1/operator/create-household').set(session).send(body).expect(403); // an owner is not the operator
  });

  it('the owner entry refuses a member (403); the member entry admits owner and member alike', async () => {
    const inv = await worker.run(async (tx) => tx.invitation.findFirstOrThrow({ where: { phone: '+966500004703' } }));
    expect(inv.householdId).toBe(household);
    await http().post('/v1/auth/web/session').set(await bearer(owner)).send({ code: '000000', entry: 'superuser' }).expect(400);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    await http().post('/v1/auth/web/session').set(await bearer(owner)).send({ code: codeAt(), entry: 'member' }).expect(201);
    spy.mockRestore();
    // Demote: once the person no longer heads any household, the owner entry closes for them.
    await worker.run(async (tx) => {
      for (const hh of await tx.household.findMany({ where: { slug: { in: ['abdulmalik-test', 'second-test'] } } })) {
        const staff = await tx.role.findFirstOrThrow({ where: { householdId: hh.id, systemRole: 'STAFF', isDefault: true } });
        await tx.membership.updateMany({ where: { householdId: hh.id, userId: owner }, data: { roleId: staff.id } });
      }
    });
    const spy2 = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
    const refused = await http().post('/v1/auth/web/session').set(await bearer(owner)).send({ code: codeAt(), entry: 'owner' }).expect(403);
    spy2.mockRestore();
    expect(refused.body.detail).toMatch(/household owners/);
    expect(refused.body.token).toBeUndefined();
    const spy3 = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240_000);
    await http().post('/v1/auth/web/session').set(await bearer(owner)).send({ code: codeAt(), entry: 'member' }).expect(201);
    spy3.mockRestore();
  });
});
