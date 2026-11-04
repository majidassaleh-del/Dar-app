import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys } from '../src/worker/jobs';
import { H1, H2, MEMBERSHIPS, USERS, as, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
const DEVICE = 'ios-install-7f3a9c21';
let taskId = '';
let woId = '';
let instrIds: string[] = [];

const push = async (ops: object[], user: string = USERS.cook, household: string = H1) =>
  (await http().post('/v1/sync/push').set(await as(user, household)).send({ deviceId: DEVICE, ops }).expect(201)).body.results as Array<Record<string, any>>;
const taskOp = (data: object, baseVersion: number, opId = randomUUID()) =>
  ({ opId, kind: 'TASK_UPDATE', entityId: taskId, baseVersion, clientAt: new Date().toISOString(), data });

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp(); await app.init();
  taskId = (await http().post('/v1/tasks').set(await as(USERS.head, H1, 'ar')).send({ title: 'تجهيز الغداء', assigneeId: MEMBERSHIPS.cook }).expect(201)).body.id;
  const wo = await http().post('/v1/work-orders').set(await as(USERS.head, H1, 'en')).send({ title: 'Deep-clean the kitchen', category: 'CLEANING',
    assigneeId: MEMBERSHIPS.cook, instructions: [{ text: 'Empty the fridge' }, { text: 'Photo of the clean oven', requiresPhoto: true }] }).expect(201);
  woId = wo.body.id;
  instrIds = (await worker.run((tx) => tx.workOrderInstruction.findMany({ where: { workOrderId: woId }, orderBy: { sequence: 'asc' } }))).map((i) => i.id);
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('pull', () => {
  it('the worker gets her own chores and instructions with versions and a cursor', async () => {
    const r = await http().get('/v1/sync/pull').set(await as(USERS.cook, H1, 'ar')).expect(200);
    expect(r.body.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: taskId, status: 'TODO', version: 1, title: 'تجهيز الغداء' })]));
    expect(r.body.instructions.filter((i: { workOrderId: string }) => i.workOrderId === woId)).toHaveLength(2);
    expect(Date.parse(r.body.cursor)).toBeLessThan(Date.now());
    const spouse = await http().get('/v1/sync/pull').set(await as(USERS.spouse)).expect(200);
    expect(spouse.body.tasks.find((t: { id: string }) => t.id === taskId)).toBeUndefined();
  });
});

describe('push', () => {
  const first = randomUUID();

  it('queued offline edits to one chore apply in order (own versions count as seen)', async () => {
    const r = await push([taskOp({ status: 'IN_PROGRESS' }, 1, first), taskOp({ status: 'DONE', proofPhotoUrl: 'https://files.example/lunch.jpg' }, 1)]);
    expect(r.map((x) => [x.result, x.version])).toEqual([['APPLIED', 2], ['APPLIED', 3]]);
    const t = await worker.run((tx) => tx.householdTask.findUniqueOrThrow({ where: { id: taskId } }));
    expect(t).toMatchObject({ status: 'DONE', version: 3, proofPhotoUrl: 'https://files.example/lunch.jpg' });
    expect(t.completedAt).toBeTruthy();
  });

  it('replaying an op (retry after a lost response) returns the stored outcome and changes nothing', async () => {
    const [r] = await push([taskOp({ status: 'IN_PROGRESS' }, 1, first)]);
    expect(r).toMatchObject({ opId: first, result: 'APPLIED', version: 2, replayed: true });
    expect((await worker.run((tx) => tx.householdTask.findUniqueOrThrow({ where: { id: taskId } }))).status).toBe('DONE');
  });

  it('someone else changed the chore since → CONFLICT with the server copy; nothing written', async () => {
    await http().patch(`/v1/tasks/${taskId}`).set(await as(USERS.head)).send({ status: 'TODO', description: 'redo: guests arriving' }).expect(200);
    const [r] = await push([taskOp({ status: 'IN_PROGRESS' }, 3)]);
    expect(r).toMatchObject({ result: 'CONFLICT', version: 4, server: expect.objectContaining({ status: 'TODO', description: 'redo: guests arriving' }) });
    expect((await worker.run((tx) => tx.householdTask.findUniqueOrThrow({ where: { id: taskId } }))).version).toBe(4);
    const [ok] = await push([taskOp({ status: 'IN_PROGRESS' }, 4)]);
    expect(ok).toMatchObject({ result: 'APPLIED', version: 5 });
  });

  it('cancelling is not a sync action; other workers and households cannot touch the chore', async () => {
    await http().post('/v1/sync/push').set(await as(USERS.cook)).send({ deviceId: DEVICE, ops: [taskOp({ status: 'CANCELLED' }, 5)] }).expect(400);
    const [other] = await push([taskOp({ status: 'DONE' }, 5)], USERS.maid);
    expect(other).toMatchObject({ result: 'REJECTED', problem: { status: 404 } }); // not visible to her
    const [h2] = await push([taskOp({ status: 'DONE' }, 5)], USERS.head2, H2);
    expect(h2).toMatchObject({ result: 'REJECTED', problem: { status: 404 } });
    expect((await worker.run((tx) => tx.householdTask.findUniqueOrThrow({ where: { id: taskId } }))).status).toBe('IN_PROGRESS');
  });

  it('instruction completion: photo rule enforced, offline completion time kept, idempotent', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const op = (entityId: string, data: object) => ({ opId: randomUUID(), kind: 'INSTRUCTION_COMPLETE', entityId, baseVersion: 1, clientAt: at, data });
    const [a, b] = await push([op(instrIds[0]!, { note: 'done' }), op(instrIds[1]!, {})]);
    expect(a).toMatchObject({ result: 'APPLIED' });
    expect(b).toMatchObject({ result: 'REJECTED', problem: { status: 422, detail: expect.stringMatching(/needs a photo/) } });
    const [c] = await push([op(instrIds[1]!, { photoStorageKey: `${H1}/wo/oven.jpg` })]);
    expect(c).toMatchObject({ result: 'APPLIED' });
    const rows = await worker.run((tx) => tx.workOrderInstruction.findMany({ where: { workOrderId: woId }, orderBy: { sequence: 'asc' } }));
    expect(rows.map((i) => [i.completedById, i.completedAt?.toISOString()])).toEqual([[MEMBERSHIPS.cook, at], [MEMBERSHIPS.cook, at]]);
    const [again] = await push([op(instrIds[0]!, { note: 'done twice' })]);
    expect(again).toMatchObject({ result: 'APPLIED' });
    expect((await worker.run((tx) => tx.workOrderInstruction.findUniqueOrThrow({ where: { id: instrIds[0]! } }))).note).toBe('done');
  });

  it('the journal records every outcome for the member only', async () => {
    const rows = await worker.run((tx) => tx.syncOperation.findMany({ where: { membershipId: MEMBERSHIPS.cook, entityId: { in: [taskId, ...instrIds] } } }));
    expect(rows.map((r) => r.result).sort()).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'CONFLICT', 'REJECTED']);
    expect(rows.every((r) => r.deviceId === DEVICE && r.householdId === H1)).toBe(true);
  });

  it('pull after the cursor returns only what changed', async () => {
    const before = (await http().get('/v1/sync/pull').set(await as(USERS.cook)).expect(200)).body.cursor;
    await http().patch(`/v1/tasks/${taskId}`).set(await as(USERS.head)).send({ description: 'add salad' }).expect(200);
    const r = await http().get('/v1/sync/pull').query({ since: before }).set(await as(USERS.cook)).expect(200);
    expect(r.body.tasks.find((t: { id: string }) => t.id === taskId)).toMatchObject({ description: 'add salad', version: 6 });
  });
});

describe('offline fallback key', () => {
  const tokenAt = (sub: string, iatSecondsAgo: number) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
    .setIssuedAt(Math.floor(Date.now() / 1000) - iatSecondsAgo).setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET!));

  it('stable per user and device, different across users and devices; only right after sign-in', async () => {
    const get = async (sub: string, deviceId: string, status: number, ago = 0) =>
      (await http().post('/v1/sync/offline-key').set({ Authorization: `Bearer ${await tokenAt(sub, ago)}` }).send({ deviceId }).expect(status)).body.key as string;
    const k1 = await get(USERS.cook, DEVICE, 201);
    expect(Buffer.from(k1, 'base64url')).toHaveLength(32);
    expect(await get(USERS.cook, DEVICE, 201)).toBe(k1);
    expect(await get(USERS.cook, 'android-install-0001', 201)).not.toBe(k1);
    expect(await get(USERS.maid, DEVICE, 201)).not.toBe(k1);
    await get(USERS.cook, DEVICE, 403, 3600);
  });
});
