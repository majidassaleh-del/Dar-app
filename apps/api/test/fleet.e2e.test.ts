import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { syncFleetReminders } from '../src/worker/jobs';
import { dispatchNotifications } from '../src/notifications/dispatch';
import { checkFuel } from '../src/fleet/fuel-anomalies';
import type { Channel, ChannelSender } from '../src/notifications/senders';
import { H1, H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
let vid = '';
let floatId = '';
let oilPlan = '';
const vehicleReminders = () => worker.run((tx) => tx.reminder.findMany({ where: { entityId: { in: [vid, oilPlan] }, status: 'PENDING' }, orderBy: { dueAt: 'asc' } }));
const fill = async (b: object, status = 201) =>
  (await http().post(`/v1/vehicles/${vid}/fuel`).set(await as(USERS.driver)).send({ pettyCashAccountId: floatId, station: 'SASCO Exit 5', ...b }).expect(status)).body;

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  app = await createApp(); await app.init();
  floatId = (await http().post('/v1/petty-cash').set(await as(USERS.head)).send({ custodianId: MEMBERSHIPS.driver, name: 'Driver float',
    floatLimit: 2000, receiptRequiredOver: 500 }).expect(201)).body.id;
  await http().post(`/v1/petty-cash/${floatId}/top-ups`).set(await as(USERS.head)).send({ amount: 1500 }).expect(201);
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('vehicle profile and driver access', () => {
  it('Head registers the car with Istimara, insurance and Fahas details', async () => {
    const r = await http().post('/v1/vehicles').set(await as(USERS.head)).send({ make: 'Toyota', model: 'Land Cruiser', year: 2023, plateNumber: 'ABC 1234',
      plateNumberAr: 'أ ب ح ١٢٣٤', fuelType: 'PETROL_91', odometerKm: 50_000, registrationNumber: 'IST-778812', registrationExpiry: riyadhDate(20),
      insuranceProvider: 'Tawuniya', insurancePolicy: 'P-55102', insuranceExpiry: riyadhDate(45), inspectionExpiry: riyadhDate(-2), tankCapacityL: 93, expectedKmPerL: 7 }).expect(201);
    vid = r.body.id;
    expect(r.body).toMatchObject({ plateNumber: 'ABC 1234', odometerKm: 50_000, registration: { number: 'IST-778812', daysLeft: 20 },
      insurance: { provider: 'Tawuniya', daysLeft: 45 }, inspection: { daysLeft: -2 } });
  });

  it('a driver sees only assigned vehicles and cannot edit the profile', async () => {
    await http().get(`/v1/vehicles/${vid}`).set(await as(USERS.driver)).expect(404);
    await http().post(`/v1/vehicles/${vid}/assignments`).set(await as(USERS.head)).send({ driverId: MEMBERSHIPS.driver }).expect(201);
    expect((await http().get(`/v1/vehicles/${vid}`).set(await as(USERS.driver)).expect(200)).body.drivers).toEqual([expect.objectContaining({ driverId: MEMBERSHIPS.driver })]);
    await http().patch(`/v1/vehicles/${vid}`).set(await as(USERS.driver)).send({ insuranceExpiry: riyadhDate(400) }).expect(403);
    await http().get(`/v1/vehicles/${vid}`).set(await as(USERS.head2, H2)).expect(404);
    await http().get(`/v1/vehicles/${vid}`).set(await as(USERS.maid)).expect(404);
  });
});

describe('preventive maintenance', () => {
  it('plans by km and/or days; due is computed from the last service or today’s odometer', async () => {
    const oil = await http().post(`/v1/vehicles/${vid}/maintenance-plans`).set(await as(USERS.efa)).send({ type: 'OIL_CHANGE', intervalKm: 5000, intervalDays: 180 }).expect(201);
    oilPlan = oil.body.id;
    expect(oil.body).toMatchObject({ lastDoneKm: 50_000, nextDueKm: 55_000, nextDueDate: riyadhDate(180), status: 'OK' });
    expect((await http().post(`/v1/vehicles/${vid}/maintenance-plans`).set(await as(USERS.efa)).send({ type: 'TIRES', intervalKm: 10_000 }).expect(201)).body.nextDueKm).toBe(60_000);
    await http().post(`/v1/vehicles/${vid}/maintenance-plans`).set(await as(USERS.efa)).send({ type: 'BRAKES' }).expect(400);
    await http().post(`/v1/vehicles/${vid}/maintenance-plans`).set(await as(USERS.driver)).send({ type: 'BATTERY', intervalDays: 365 }).expect(403);
  });

  it('odometer readings never go backwards; the vehicle follows them', async () => {
    expect((await http().post(`/v1/vehicles/${vid}/odometer`).set(await as(USERS.driver)).send({ readingKm: 54_200 }).expect(201)).body.vehicle.odometerKm).toBe(54_200);
    expect((await http().post(`/v1/vehicles/${vid}/odometer`).set(await as(USERS.driver)).send({ readingKm: 54_000 }).expect(422)).body.detail).toMatch(/cannot go backwards/);
  });

  it('60/30/15 sweep: Istimara (≤30 tier), insurance (60), overdue Fahas, and the oil change within 1,000 km', async () => {
    await syncFleetReminders(worker, H1);
    const rs = await vehicleReminders();
    const tiers = rs.map((r) => [(r.titleI18n as { doc?: string; basis?: string }).doc ?? (r.titleI18n as { basis: string }).basis, (r.titleI18n as { tier: number }).tier]);
    expect(tiers).toEqual(expect.arrayContaining([['INSPECTION', 0], ['REGISTRATION', 30], ['REGISTRATION', 15], ['INSURANCE', 60], ['INSURANCE', 30], ['INSURANCE', 15], ['km', -1]]));
    expect(rs.find((r) => (r.titleI18n as { basis?: string }).basis === 'km')!.titleI18n).toMatchObject({ dueKm: 55_000, odometerKm: 54_200 });
    expect((await syncFleetReminders(worker, H1)).inserted).toBe(0); // idempotent
  });

  it('the maintenance alert goes out in the admins’ language with the km', async () => {
    const km = (await vehicleReminders()).find((r) => (r.titleI18n as { basis?: string }).basis === 'km')!;
    const sent: Array<{ channel: Channel; payload: any }> = [];
    const sender: ChannelSender = { send: async (channel, payload) => { sent.push({ channel, payload }); return { status: 'SENT' }; } };
    await dispatchNotifications(worker, sender, new Date(), { reminderIds: [km.id] });
    const inbox = await worker.run((tx) => tx.notification.findMany({ where: { reminderId: km.id, channel: 'IN_APP' } }));
    // ar-SA formats with Arabic-Indic digits
    expect(inbox.map((n) => n.body)).toContain('تغيير الزيت للمركبة ABC 1234 مستحقة عند ٥٥٬٠٠٠ كم');
  });

  it('completing the oil change resets the plan and clears the km alert', async () => {
    const s = await http().post(`/v1/vehicles/${vid}/maintenance`).set(await as(USERS.head)).send({ type: 'OIL_CHANGE', odometerKm: 55_100, workshop: 'Petromin', cost: 260 }).expect(201);
    expect(s.body).toMatchObject({ status: 'COMPLETED', nextDueKm: 60_100, plan: { lastDoneKm: 55_100, nextDueKm: 60_100, nextDueDate: riyadhDate(180), status: 'OK' } });
    expect((await http().get(`/v1/vehicles/${vid}`).set(await as(USERS.driver))).body.odometerKm).toBe(55_100);
    await syncFleetReminders(worker, H1);
    const plan = (await vehicleReminders()).filter((r) => r.entityId === oilPlan);
    expect(plan.filter((r) => (r.titleI18n as { basis: string }).basis === 'km')).toHaveLength(0);
    expect(plan.map((r) => (r.titleI18n as { tier: number }).tier)).toEqual([60, 30, 15]); // the next oil change, by date
  });
});

describe('fuel fill-ups paid from the driver’s float', () => {
  it('first fill: odometer + fuel log + PENDING_REVIEW petty-cash expense in one go', async () => {
    const r = await fill({ liters: 60, totalCost: 130.8, odometerKm: 55_200 });
    expect(r.fuel).toMatchObject({ liters: 60, pricePerLiter: 2.18, totalCost: '130.80', flagged: false, anomalies: [], kmSinceLast: null });
    expect(r.pettyCash).toMatchObject({ status: 'PENDING_REVIEW', amount: '130.80' });
    expect(r.vehicle.odometerKm).toBe(55_200);
  });

  it('normal consumption is not flagged; km/L is derived by the database', async () => {
    const r = await fill({ liters: 60, totalCost: 130.8, odometerKm: 55_620 });
    expect(r.fuel).toMatchObject({ kmSinceLast: 420, kmPerL: 7, flagged: false });
  });

  it('a fill that the distance cannot explain is flagged for review, with reasons', async () => {
    const r = await fill({ liters: 55, totalCost: 119.9, odometerKm: 55_700 });
    expect(r.fuel.flagged).toBe(true);
    expect(r.fuel.anomalies.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['EFFICIENCY_LOW']));
    const logs = (await http().get(`/v1/petty-cash/${floatId}/logs`).set(await as(USERS.head))).body.data;
    expect(logs.find((l: { id: string }) => l.id === r.pettyCash.id).description).toMatch(/flagged: .*EFFICIENCY_LOW/);
  });

  it('more litres than the tank holds → flagged', async () => {
    expect((await fill({ liters: 120, totalCost: 261.6, odometerKm: 56_400 })).fuel.anomalies.map((a: { code: string }) => a.code)).toContain('OVER_TANK');
  });

  it('hard rules: cost must equal litres × price; the odometer cannot go backwards', async () => {
    expect((await fill({ liters: 40, totalCost: 50, pricePerLiter: 2.18, odometerKm: 56_500 }, 422)).detail).toMatch(/does not match/);
    expect((await fill({ liters: 40, totalCost: 87.2, odometerKm: 50_000 }, 422)).detail).toMatch(/backwards/);
  });

  it('history and flagged list; other staff and households cannot log fuel for this car', async () => {
    const h = await http().get(`/v1/vehicles/${vid}/fuel`).set(await as(USERS.head)).expect(200);
    expect(h.body.summary).toMatchObject({ fills: 4, flagged: 2 });
    expect((await http().get(`/v1/vehicles/${vid}/fuel`).query({ flagged: 'true' }).set(await as(USERS.head))).body.data).toHaveLength(2);
    await http().post(`/v1/vehicles/${vid}/fuel`).set(await as(USERS.maid)).send({ liters: 10, totalCost: 21.8, odometerKm: 57_000 }).expect(404);
    await http().post(`/v1/vehicles/${vid}/fuel`).set(await as(USERS.head2, H2)).send({ liters: 10, totalCost: 21.8, odometerKm: 57_000 }).expect(404);
  });

  it('fleet overview for the office', async () => {
    const o = await http().get('/v1/fleet/overview').set(await as(USERS.efa)).expect(200);
    expect(o.body.documents.map((d: { doc: string }) => d.doc)).toEqual(['INSPECTION', 'REGISTRATION', 'INSURANCE']);
    expect(o.body.flaggedFuel.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fuel anomaly rules (unit)', () => {
  const base = { liters: 40, pricePerLiter: 2.18, totalCost: 87.2, filledAt: new Date('2026-11-04T10:00:00Z'), odometerKm: 10_400,
    vehicle: { fuelType: 'PETROL_91' as const, tankCapacityL: 60, expectedKmPerL: null }, previous: { filledAt: new Date('2026-11-01T10:00:00Z'), odometerKm: 10_000 }, history: [10, 11, 10.5] };
  it('baseline from the median of recent fills; within range is clean', () => {
    expect(checkFuel(base)).toMatchObject({ anomalies: [], kmSinceLast: 400, kmPerL: 10, baselineKmPerL: 10.5 });
  });
  it('flags fuel type, price, receipt mismatch, refill too soon and an odometer jump', () => {
    const codes = (x: object) => checkFuel({ ...base, ...x }).anomalies.map((a) => a.code);
    expect(codes({ fuelType: 'DIESEL' })).toContain('FUEL_TYPE_MISMATCH');
    expect(codes({ fuelType: 'PETROL_95' })).toEqual([]); // 95 in a 91 car is fine
    expect(codes({ pricePerLiter: 4, totalCost: 160 })).toContain('PRICE_OUT_OF_RANGE');
    expect(codes({ receiptTotal: 97.2 })).toContain('RECEIPT_MISMATCH');
    expect(codes({ odometerKm: 10_020, filledAt: new Date('2026-11-01T12:00:00Z') })).toContain('REFILL_TOO_SOON');
    expect(codes({ odometerKm: 11_500 })).toEqual(expect.arrayContaining(['ODOMETER_JUMP', 'EFFICIENCY_HIGH']));
  });
  it('no baseline yet → no efficiency verdict', () => {
    expect(checkFuel({ ...base, history: [9], odometerKm: 10_050 }).anomalies).toEqual([]);
  });
});
