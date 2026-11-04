import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { H2, MEMBERSHIPS, USERS, as, testEnv } from './helpers';

let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => { testEnv(); app = await createApp(); await app.init(); });
afterAll(async () => { await app?.close(); });

describe('petty cash', () => {
  let floatId: string;
  let expenseId: string;

  it('Head opens a 500 SAR float for the housekeeper; staff cannot open floats', async () => {
    const r = await http().post('/v1/petty-cash').set(await as(USERS.head))
      .send({ custodianId: MEMBERSHIPS.maid, name: 'Groceries float', floatLimit: 500, receiptRequiredOver: 100, lowBalanceAlert: 50 }).expect(201);
    expect(r.body).toMatchObject({ balance: '0.00', floatLimit: '500.00', custodianId: MEMBERSHIPS.maid });
    floatId = r.body.id;
    await http().post('/v1/petty-cash').set(await as(USERS.maid)).send({ custodianId: MEMBERSHIPS.maid, name: 'x', floatLimit: 1 }).expect(403);
  });

  it('top-ups respect the float limit', async () => {
    expect((await http().post(`/v1/petty-cash/${floatId}/top-ups`).set(await as(USERS.head)).send({ amount: 400 }).expect(201)).body.float.balance).toBe('400.00');
    const r = await http().post(`/v1/petty-cash/${floatId}/top-ups`).set(await as(USERS.head)).send({ amount: 200 }).expect(422);
    expect(r.body.detail).toMatch(/exceeds float limit/);
  });

  it('the custodian logs an expense (pending review); over 100 SAR needs a receipt', async () => {
    const r = await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.maid, undefined, 'tl'))
      .send({ amount: 80, description: 'Gulay at prutas', merchantName: 'Panda' }).expect(201);
    expect(r.body.entry).toMatchObject({ type: 'EXPENSE', status: 'PENDING_REVIEW', balanceAfter: '320.00' });
    expenseId = r.body.entry.id;
    expect((await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.maid)).send({ amount: 150, description: 'Rice' }).expect(422)).body.detail).toMatch(/receipt required/);
  });

  it('the custodian cannot top up or review her own expense', async () => {
    await http().post(`/v1/petty-cash/${floatId}/top-ups`).set(await as(USERS.maid)).send({ amount: 10 }).expect(403);
    await http().post(`/v1/petty-cash/logs/${expenseId}/review`).set(await as(USERS.maid)).send({ decision: 'APPROVED' }).expect(403);
  });

  it('Head approves the expense once', async () => {
    expect((await http().post(`/v1/petty-cash/logs/${expenseId}/review`).set(await as(USERS.head)).send({ decision: 'APPROVED' }).expect(201)).body)
      .toMatchObject({ status: 'APPROVED', reviewedById: expect.any(String) });
    await http().post(`/v1/petty-cash/logs/${expenseId}/review`).set(await as(USERS.head)).send({ decision: 'REJECTED' }).expect(403);
  });

  it('returning cash flags a low balance; no overdraft', async () => {
    const r = await http().post(`/v1/petty-cash/${floatId}/returns`).set(await as(USERS.maid)).send({ amount: 300 }).expect(201);
    expect(r.body.float).toMatchObject({ balance: '20.00', lowBalance: true });
    expect((await http().post(`/v1/petty-cash/${floatId}/expenses`).set(await as(USERS.maid)).send({ amount: 50, description: 'Water' }).expect(422)).body.detail).toMatch(/insufficient petty cash/);
  });

  it('reconciliation turns a counted variance into an adjustment', async () => {
    const r = await http().post(`/v1/petty-cash/${floatId}/reconcile`).set(await as(USERS.head)).send({ countedCash: 15 }).expect(201);
    expect(r.body).toMatchObject({ expected: '20.00', counted: '15.00', variance: '-5.00', float: { balance: '15.00' } });
    expect(r.body.adjustment).toMatchObject({ type: 'ADJUSTMENT', amount: '-5.00' });
    expect(r.body.float.lastReconciledAt).toBeTruthy();
  });

  it('each custodian sees only their own float; other households see none', async () => {
    await http().post('/v1/petty-cash').set(await as(USERS.head)).send({ custodianId: MEMBERSHIPS.spouse, name: 'Spouse float', floatLimit: 1000 }).expect(201);
    const mine = await http().get('/v1/petty-cash').set(await as(USERS.maid)).expect(200);
    expect(mine.body.data.map((f: { id: string }) => f.id)).toEqual([floatId]);
    expect((await http().get('/v1/petty-cash').set(await as(USERS.head2, H2)).expect(200)).body.data).toEqual([]);
    const logs = await http().get(`/v1/petty-cash/${floatId}/logs`).set(await as(USERS.maid)).expect(200);
    expect(logs.body.data.map((l: { type: string }) => l.type)).toEqual(expect.arrayContaining(['TOP_UP', 'EXPENSE', 'RETURN', 'ADJUSTMENT']));
  });
});

describe('work orders with multilingual instructions', () => {
  let woId: string;

  it('an Arabic safety-critical instruction for a Tagalog reader defers the assignment', async () => {
    const r = await http().post('/v1/work-orders').set(await as(USERS.head, undefined, 'ar')).send({
      title: 'غداء الأطفال', category: 'COOKING', priority: 'HIGH', assigneeId: MEMBERSHIPS.maid,
      instructions: [
        { text: 'أحمد لديه حساسية من الفول السوداني — لا تستخدمي أي منتج يحتوي عليه', isSafetyCritical: true },
        { text: 'صوّري الطبق قبل التقديم', requiresPhoto: true },
      ],
    }).expect(201);
    expect(r.body).toMatchObject({ status: 'NEW', assigneeId: null, number: expect.stringMatching(/^WO-\d{4}$/) });
    expect(r.body.instructions.map((i: { translationStatus: string }) => i.translationStatus)).toEqual(['PENDING', 'PENDING']);
    expect(r.body.warnings[0]).toMatch(/assignment deferred.*safety-critical.*tl/);
    woId = r.body.id;
  });

  it('assigning before review is refused by the database', async () => {
    const r = await http().post(`/v1/work-orders/${woId}/assign`).set(await as(USERS.head)).send({ assigneeId: MEMBERSHIPS.maid }).expect(422);
    expect(r.body.detail).toMatch(/human-reviewed translation/);
  });

  it('a person supplies the Tagalog translation → HUMAN_REVIEWED → dispatch succeeds', async () => {
    const t = await http().post(`/v1/work-orders/${woId}/instructions/1/translations/tl`).set(await as(USERS.efa))
      .send({ text: 'May allergy sa mani si Ahmed — huwag gumamit ng anumang may mani' }).expect(201);
    expect(t.body.instructions[0].translationStatus).toBe('HUMAN_REVIEWED');
    expect((await http().post(`/v1/work-orders/${woId}/assign`).set(await as(USERS.head)).send({ assigneeId: MEMBERSHIPS.maid }).expect(201)).body.status).toBe('ASSIGNED');
  });

  it('the maid reads it in Tagalog, flagged as translated, with the Arabic original kept', async () => {
    const r = await http().get(`/v1/work-orders/${woId}`).set(await as(USERS.maid, undefined, 'tl')).expect(200);
    expect(r.body.instructions[0]).toMatchObject({ text: 'May allergy sa mani si Ahmed — huwag gumamit ng anumang may mani', translated: true,
      originalLocale: 'ar', originalText: expect.stringContaining('حساسية') });
    expect(r.body.instructions[1]).toMatchObject({ translationStatus: 'PENDING', translated: false }); // non-critical: shown in Arabic until translated
  });

  it('the assignee cannot edit the order or the instruction text', async () => {
    await http().patch(`/v1/work-orders/${woId}`).set(await as(USERS.maid)).send({ title: 'no allergy' }).expect(403);
    await http().post(`/v1/work-orders/${woId}/instructions/1/translations/tl`).set(await as(USERS.maid)).send({ text: 'walang allergy' }).expect(403);
  });

  it('progress: IN_PROGRESS stamps startedAt; completing needs every instruction (and the photo)', async () => {
    expect((await http().patch(`/v1/work-orders/${woId}`).set(await as(USERS.maid)).send({ status: 'IN_PROGRESS' }).expect(200)).body.startedAt).toBeTruthy();
    expect((await http().patch(`/v1/work-orders/${woId}`).set(await as(USERS.maid)).send({ status: 'COMPLETED' }).expect(422)).body.detail).toMatch(/complete every instruction/);
    await http().patch(`/v1/work-orders/${woId}/instructions/1`).set(await as(USERS.maid)).send({ completed: true }).expect(200);
    expect((await http().patch(`/v1/work-orders/${woId}/instructions/2`).set(await as(USERS.maid)).send({ completed: true }).expect(422)).body.detail).toMatch(/needs a photo/);
    await http().patch(`/v1/work-orders/${woId}/instructions/2`).set(await as(USERS.maid)).send({ completed: true, photoStorageKey: 'h1/wo/plate.jpg' }).expect(200);
    expect((await http().patch(`/v1/work-orders/${woId}`).set(await as(USERS.maid)).send({ status: 'COMPLETED', actualCost: 45 }).expect(200)).body)
      .toMatchObject({ status: 'COMPLETED', actualCost: '45.00' });
  });

  it('only the requester verifies (and rates) the work', async () => {
    await http().post(`/v1/work-orders/${woId}/verify`).set(await as(USERS.maid)).send({ rating: 5 }).expect(403);
    expect((await http().post(`/v1/work-orders/${woId}/verify`).set(await as(USERS.head)).send({ rating: 5 }).expect(201)).body)
      .toMatchObject({ status: 'VERIFIED', rating: 5 });
  });

  it('non-critical instructions do not block dispatch', async () => {
    const r = await http().post('/v1/work-orders').set(await as(USERS.head, undefined, 'ar')).send({
      title: 'سقي الحديقة', category: 'GARDENING', assigneeId: MEMBERSHIPS.maid, instructions: [{ text: 'اسقِ الأشجار بعد المغرب' }] }).expect(201);
    expect(r.body).toMatchObject({ status: 'ASSIGNED', assigneeId: MEMBERSHIPS.maid, warnings: [] });
  });

  it('staff can raise a work order; other households see nothing', async () => {
    const r = await http().post('/v1/work-orders').set(await as(USERS.maid, undefined, 'tl'))
      .send({ title: 'Tumutulo ang AC sa kwarto ng mga bata', category: 'MAINTENANCE' }).expect(201);
    expect(r.body).toMatchObject({ requesterId: MEMBERSHIPS.maid, status: 'NEW' });
    const ar = await http().get(`/v1/work-orders/${r.body.id}`).set(await as(USERS.head, undefined, 'ar')).expect(200);
    expect(ar.body).toMatchObject({ title: 'Tumutulo ang AC sa kwarto ng mga bata', titleTranslated: false });
    await http().get(`/v1/work-orders/${woId}`).set(await as(USERS.head2, H2)).expect(404);
  });
});
