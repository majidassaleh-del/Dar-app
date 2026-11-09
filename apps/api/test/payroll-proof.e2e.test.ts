import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { USERS, as, testEnv } from './helpers';

/**
 * Pay day 28 and paying worker by worker: a bank / Musaned transfer is proven by its
 * reference OR a screenshot of the transfer (bank transfers now go through Musaned).
 */
let app: INestApplication;
let runId = '';
const http = () => request(app.getHttpServer());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function screenshot(staffId: string, name = 'transfer.png') {
  const bytes = Buffer.from(`PNG transfer slip for ${staffId} ${name}`);
  const f = await http().post('/v1/files').set(await as(USERS.head)).send({ entityType: 'STAFF', entityId: staffId, staffId, fileName: name, mimeType: 'image/png',
    sizeBytes: bytes.length, sha256: sha(bytes) }).expect(201);
  await http().put(f.body.upload.url).set(await as(USERS.head)).set('Content-Type', 'application/octet-stream').send(bytes).expect(200);
  return f.body.id as string;
}

let mine: string[] = [];
beforeAll(async () => {
  testEnv(); app = await createApp(); await app.init();
  for (const n of ['Proof One', 'Proof Two']) {
    const s = (await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'COOK', fullName: { en: n }, nationality: 'PH', hireDate: '2026-06-01',
      defaultPayoutChannel: 'CASH' }).expect(201)).body;
    await http().post(`/v1/staff/${s.id}/contracts`).set(await as(USERS.head)).send({ startDate: '2026-06-01', basicSalary: 1500, allowances: [] }).expect(201);
    mine.push(s.id);
  }
});
afterAll(async () => { await app?.close(); });

describe('payroll: pay day and transfer screenshots', () => {
  it('the pulse uses pay day 28 (the default)', async () => {
    const p = (await http().get('/v1/dashboard/pulse').set(await as(USERS.head)).expect(200)).body.payroll;
    expect(p.payDay).toBe(28);
    expect(p.currentMonth.dueDate).toMatch(/-28$/);
    expect(p.due).toMatchObject({ period: expect.stringMatching(/^\d{4}-\d{2}$/), unpaidWorkers: expect.any(Number) });
  });

  it('pays one worker with only a screenshot; refuses neither-reference-nor-screenshot and another worker\'s file', async () => {
    const r = await http().post('/v1/payroll-runs').set(await as(USERS.head)).send({ year: 2031, month: 7 }).expect(201);
    runId = r.body.id;
    await http().post(`/v1/payroll-runs/${runId}/approve`).set(await as(USERS.head)).expect(201);
    const [a, b] = mine as [string, string];
    expect(r.body.staff.filter((s: { staffId: string; net: string }) => mine.includes(s.staffId) && Number(s.net) > 0)).toHaveLength(2);
    expect((await http().post(`/v1/payroll-runs/${runId}/pay/${a}`).set(await as(USERS.head)).send({ channel: 'BANK_TRANSFER' }).expect(400)).body.detail)
      .toMatch(/reference.*or proofFileId|screenshot/);
    const other = await screenshot(b, 'other.png');
    expect((await http().post(`/v1/payroll-runs/${runId}/pay/${a}`).set(await as(USERS.head)).send({ channel: 'BANK_TRANSFER', proofFileId: other }).expect(400)).body.detail)
      .toMatch(/another worker/);
    const proof = await screenshot(a);
    const paid = (await http().post(`/v1/payroll-runs/${runId}/pay/${a}`).set(await as(USERS.head)).send({ channel: 'BANK_TRANSFER', proofFileId: proof }).expect(201)).body;
    expect(paid.status).toBe('APPROVED'); // others still to pay
    const row = (await http().get('/v1/salary-payments').query({ year: 2031, month: 7, staffId: a }).set(await as(USERS.head)).expect(200)).body.data[0];
    expect(row).toMatchObject({ channel: 'BANK_TRANSFER', externalRef: null, proofFileId: proof, status: 'RECORDED' });
    await http().post(`/v1/payroll-runs/${runId}/pay/${a}`).set(await as(USERS.head)).send({ channel: 'BANK_TRANSFER', proofFileId: proof }).expect(409);
  });

  it('paying the rest at once skips the worker already paid and closes the run', async () => {
    const run = (await http().get(`/v1/payroll-runs/${runId}`).set(await as(USERS.head)).expect(200)).body;
    const payments = run.staff.filter((s: { net: string }) => Number(s.net) > 0).map((s: { staffId: string }) => ({ staffId: s.staffId, channel: 'CASH' }));
    const r = (await http().post(`/v1/payroll-runs/${runId}/pay`).set(await as(USERS.head)).send({ payments }).expect(201)).body;
    expect(r.status).toBe('PAID');
    expect(r.paymentsRecorded).toBe(payments.length - 1);
    await http().post(`/v1/payroll-runs/${runId}/pay/${payments[0].staffId}`).set(await as(USERS.head)).send({ channel: 'CASH' }).expect(422);
  });

  it('staff cannot see or pay a run', async () => {
    await http().post(`/v1/payroll-runs/${runId}/pay`).set(await as(USERS.nanny)).send({ payments: [] }).expect(404); // the run is not even visible to staff
  });
});
