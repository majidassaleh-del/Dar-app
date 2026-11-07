import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { accrueEndOfService } from '../src/worker/jobs';
import { computeEsb, computeLeave, unpaidLeaveDeduction } from '../src/hr/esb';
import { buildLines } from '../src/staff/payroll.controller';
import { dispatchNotifications } from '../src/notifications/dispatch';
import { H1, H2, MEMBERSHIPS, USERS, as, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
let staffId = '';
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const c = (start: string, end: string | null, basic = 2000, allowances = [{ code: 'FOOD', amount: 300 }]) =>
  ({ startDate: D(start), endDate: end ? D(end) : null, basicSalary: basic, allowances });

describe('end-of-service rules (unit)', () => {
  it('Art. 16: nothing before 4 consecutive years; one month’s wage (basic + allowances) at 4', () => {
    expect(computeEsb({ contracts: [c('2022-11-05', null)], asOf: D('2026-11-03') })).toMatchObject({ serviceDays: 1460, vested: '0.00', completedFourYearPeriods: 0, nextVestingDate: '2026-11-04' });
    expect(computeEsb({ contracts: [c('2022-11-05', null)], asOf: D('2026-11-04') })).toMatchObject({ serviceDays: 1461, monthlyWage: '2300.00', vested: '2300.00', provision: '2300.00' });
  });

  it('per-4-years (default) vs single award vs Labor Law by contract, after 9 years', () => {
    const contracts = [c('2017-01-01', null)];
    const asOf = D('2025-12-31'); // 3287 days = 2 full 4-year periods
    expect(computeEsb({ contracts, asOf })).toMatchObject({ rule: 'SA_DOMESTIC', completedFourYearPeriods: 2, vested: '4600.00' });
    expect(computeEsb({ rule: 'SA_DOMESTIC_SINGLE', contracts, asOf })).toMatchObject({ vested: '2300.00', provision: '2300.00' });
    const ll = computeEsb({ rule: 'SA_LABOR_LAW', contracts, asOf })!;
    expect(Number(ll.vested)).toBeCloseTo(2300 * (2.5 + (3287 / 365.25 - 5)), 0); // ½ month × 5 years + 1 month × the rest
  });

  it('unpaid leave is not service; a gap between contracts breaks continuity; the provision accrues pro rata', () => {
    expect(computeEsb({ contracts: [c('2022-11-05', null)], asOf: D('2026-11-04'), unpaidLeaveDays: 10 })).toMatchObject({ serviceDays: 1451, vested: '0.00', nextVestingDate: '2026-11-14' });
    const broken = computeEsb({ contracts: [c('2018-01-01', '2021-12-31'), c('2022-03-01', null)], asOf: D('2026-02-27') })!; // one day short of 4 years
    expect(broken).toMatchObject({ serviceStart: '2022-03-01', vested: '0.00' });
    expect(broken).toMatchObject({ serviceMonths: 47, provision: '2252.08', monthlyProvision: '47.92' }); // 47 completed months × 2,300 / 48
    expect(computeEsb({ contracts: [c('2021-01-01', '2023-12-31'), c('2024-01-01', null)], asOf: D('2026-01-01') })!.serviceStart).toBe('2021-01-01');
  });

  it('liability provisioning is monthly wage / 48 per completed month; Labor Law stays a contract override', () => {
    expect(computeEsb({ contracts: [c('2025-01-01', null)], asOf: D('2025-12-31') })).toMatchObject({ serviceMonths: 12, provision: '575.00', monthlyProvision: '47.92', vested: '0.00' });
    expect(computeEsb({ contracts: [c('2025-01-01', null)], asOf: D('2026-01-30') })).toMatchObject({ serviceMonths: 12 }); // not yet 13
    expect(computeEsb({ rule: 'SA_LABOR_LAW', contracts: [c('2025-01-01', null)], asOf: D('2025-12-31') })!.basis).toBe('Labor Law Art. 84 (contract override)');
    expect(computeEsb({ rule: 'anything-else', contracts: [c('2025-01-01', null)], asOf: D('2025-12-31') })!.rule).toBe('SA_DOMESTIC');
  });

  it('Art. 10 leave: 15 days a year accrued, 30 vested per 2 completed years; unused leave paid at wage / 30', () => {
    const lc = (perYear: number) => [{ ...c('2023-01-01', null), annualLeaveDays: perYear }];
    const two = computeLeave({ contracts: lc(15), asOf: D('2024-12-31'), takenDays: 0 })!;
    expect(two).toMatchObject({ daysPerTwoYears: 30, serviceDays: 731, completedTwoYearCycles: 1, vestedDays: 30, dailyRate: '76.67' });
    expect(two.accruedDays).toBeCloseTo(30.02, 2);
    const used = computeLeave({ contracts: lc(15), asOf: D('2024-12-31'), takenDays: 20 })!;
    expect(used).toMatchObject({ balanceDays: 10.02, availableNowDays: 10, unusedLeavePayout: '768.20' }); // 2,300 / 30 × 10.02
    expect(computeLeave({ contracts: lc(15), asOf: D('2024-12-30'), takenDays: 0 })!.completedTwoYearCycles).toBe(0);
    expect(computeLeave({ contracts: lc(30), asOf: D('2024-12-31'), takenDays: 0 })).toMatchObject({ daysPerYear: 30, vestedDays: 60, basis: 'Contract (above the Art. 10 minimum)' });
    expect(computeLeave({ contracts: lc(5), asOf: D('2024-12-31'), takenDays: 0 })!.daysPerYear).toBe(15); // never below the statutory minimum
    expect(computeLeave({ contracts: lc(15), asOf: D('2024-12-31'), takenDays: 0, unpaidLeaveDays: 10 })!.completedTwoYearCycles).toBe(0); // unpaid leave delays the cycle
  });

  it('unpaid leave deduction = (monthly wage / 30) × days, exact to the halala', () => {
    expect(unpaidLeaveDeduction(170_000, 2)).toBe(11_333);   // 1,700 / 30 × 2 = 113.333…
    expect(unpaidLeaveDeduction(170_000, 1.5)).toBe(8_500);  // half days
    expect(unpaidLeaveDeduction(123_456, 7)).toBe(28_806);   // 1,234.56 / 30 × 7 = 288.064
    expect(unpaidLeaveDeduction(100_001, 3)).toBe(10_000);   // 1,000.01 / 30 × 3 = 100.001
    const lines = buildLines({ staffId: 's', year: 2026, month: 2, basic: 2000, allowances: [{ code: 'FOOD', amount: 300 }], employedFrom: D('2025-01-01'),
      employedTo: null, unpaidLeaveDays: 3, advances: [] });
    expect(lines.find((l) => l.type === 'UNPAID_LEAVE')!.amount).toBe(-230); // 2,300 / 30 × 3 (not the 28 days of February)
  });
});

describe('ESB, advances and salary acknowledgment (API)', () => {
  beforeAll(async () => {
    testEnv();
    worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
    app = await createApp(); await app.init();
    staffId = (await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'DRIVER', fullName: { en: 'Rahim Uddin', bn: 'রহিম উদ্দিন' },
      nationality: 'BD', membershipId: MEMBERSHIPS.driver, hireDate: '2021-03-01' }).expect(201)).body.id;
    await http().post(`/v1/staff/${staffId}/contracts`).set(await as(USERS.head)).send({ startDate: '2021-03-01', basicSalary: 2000, allowances: [{ code: 'FOOD', amount: 300 }] }).expect(201);
  });
  afterAll(async () => { await app?.close(); await worker?.close(); });

  it('the worker and the office see the same ESB; other workers and households do not', async () => {
    const mine = await http().get(`/v1/staff/${staffId}/end-of-service`).query({ asOf: '2026-11-04' }).set(await as(USERS.driver)).expect(200);
    expect(mine.body).toMatchObject({ rule: 'SA_DOMESTIC', serviceStart: '2021-03-01', monthlyWage: '2300.00', completedFourYearPeriods: 1, vested: '2300.00',
      nextVestingDate: '2029-02-28', basis: 'Domestic Workers Regulation Art. 16' });
    const office = await http().get(`/v1/staff/${staffId}/end-of-service`).query({ asOf: '2026-11-04' }).set(await as(USERS.efa)).expect(200);
    expect(office.body.provision).toBe(mine.body.provision);
    await http().get(`/v1/staff/${staffId}/end-of-service`).set(await as(USERS.maid)).expect(404);
    await http().get(`/v1/staff/${staffId}/end-of-service`).set(await as(USERS.head2, H2)).expect(404);
  });

  it('household liability is for Head / EFA only', async () => {
    const r = await http().get('/v1/hr/end-of-service').query({ asOf: '2026-11-04' }).set(await as(USERS.head)).expect(200);
    expect(r.body.data.find((x: { staffId: string }) => x.staffId === staffId)).toMatchObject({ vested: '2300.00' });
    expect(Number(r.body.totalVested)).toBeGreaterThanOrEqual(2300);
    await http().get('/v1/hr/end-of-service').set(await as(USERS.spouse)).expect(403);
    await http().get('/v1/hr/end-of-service').set(await as(USERS.driver)).expect(403);
  });

  it('monthly accrual snapshots are idempotent and carry the change since last month', async () => {
    await accrueEndOfService(worker, 2026, 9, H1);
    await accrueEndOfService(worker, 2026, 10, H1);
    await accrueEndOfService(worker, 2026, 10, H1);
    const rows = await worker.run((tx) => tx.esbAccrual.findMany({ where: { staffId }, orderBy: { periodMonth: 'asc' } }));
    expect(rows.map((r) => r.periodMonth)).toEqual([9, 10]);
    expect(Number(rows[1]!.delta)).toBeCloseTo(2300 / 48, 1); // one more month: monthly wage / 48 (deltas sum exactly to the rounded provision)
    expect((await http().get(`/v1/staff/${staffId}/end-of-service`).set(await as(USERS.driver))).body.accruals[0]).toMatchObject({ period: '2026-10' });
  });

  it('advances breakdown: granted, repaid, outstanding — the worker sees their own', async () => {
    const req = await http().post('/v1/requests').set(await as(USERS.driver)).send({ type: 'SALARY_ADVANCE', amount: 900, installments: 3, reason: 'Family' }).expect(201);
    await http().post(`/v1/requests/${req.body.id}/approve`).set(await as(USERS.efa)).send({}).expect(201);
    const r = await http().get('/v1/me/advances').set(await as(USERS.driver)).expect(200);
    expect(r.body).toMatchObject({ staffId, totalGranted: '900.00', totalRepaid: '0.00', currentOutstanding: '900.00', openAdvances: 1 });
    expect(r.body.data[0]).toMatchObject({ monthlyInstallment: '300.00', installmentsLeft: 3, recoveries: [] });
    await http().get('/v1/me/advances').set(await as(USERS.spouse)).expect(404);
    await http().get(`/v1/staff/${staffId}/advances`).set(await as(USERS.maid)).expect(404);
    expect((await http().get(`/v1/staff/${staffId}/advances`).set(await as(USERS.head)).expect(200)).body.currentOutstanding).toBe('900.00');
  });

  it('final settlement: ESB (1 × wage) + unused leave at wage / 30; advances shown separately; contracts cannot go below Art. 10', async () => {
    const r = await http().get(`/v1/staff/${staffId}/final-settlement`).query({ asOf: '2026-11-04' }).set(await as(USERS.efa)).expect(200);
    expect(r.body).toMatchObject({ endOfService: { rule: 'SA_DOMESTIC', amount: '2300.00' }, unusedLeave: { dailyRate: '76.67', amount: '6533.53' },
      totalDue: '8833.53', advancesOutstanding: '900.00', totalAfterAdvances: '7933.53' });
    expect(r.body.unusedLeave.days).toBeCloseTo((15 * 2075) / 365.25, 2); // 1 Mar 2021 – 4 Nov 2026, nothing taken
    await http().get(`/v1/staff/${staffId}/final-settlement`).set(await as(USERS.maid)).expect(404);
    const bad = await http().post(`/v1/staff/${staffId}/contracts`).set(await as(USERS.head)).send({ startDate: '2027-01-01', basicSalary: 2000, annualLeaveDays: 10 }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/Art\. 10/);
  });

  it('a recorded salary asks the worker to confirm (now, +3 d, +7 d); acknowledging withdraws the rest', async () => {
    const p = await http().post(`/v1/staff/${staffId}/salary-payments`).set(await as(USERS.head)).send({ periodYear: 2026, periodMonth: 10, channel: 'CASH' }).expect(201);
    const reminders = () => worker.run((tx) => tx.reminder.findMany({ where: { entityId: p.body.id }, orderBy: { remindAt: 'asc' } }));
    const rs = await reminders();
    expect(rs.map((r) => [r.recipientId, (r.titleI18n as { tier: number }).tier, r.status])).toEqual([
      [MEMBERSHIPS.driver, 0, 'PENDING'], [MEMBERSHIPS.driver, 3, 'PENDING'], [MEMBERSHIPS.driver, 7, 'PENDING']]);
    await dispatchNotifications(worker, { send: async () => ({ status: 'SENT' }) }, new Date(), { reminderIds: rs.map((r) => r.id) });
    const inbox = await http().get('/v1/notifications').set(await as(USERS.driver)).expect(200);
    const n = inbox.body.data.find((x: { deepLink: string }) => x.deepLink === `herp://salary-payments/${p.body.id}/acknowledge`);
    expect(n).toMatchObject({ locale: 'bn' });
    expect(n.body).toContain('2026-10');
    expect(n.body).toContain('2300.00 SAR');
    const wa = await worker.run((tx) => tx.notification.findFirst({ where: { reminderId: rs[0]!.id, channel: 'WHATSAPP' } }));
    expect(wa).toMatchObject({ status: 'SKIPPED', error: 'user has no phone number' });
    await http().post(`/v1/salary-payments/${p.body.id}/acknowledge`).set(await as(USERS.driver)).send({}).expect(201);
    expect((await reminders()).map((r) => r.status)).toEqual(['SENT']); // the +3 d and +7 d reminders are gone
  });
});

describe('labor rules in the database', () => {
  it('Art. 9: a manual deduction that would take more than half the wage is refused', async () => {
    const run = await http().post('/v1/payroll-runs').set(await as(USERS.head)).send({ year: 2027, month: 4 }).expect(201);
    const me = run.body.staff.find((s: { staffId: string }) => s.staffId === staffId);
    expect(me.lines.find((l: { type: string }) => l.type === 'ADVANCE_RECOVERY').amount).toBe('-300.00');
    const r = await http().post(`/v1/payroll-runs/${run.body.id}/lines`).set(await as(USERS.head)).send({ staffId, type: 'DEDUCTION', amount: 900, description: 'Damaged phone' }).expect(422);
    expect(r.body.detail).toMatch(/exceed half .*Art\. 9/);
    await http().post(`/v1/payroll-runs/${run.body.id}/lines`).set(await as(USERS.head)).send({ staffId, type: 'DEDUCTION', amount: 800, description: 'Damaged phone' }).expect(201);
    await http().post(`/v1/payroll-runs/${run.body.id}/cancel`).set(await as(USERS.head)).expect(201);
  });

  it('Art. 11: paid sick leave is capped at 30 days a year; the excess becomes unpaid', async () => {
    await worker.run(async (tx) => {
      await tx.leaveRecord.create({ data: { householdId: H1, staffId, type: 'SICK', startDate: D('2026-05-01'), endDate: D('2026-05-20'), days: 20, paid: true } });
      await tx.leaveRecord.create({ data: { householdId: H1, staffId, type: 'SICK', startDate: D('2026-07-01'), endDate: D('2026-07-15'), days: 15, paid: true } });
    });
    const rows = await worker.run((tx) => tx.leaveRecord.findMany({ where: { staffId, type: 'SICK' }, orderBy: { startDate: 'asc' } }));
    expect(rows.map((r) => [r.startDate.toISOString().slice(0, 10), r.endDate.toISOString().slice(0, 10), Number(r.days), r.paid])).toEqual([
      ['2026-05-01', '2026-05-20', 20, true], ['2026-07-01', '2026-07-10', 10, true], ['2026-07-11', '2026-07-15', 5, false]]);
  });
});
