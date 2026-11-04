import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { createApp } from '../src/app.factory';
import { PrismaService } from '../src/db/prisma.service';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys, syncDocumentReminders } from '../src/worker/jobs';
import { H1, H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
let maidStaffId: string;
let driverStaffId: string;

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp();
  await app.init();
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('staff profiles', () => {
  it('head hires a housemaid linked to her app account, with an encrypted payout IBAN', async () => {
    const r = await http().post('/v1/staff').set(await as(USERS.head)).send({
      staffType: 'HOUSEMAID', fullName: { en: 'Maria Santos', ar: 'ماريا سانتوس' }, nationality: 'PH', preferredLocale: 'tl',
      membershipId: MEMBERSHIPS.maid, hireDate: '2026-01-10', borderNumber: '3012345678',
      defaultPayoutChannel: 'BANK_TRANSFER', payoutIban: 'SA03 8000 0000 6080 1016 7519',
    }).expect(201);
    expect(r.body).toMatchObject({ staffType: 'HOUSEMAID', status: 'ON_PROBATION', name: 'Maria Santos', hasBorderNumber: true,
      payout: { defaultChannel: 'BANK_TRANSFER', ibanLast4: '7519' } });
    expect(JSON.stringify(r.body)).not.toMatch(/SA03|8000|Ciphertext|BlindIndex/);
    maidStaffId = r.body.id;
  });

  it('IBAN and border number are ciphertext at rest', async () => {
    const [row] = await worker.run((tx) => tx.$queryRaw<Array<Record<string, string>>>`
      SELECT "payoutIbanCiphertext", "borderNumberCiphertext" FROM staff_profiles WHERE id = ${maidStaffId}::uuid`);
    expect(row!.payoutIbanCiphertext).toMatch(/^v1\.1\./);
    expect(row!.borderNumberCiphertext).not.toContain('3012345678');
  });

  it('rejects an invalid IBAN and BANK_TRANSFER without IBAN', async () => {
    const base = { staffType: 'DRIVER', fullName: { en: 'Rahim' }, nationality: 'BD' };
    expect((await http().post('/v1/staff').set(await as(USERS.head)).send({ ...base, payoutIban: 'SA03 8000 0000 6080 1016 7518' }).expect(400)).body.detail).toMatch(/IBAN/);
    await http().post('/v1/staff').set(await as(USERS.head)).send({ ...base, defaultPayoutChannel: 'BANK_TRANSFER' }).expect(400);
  });

  it('a driver paid through Musaned needs no IBAN (no WPS rules)', async () => {
    const r = await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'DRIVER', fullName: { en: 'Rahim Uddin' },
      nationality: 'BD', defaultPayoutChannel: 'MUSANED', payoutWalletRef: 'MSN-WALLET-55120934' }).expect(201);
    expect(r.body.payout).toEqual({ defaultChannel: 'MUSANED', ibanLast4: null, walletRef: 'MSN-WALLET-55120934' });
    driverStaffId = r.body.id;
  });

  it('maid sees only her own profile; other household sees nothing', async () => {
    const mine = await http().get('/v1/staff').set(await as(USERS.maid)).expect(200);
    expect(mine.body.data.map((s: { id: string }) => s.id)).toEqual([maidStaffId]);
    await http().get(`/v1/staff/${driverStaffId}`).set(await as(USERS.maid)).expect(404);
    await http().get(`/v1/staff/${maidStaffId}`).set(await as(USERS.head2, H2)).expect(404);
  });

  it('maid cannot edit her profile (403, not 404: she can see it)', async () => {
    await http().patch(`/v1/staff/${maidStaffId}`).set(await as(USERS.maid)).send({ phone: '+639171234567' }).expect(403);
  });

  it('status lifecycle is enforced and audited', async () => {
    await http().post(`/v1/staff/${maidStaffId}/status`).set(await as(USERS.head)).send({ status: 'ACTIVE' }).expect(201);
    const bad = await http().post(`/v1/staff/${maidStaffId}/status`).set(await as(USERS.head)).send({ status: 'RECRUITING' }).expect(422);
    expect(bad.body.detail).toMatch(/cannot move from ACTIVE to RECRUITING/);
  });
});

describe('identity documents (encrypted)', () => {
  let iqamaId: string;

  it('adds an Iqama: number encrypted, last-4 shown, default 60/30/15 alert tiers', async () => {
    const r = await http().post(`/v1/staff/${maidStaffId}/documents`).set(await as(USERS.head)).send({
      type: 'IQAMA', number: '2123456788', issuingCountry: 'SA', expiryDate: riyadhDate(25),
    }).expect(201);
    expect(r.body).toMatchObject({ type: 'IQAMA', numberLast4: '6788', alertDays: [60, 30, 15], daysLeft: 25, alertTier: '30' });
    iqamaId = r.body.id;
    const [row] = await worker.run((tx) => tx.$queryRaw<Array<{ c: string }>>`SELECT "numberCiphertext" AS c FROM identity_documents WHERE id = ${iqamaId}::uuid`);
    expect(row!.c).toMatch(/^v1\.1\./);
    expect(row!.c).not.toContain('2123456788');
  });

  it('validates numbers per type (Iqama check digit, passport format)', async () => {
    const r = await http().post(`/v1/staff/${maidStaffId}/documents`).set(await as(USERS.head)).send({ type: 'IQAMA', number: '2123456789' }).expect(400);
    expect(r.body.detail).toMatch(/invalid Iqama/);
    await http().post(`/v1/staff/${maidStaffId}/documents`).set(await as(USERS.head)).send({ type: 'IQAMA', number: '1000000008' }).expect(400); // citizen ID, not Iqama
    await http().post(`/v1/staff/${maidStaffId}/documents`).set(await as(USERS.head)).send({ type: 'PASSPORT', number: 'p-12' }).expect(400);
  });

  it('the same Iqama twice in a household → 409 (blind-index uniqueness)', async () => {
    await http().post(`/v1/staff/${driverStaffId}/documents`).set(await as(USERS.head)).send({ type: 'IQAMA', number: '2123 456 788' }).expect(409);
  });

  it('lookup by number uses the blind index (formatting-insensitive)', async () => {
    const r = await http().get('/v1/staff/documents/lookup').query({ type: 'IQAMA', number: '212-345-6788' }).set(await as(USERS.head)).expect(200);
    expect(r.body).toMatchObject({ id: iqamaId, staff: { id: maidStaffId, name: 'Maria Santos' } });
  });

  it('reveal decrypts and writes a VIEW_SENSITIVE audit entry', async () => {
    const r = await http().get(`/v1/staff/${maidStaffId}/documents/${iqamaId}/reveal`).set(await as(USERS.efa)).expect(200);
    expect(r.body.number).toBe('2123456788');
    const [a] = await worker.run((tx) => tx.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM audit_logs WHERE action = 'VIEW_SENSITIVE' AND "entityId" = ${iqamaId}
        AND "actorUserId" = ${USERS.efa}::uuid`);
    expect(a!.n).toBe(1);
  });

  it('maid can reveal her own Iqama, not another worker\'s', async () => {
    await http().get(`/v1/staff/${maidStaffId}/documents/${iqamaId}/reveal`).set(await as(USERS.maid)).expect(200);
    const p = await http().post(`/v1/staff/${driverStaffId}/documents`).set(await as(USERS.head)).send({ type: 'PASSPORT', number: 'BX0912345', expiryDate: riyadhDate(400) }).expect(201);
    await http().get(`/v1/staff/${driverStaffId}/documents/${p.body.id}/reveal`).set(await as(USERS.maid)).expect(404);
  });

  it('renewal is Head/EFA only: spouse and maid → 403 (EFA renewal is covered in the alerts suite)', async () => {
    await http().patch(`/v1/staff/${maidStaffId}/documents/${iqamaId}`).set(await as(USERS.spouse)).send({ expiryDate: riyadhDate(390) }).expect(403);
    await http().patch(`/v1/staff/${maidStaffId}/documents/${iqamaId}`).set(await as(USERS.maid)).send({ expiryDate: riyadhDate(390) }).expect(403);
  });
});

describe('expiry alerts at 60 / 30 / 15 days', () => {
  const docs: Record<string, string> = {};

  beforeAll(async () => {
    const add = async (label: string, number: string, days: number, type = 'PASSPORT') => {
      const r = await http().post(`/v1/staff/${driverStaffId}/documents`).set(await as(USERS.head))
        .send({ type, number, expiryDate: riyadhDate(days) }).expect(201);
      docs[label] = r.body.id;
    };
    await add('d10', 'AA1000010', 10);
    await add('d45', 'AA1000045', 45);
    await add('d90', 'AA1000090', 90);
    await add('expired', 'AA1000000', -3);
  });

  it('GET /staff/documents/expiring buckets by tier and leaves out documents beyond 60 days', async () => {
    const r = await http().get('/v1/staff/documents/expiring').set(await as(USERS.head)).expect(200);
    const tierOf = (id: string) => r.body.data.find((d: { id: string }) => d.id === id)?.alertTier;
    expect(r.body.withinDays).toBe(60);
    expect(tierOf(docs.d10!)).toBe('15');
    expect(tierOf(docs.d45!)).toBe('60');
    expect(tierOf(docs.expired!)).toBe('EXPIRED');
    expect(tierOf(docs.d90!)).toBeUndefined();
    expect(r.body.summary).toMatchObject({ EXPIRED: 1, '15': 1, '30': 1, '60': 1 }); // the 25-day Iqama is tier 30
  });

  it('withinDays widens the window', async () => {
    const r = await http().get('/v1/staff/documents/expiring').query({ withinDays: 120 }).set(await as(USERS.head)).expect(200);
    expect(r.body.data.some((d: { id: string }) => d.id === docs.d90)).toBe(true);
  });

  const remindersFor = (id: string) => worker.run((tx) => tx.$queryRaw<Array<{ tier: number; due_now: boolean }>>`
    SELECT ("titleI18n"->>'tier')::int AS tier, "remindAt" <= now() AS due_now FROM reminders
    WHERE "entityId" = ${id}::uuid AND status = 'PENDING' ORDER BY tier DESC`);

  it('sweep schedules future tiers, fires the current tier now, skips overtaken tiers', async () => {
    await syncDocumentReminders(worker, H1);
    expect(await remindersFor(docs.d90!)).toEqual([{ tier: 60, due_now: false }, { tier: 30, due_now: false }, { tier: 15, due_now: false }]);
    expect(await remindersFor(docs.d45!)).toEqual([{ tier: 60, due_now: true }, { tier: 30, due_now: false }, { tier: 15, due_now: false }]);
    expect(await remindersFor(docs.d10!)).toEqual([{ tier: 15, due_now: true }]);
    expect(await remindersFor(docs.expired!)).toEqual([{ tier: 0, due_now: true }]);
  });

  it('the sweep is idempotent', async () => {
    expect((await syncDocumentReminders(worker, H1)).inserted).toBe(0);
  });

  it('Arabic and English reminder text', async () => {
    const [r] = await worker.run((tx) => tx.$queryRaw<Array<{ t: Record<string, string> }>>`
      SELECT "titleI18n" AS t FROM reminders WHERE "entityId" = ${docs.d10!}::uuid`);
    expect(r!.t.ar).toBe('تنتهي جواز السفر للعامل Rahim Uddin خلال 15 يوماً');
    expect(r!.t.en).toBe('Passport of Rahim Uddin expires within 15 days');
  });

  it('renewal (EFA) replaces the old reminders with a fresh 60/30/15 schedule', async () => {
    await http().patch(`/v1/staff/${driverStaffId}/documents/${docs.d10}`).set(await as(USERS.efa)).send({ expiryDate: riyadhDate(730) }).expect(200);
    const r = await syncDocumentReminders(worker, H1);
    expect(r.removed).toBe(1);
    expect(await remindersFor(docs.d10!)).toEqual([{ tier: 60, due_now: false }, { tier: 30, due_now: false }, { tier: 15, due_now: false }]);
  });

  it('custom per-document tiers', async () => {
    const r = await http().post(`/v1/staff/${driverStaffId}/documents`).set(await as(USERS.head))
      .send({ type: 'DRIVING_LICENSE', number: 'DL-778899', expiryDate: riyadhDate(100), alertDays: [15, 90, 30, 90] }).expect(201);
    expect(r.body.alertDays).toEqual([90, 30, 15]);
  });

  it('household setting documentAlertDays overrides the 60/30/15 default for new documents', async () => {
    await worker.run((tx) => tx.$executeRaw`UPDATE households SET settings = '{"documentAlertDays":[90,45,15]}' WHERE id = ${H1}::uuid`);
    const r = await http().post(`/v1/staff/${driverStaffId}/documents`).set(await as(USERS.head))
      .send({ type: 'VISA', number: 'V-445566', expiryDate: riyadhDate(200) }).expect(201);
    expect(r.body.alertDays).toEqual([90, 45, 15]);
    await worker.run((tx) => tx.$executeRaw`UPDATE households SET settings = '{}' WHERE id = ${H1}::uuid`);
  });
});

describe('salary payments (Musaned / direct transfer, no WPS)', () => {
  let paymentId: string;

  beforeAll(async () => {
    await http().post(`/v1/staff/${maidStaffId}/contracts`).set(await as(USERS.head)).send({
      startDate: '2026-01-10', basicSalary: 1500, allowances: [{ code: 'FOOD', amount: 200 }],
    }).expect(201);
    await http().post(`/v1/staff/${driverStaffId}/contracts`).set(await as(USERS.head)).send({ startDate: '2026-01-01', basicSalary: 2000 }).expect(201);
  });

  it('bank transfer defaults amount from the contract (1500 + 200) and records the IBAN last-4', async () => {
    const r = await http().post(`/v1/staff/${maidStaffId}/salary-payments`).set(await as(USERS.head))
      .send({ periodYear: 2026, periodMonth: 10, externalRef: 'ALRAJHI-TRF-889120' }).expect(201);
    expect(r.body).toMatchObject({ amount: '1700.00', channel: 'BANK_TRANSFER', status: 'RECORDED', payoutLast4: '7519',
      period: { expected: 1700, paid: '1700.00', outstanding: '0.00' }, warnings: [] });
    paymentId = r.body.id;
  });

  it('Musaned and bank transfers need the transfer reference', async () => {
    const r = await http().post(`/v1/staff/${driverStaffId}/salary-payments`).set(await as(USERS.head)).send({ periodYear: 2026, periodMonth: 10 }).expect(400);
    expect(r.body.detail).toMatch(/Musaned transfer reference/);
    const ok = await http().post(`/v1/staff/${driverStaffId}/salary-payments`).set(await as(USERS.head))
      .send({ periodYear: 2026, periodMonth: 10, externalRef: 'MSN-2026-10-000123' }).expect(201);
    expect(ok.body).toMatchObject({ channel: 'MUSANED', amount: '2000.00', payoutLast4: '0934' });
  });

  it('cash is allowed without a reference (outside WPS); overpayment is warned about', async () => {
    const r = await http().post(`/v1/staff/${maidStaffId}/salary-payments`).set(await as(USERS.head))
      .send({ periodYear: 2026, periodMonth: 10, amount: 300, channel: 'CASH', note: 'Eid bonus' }).expect(201);
    expect(r.body.channel).toBe('CASH');
    expect(r.body.warnings[0]).toMatch(/exceeds the contract amount/);
  });

  it('a guessed foreign id (proof file from elsewhere) → 422 INVALID_REFERENCE, not 500', async () => {
    const r = await http().post(`/v1/staff/${maidStaffId}/salary-payments`).set(await as(USERS.head))
      .send({ periodYear: 2026, periodMonth: 11, channel: 'CASH', amount: 10, proofFileId: '7f9c2ba4-e88f-4d3b-9b0e-6c1d2a3b4c5d' });
    expect(r.status).toBe(422);
    // Prisma surfaces SQLSTATE 23503 as P2003 without the trigger text; the generic detail is also oracle-free.
    expect(r.body).toMatchObject({ code: 'INVALID_REFERENCE', detail: 'referenced record does not exist' });
  });

  it('maid sees only her own payments and cannot record any', async () => {
    const r = await http().get('/v1/salary-payments').set(await as(USERS.maid)).expect(200);
    expect(new Set(r.body.data.map((p: { staffId: string }) => p.staffId))).toEqual(new Set([maidStaffId]));
    await http().post(`/v1/staff/${maidStaffId}/salary-payments`).set(await as(USERS.maid)).send({ periodYear: 2026, periodMonth: 11, amount: 1, channel: 'CASH' }).expect(403);
  });

  it('the Head cannot acknowledge on the worker\'s behalf', async () => {
    const r = await http().post(`/v1/salary-payments/${paymentId}/acknowledge`).set(await as(USERS.head)).send({}).expect(403);
    expect(r.body.detail).toMatch(/only the worker/);
  });

  it('the worker acknowledges her own salary', async () => {
    const r = await http().post(`/v1/salary-payments/${paymentId}/acknowledge`).set(await as(USERS.maid)).send({ method: 'OTP_CONFIRMED' }).expect(201);
    expect(r.body).toMatchObject({ status: 'ACKNOWLEDGED', ackMethod: 'OTP_CONFIRMED' });
    expect(r.body.acknowledgedAt).toBeTruthy();
  });

  it('the worker cannot reverse; a dispute needs a reason', async () => {
    const list = await http().get(`/v1/staff/${maidStaffId}/salary-payments`).set(await as(USERS.maid)).expect(200);
    const cash = list.body.data.find((p: { channel: string }) => p.channel === 'CASH');
    await http().post(`/v1/salary-payments/${cash.id}/reverse`).set(await as(USERS.maid)).send({ reason: 'wrong' }).expect(403);
    await http().post(`/v1/salary-payments/${cash.id}/dispute`).set(await as(USERS.maid)).send({ reason: 'x' }).expect(400);
    const d = await http().post(`/v1/salary-payments/${cash.id}/dispute`).set(await as(USERS.maid)).send({ reason: 'I received 200, not 300' }).expect(201);
    expect(d.body).toMatchObject({ status: 'DISPUTED', disputeReason: 'I received 200, not 300' });
  });

  it('payment rows are immutable at the DB level: even the Head cannot change amount, channel or reference', async () => {
    const db = app.get(PrismaService);
    const head = { userId: USERS.head, householdId: H1 };
    for (const data of [{ amount: 1 }, { channel: 'CASH' as const }, { externalRef: 'forged' }]) {
      await expect(db.withRls(head, (tx) => tx.salaryPayment.updateMany({ where: { id: paymentId }, data })))
        .rejects.toThrow(/permission denied/);
    }
    await expect(db.withRls(head, (tx) => tx.salaryPayment.deleteMany({ where: { id: paymentId } }))).resolves.toEqual({ count: 0 });
  });

  it('Head reverses a wrong entry with a reason; reversed is final', async () => {
    const wrong = await http().post(`/v1/staff/${driverStaffId}/salary-payments`).set(await as(USERS.head))
      .send({ periodYear: 2026, periodMonth: 9, channel: 'CASH', amount: 2000 }).expect(201);
    const r = await http().post(`/v1/salary-payments/${wrong.body.id}/reverse`).set(await as(USERS.head)).send({ reason: 'duplicate entry' }).expect(201);
    expect(r.body).toMatchObject({ status: 'REVERSED', reversalReason: 'duplicate entry' });
    await http().post(`/v1/salary-payments/${wrong.body.id}/reverse`).set(await as(USERS.efa)).send({ reason: 'again' }).expect(422);
  });

  it('salary statement: due vs paid vs confirmed per month, unpaid months flagged', async () => {
    const r = await http().get(`/v1/staff/${maidStaffId}/salary-statement`).query({ year: 2026 }).set(await as(USERS.head)).expect(200);
    const oct = r.body.months.find((m: { month: number }) => m.month === 10);
    expect(oct).toMatchObject({ expected: '1700.00', paid: '2000.00', status: 'DISPUTED' });
    const feb = r.body.months.find((m: { month: number }) => m.month === 2);
    expect(feb).toMatchObject({ status: 'UNPAID', outstanding: '1700.00' });
    expect(r.body.totals.unpaidMonths).toBeGreaterThanOrEqual(8); // Feb–Sep and Nov unpaid in this fixture
  });

  it('the worker sees her own statement (same RLS scope as her payslips)', async () => {
    await http().get(`/v1/staff/${maidStaffId}/salary-statement`).query({ year: 2026 }).set(await as(USERS.maid)).expect(200);
    await http().get(`/v1/staff/${driverStaffId}/salary-statement`).query({ year: 2026 }).set(await as(USERS.maid)).expect(404);
  });
});
