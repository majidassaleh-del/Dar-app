import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys } from '../src/worker/jobs';
import { buildLines } from '../src/staff/payroll.controller';
import { H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
let workerStaffId: string;

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp();
  await app.init();
  // This suite uses its own worker (the nanny) so it never shares fixtures with staff.e2e.
  workerStaffId = (await http().post('/v1/staff').set(await as(USERS.head)).send({
    staffType: 'NANNY', fullName: { en: 'Tigist Bekele', am: 'ትግስት በቀለ' }, nationality: 'ET', membershipId: MEMBERSHIPS.nanny,
    hireDate: '2026-01-10', defaultPayoutChannel: 'BANK_TRANSFER', payoutIban: 'SA44 2000 0001 2345 6789 1234' }).expect(201)).body.id;
  await http().post(`/v1/staff/${workerStaffId}/contracts`).set(await as(USERS.head))
    .send({ startDate: '2026-01-10', basicSalary: 1500, allowances: [{ code: 'FOOD', amount: 200 }] }).expect(201);
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('attendance', () => {
  it('maid checks in for today (server-stamped); twice → 409', async () => {
    const r = await http().post('/v1/attendance/check-in').set(await as(USERS.nanny)).send({ geo: { lat: 24.7, lng: 46.7 } }).expect(201);
    expect(r.body).toMatchObject({ staffId: workerStaffId, date: riyadhDate(0), status: 'PRESENT' });
    expect(r.body.checkInAt).toBeTruthy();
    await http().post('/v1/attendance/check-in').set(await as(USERS.nanny)).send({}).expect(409);
  });

  it('checks out once', async () => {
    expect((await http().post('/v1/attendance/check-out').set(await as(USERS.nanny)).expect(201)).body.checkOutAt).toBeTruthy();
    await http().post('/v1/attendance/check-out').set(await as(USERS.nanny)).expect(409);
  });

  it('only managers correct attendance; non-staff cannot check in', async () => {
    await http().put(`/v1/attendance/${workerStaffId}/${riyadhDate(0)}`).set(await as(USERS.nanny)).send({ status: 'ABSENT' }).expect(403);
    const r = await http().put(`/v1/attendance/${workerStaffId}/${riyadhDate(-1)}`).set(await as(USERS.head)).send({ status: 'DAY_OFF' }).expect(200);
    expect(r.body.status).toBe('DAY_OFF');
    await http().post('/v1/attendance/check-in').set(await as(USERS.head)).send({}).expect(403);
  });
});

describe('leave via the approval workflow', () => {
  let leaveId: string;

  it('maid requests 3 days annual leave → routed to Head + EFA (not to herself)', async () => {
    const r = await http().post('/v1/requests').set(await as(USERS.nanny))
      .send({ type: 'LEAVE', leaveType: 'ANNUAL', startDate: '2026-12-20', endDate: '2026-12-22', title: 'Pasko sa bahay' }).expect(201);
    expect(r.body).toMatchObject({ type: 'LEAVE', status: 'IN_REVIEW', currentStep: 1 });
    expect(r.body.approvals).toHaveLength(2);
    leaveId = r.body.id;
  });

  it('the requester and non-approvers cannot decide', async () => {
    await http().post(`/v1/requests/${leaveId}/approve`).set(await as(USERS.nanny)).send({}).expect(403);
    await http().post(`/v1/requests/${leaveId}/approve`).set(await as(USERS.spouse)).send({}).expect(403);
  });

  it('Head approves → FULFILLED and a 3-day leave record exists', async () => {
    const r = await http().post(`/v1/requests/${leaveId}/approve`).set(await as(USERS.head)).send({ comment: 'Enjoy' }).expect(201);
    expect(r.body.status).toBe('FULFILLED');
    const leaves = await http().get('/v1/leaves').set(await as(USERS.nanny)).expect(200);
    expect(leaves.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: leaveId, type: 'ANNUAL', days: 3, paid: true })]));
  });

  it('a second approver cannot decide a finished request (422)', async () => {
    const r = await http().post(`/v1/requests/${leaveId}/approve`).set(await as(USERS.efa)).send({}).expect(422);
    expect(r.body.detail).toMatch(/already FULFILLED/);
  });

  it('leave balance: pro-rated entitlement, 3 days taken', async () => {
    const r = await http().get(`/v1/staff/${workerStaffId}/leave-balance`).query({ year: 2026 }).set(await as(USERS.nanny)).expect(200);
    expect(r.body.annual.taken).toBe(3);
    expect(r.body.annual.entitlement).toBeGreaterThan(28); // 30 days × (Jan 10 – Dec 31)/365
    expect(r.body.annual.remaining).toBeCloseTo(r.body.annual.entitlement - 3, 1);
  });

  it('a rejection needs a comment', async () => {
    const r = await http().post('/v1/requests').set(await as(USERS.nanny)).send({ type: 'LEAVE', leaveType: 'EMERGENCY', startDate: '2026-11-25', endDate: '2026-11-25' }).expect(201);
    await http().post(`/v1/requests/${r.body.id}/reject`).set(await as(USERS.efa)).send({}).expect(422);
    expect((await http().post(`/v1/requests/${r.body.id}/reject`).set(await as(USERS.efa)).send({ comment: 'Guests that day' }).expect(201)).body.status).toBe('REJECTED');
  });

  it('a worker cannot file leave for someone else (404: she cannot even see the colleague)', async () => {
    const other = await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'COOK', fullName: { en: 'Abebe' }, nationality: 'ET' }).expect(201);
    await http().post('/v1/requests').set(await as(USERS.nanny)).send({ type: 'LEAVE', leaveType: 'ANNUAL', startDate: '2026-12-01', endDate: '2026-12-02', staffId: other.body.id }).expect(404);
    // …and a manager can file on the cook's behalf.
    await http().post('/v1/requests').set(await as(USERS.head)).send({ type: 'LEAVE', leaveType: 'ANNUAL', startDate: '2026-12-01', endDate: '2026-12-02', staffId: other.body.id }).expect(201);
  });

  it('the requester can cancel while pending', async () => {
    const r = await http().post('/v1/requests').set(await as(USERS.nanny)).send({ type: 'LEAVE', leaveType: 'SICK', startDate: '2026-11-30', endDate: '2026-11-30' }).expect(201);
    expect((await http().post(`/v1/requests/${r.body.id}/cancel`).set(await as(USERS.nanny)).expect(201)).body.status).toBe('CANCELLED');
  });
});

describe('payroll runs and payslips', () => {
  let runId: string;
  const ref = (staffId: string) => ({ staffId, channel: 'CASH' as const });

  beforeAll(async () => {
    // Unpaid leave 7–8 Dec and a 600 SAR advance in 3 instalments, both through approvals.
    const unpaid = await http().post('/v1/requests').set(await as(USERS.nanny)).send({ type: 'LEAVE', leaveType: 'UNPAID', startDate: '2026-12-07', endDate: '2026-12-08' }).expect(201);
    await http().post(`/v1/requests/${unpaid.body.id}/approve`).set(await as(USERS.head)).send({}).expect(201);
    const adv = await http().post('/v1/requests').set(await as(USERS.nanny)).send({ type: 'SALARY_ADVANCE', amount: 600, installments: 3, reason: 'School fees' }).expect(201);
    expect((await http().post(`/v1/requests/${adv.body.id}/approve`).set(await as(USERS.efa)).send({}).expect(201)).body.status).toBe('FULFILLED');
  });

  it('buildLines: pro-rating; advance recovery capped at half the wage earned (Art. 9)', () => {
    const lines = buildLines({ staffId: 's', year: 2026, month: 1, basic: 1500, allowances: [{ code: 'FOOD', amount: 200 }],
      employedFrom: new Date('2026-01-10T00:00:00Z'), employedTo: null, unpaidLeaveDays: 0, advances: [{ id: 'a', outstanding: 5000, installment: 5000 }] });
    expect(lines.map((l) => [l.type, l.amount])).toEqual([['BASIC_SALARY', 1064.52], ['ALLOWANCE', 141.94], ['ADVANCE_RECOVERY', -603.23]]);
  });

  it('generates December: basic + allowance − unpaid leave ((1500 + 200) / 30 × 2) − advance instalment (200)', async () => {
    const r = await http().post('/v1/payroll-runs').set(await as(USERS.head)).send({ year: 2026, month: 12 }).expect(201);
    runId = r.body.id;
    const maid = r.body.staff.find((s: { staffId: string }) => s.staffId === workerStaffId);
    expect(maid.lines.map((l: { type: string; amount: string }) => [l.type, l.amount])).toEqual(expect.arrayContaining([
      ['BASIC_SALARY', '1500.00'], ['ALLOWANCE', '200.00'], ['UNPAID_LEAVE', '-113.33'], ['ADVANCE_RECOVERY', '-200.00']]));
    expect(maid.net).toBe('1386.67');
    expect(r.body.status).toBe('DRAFT');
  });

  it('a duplicate run for the same month → 409', async () => {
    await http().post('/v1/payroll-runs').set(await as(USERS.head)).send({ year: 2026, month: 12 }).expect(409);
  });

  it('the worker does not see a DRAFT payslip, nor the run itself', async () => {
    expect((await http().get('/v1/payslips').query({ year: 2026, month: 12 }).set(await as(USERS.nanny)).expect(200)).body.data).toEqual([]);
    await http().get(`/v1/payroll-runs/${runId}`).set(await as(USERS.nanny)).expect(404);
  });

  it('DRAFT is editable: a 50 SAR bonus raises net to 1436.67 and the run total follows', async () => {
    const before = (await http().get(`/v1/payroll-runs/${runId}`).set(await as(USERS.head)).expect(200)).body.totalAmount;
    const r = await http().post(`/v1/payroll-runs/${runId}/lines`).set(await as(USERS.head)).send({ staffId: workerStaffId, type: 'BONUS', amount: 50, description: 'National Day' }).expect(201);
    expect(r.body.staff.find((s: { staffId: string }) => s.staffId === workerStaffId).net).toBe('1436.67');
    expect(Number(r.body.totalAmount) - Number(before)).toBeCloseTo(50, 2);
  });

  it('after approval the lines are frozen', async () => {
    await http().post(`/v1/payroll-runs/${runId}/approve`).set(await as(USERS.head)).expect(201);
    await http().post(`/v1/payroll-runs/${runId}/lines`).set(await as(USERS.head)).send({ staffId: workerStaffId, type: 'BONUS', amount: 1, description: 'x' }).expect(422);
  });

  it('the worker now sees only her own payslip, in her language, without anyone else\'s pay', async () => {
    const r = await http().get('/v1/payslips').query({ year: 2026, month: 12 }).set(await as(USERS.nanny, undefined, 'ar')).expect(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ staffId: workerStaffId, runStatus: 'APPROVED', net: '1436.67' });
    expect(r.body.data[0].lines.map((l: { description: string }) => l.description)).toContain('الراتب الأساسي');
    expect(JSON.stringify(r.body)).not.toContain('totalAmount');
  });

  it('paying validates every worker first (bank transfer needs a reference) — nothing is written on failure', async () => {
    const run = (await http().get(`/v1/payroll-runs/${runId}`).set(await as(USERS.head))).body;
    const others = run.staff.filter((s: { staffId: string; net: string }) => s.staffId !== workerStaffId && Number(s.net) > 0).map((s: { staffId: string }) => ref(s.staffId));
    const r = await http().post(`/v1/payroll-runs/${runId}/pay`).set(await as(USERS.head)).send({ payments: others }).expect(400);
    expect(r.body.detail).toMatch(/BANK_TRANSFER needs externalRef/);
    const paid = await http().get('/v1/salary-payments').query({ year: 2026, month: 12 }).set(await as(USERS.head)).expect(200);
    expect(paid.body.data).toEqual([]);
  });

  it('pay → one SalaryPayment per worker, advance reduced, run PAID and final', async () => {
    const run = (await http().get(`/v1/payroll-runs/${runId}`).set(await as(USERS.head))).body;
    const payments = run.staff.filter((s: { net: string }) => Number(s.net) > 0)
      .map((s: { staffId: string }) => s.staffId === workerStaffId ? { staffId: s.staffId, externalRef: 'ALRAJHI-DEC-0001' } : ref(s.staffId));
    const r = await http().post(`/v1/payroll-runs/${runId}/pay`).set(await as(USERS.head)).send({ payments }).expect(201);
    expect(r.body.status).toBe('PAID');
    expect(r.body.paymentsRecorded).toBe(payments.length);
    const slip = (await http().get('/v1/payslips').query({ year: 2026, month: 12 }).set(await as(USERS.nanny)).expect(200)).body.data[0];
    expect(slip.payments).toEqual([expect.objectContaining({ amount: '1436.67', channel: 'BANK_TRANSFER', externalRef: 'ALRAJHI-DEC-0001', status: 'RECORDED' })]);
    const [adv] = await worker.run((tx) => tx.$queryRaw<Array<{ o: string }>>`SELECT outstanding::text AS o FROM salary_advances WHERE "staffId" = ${workerStaffId}::uuid`);
    expect(adv!.o).toBe('400.00');
    await http().post(`/v1/payroll-runs/${runId}/pay`).set(await as(USERS.head)).send({ payments }).expect(422);
    await http().post(`/v1/payroll-runs/${runId}/reopen`).set(await as(USERS.head)).expect(422);
  });

  it('the worker can acknowledge the payroll payment like any other', async () => {
    const slip = (await http().get('/v1/payslips').query({ year: 2026, month: 12 }).set(await as(USERS.nanny))).body.data[0];
    await http().post(`/v1/salary-payments/${slip.payments[0].id}/acknowledge`).set(await as(USERS.nanny)).send({}).expect(201);
  });

  it('staff cannot create payroll runs', async () => {
    await http().post('/v1/payroll-runs').set(await as(USERS.nanny)).send({ year: 2027, month: 1 }).expect(403);
  });
});

describe('chores', () => {
  let taskId: string;

  it('Head assigns a chore in Arabic; the maid sees it', async () => {
    const r = await http().post('/v1/tasks').set(await as(USERS.head, undefined, 'ar'))
      .send({ title: 'تنظيف المجلس قبل وصول الضيوف', assigneeId: MEMBERSHIPS.nanny, dueAt: '2026-11-05T15:00:00+03:00' }).expect(201);
    taskId = r.body.id;
    const mine = await http().get('/v1/tasks').query({ assignee: 'me' }).set(await as(USERS.nanny, undefined, 'tl')).expect(200);
    expect(mine.body.data).toEqual([expect.objectContaining({ id: taskId, title: 'تنظيف المجلس قبل وصول الضيوف', status: 'TODO' })]);
  });

  it('the assignee may progress it and attach proof, but not edit or cancel it', async () => {
    await http().patch(`/v1/tasks/${taskId}`).set(await as(USERS.nanny)).send({ status: 'IN_PROGRESS' }).expect(200);
    await http().patch(`/v1/tasks/${taskId}`).set(await as(USERS.nanny)).send({ title: 'nothing to do' }).expect(403);
    await http().patch(`/v1/tasks/${taskId}`).set(await as(USERS.nanny)).send({ status: 'CANCELLED' }).expect(403);
    await http().delete(`/v1/tasks/${taskId}`).set(await as(USERS.nanny)).expect(403);
    const done = await http().patch(`/v1/tasks/${taskId}`).set(await as(USERS.nanny)).send({ status: 'DONE', proofPhotoUrl: 'https://files.example/majlis.jpg' }).expect(200);
    expect(done.body.completedAt).toBeTruthy();
  });

  it('another household cannot see it', async () => {
    expect((await http().get('/v1/tasks').set(await as(USERS.head2, H2)).expect(200)).body.data).toEqual([]);
  });
});
