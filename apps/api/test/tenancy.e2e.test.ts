import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { H1, H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

/**
 * Cross-tenant security gate at the HTTP layer. Every GET route the API registers
 * (discovered at runtime, so new endpoints are covered automatically) is called by
 * the Head of household H2, with every id parameter filled with H1 entity ids. No
 * response may contain an identifier that belongs to H1, whatever the status code.
 */
let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
const h1Ids = new Set<string>();
let routes: string[] = [];

function getRoutes(a: INestApplication): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const app = a.getHttpAdapter().getInstance() as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } };
  const stack = (app.router ?? app._router)?.stack ?? []; // Express 5: app.router (4: app._router)
  return [...new Set(stack.filter((l) => l.route?.methods.get).map((l) => l.route!.path))].sort();
}

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  app = await createApp(); await app.init();
  // H1 data of many kinds, created through the API.
  const head = await as(USERS.head);
  const staff = (await http().post('/v1/staff').set(head).send({ staffType: 'COOK', fullName: { en: 'Tenant Probe' }, nationality: 'IN', hireDate: riyadhDate(-5) }).expect(201)).body.id;
  const vehicle = (await http().post('/v1/vehicles').set(head).send({ make: 'Kia', model: 'Carnival', year: 2024, plateNumber: 'TNT 0001' }).expect(201)).body.id;
  const float = (await http().post('/v1/petty-cash').set(head).send({ custodianId: MEMBERSHIPS.cook, name: 'Probe float', floatLimit: 100 }).expect(201)).body.id;
  const task = (await http().post('/v1/tasks').set(head).send({ title: 'probe', assigneeId: MEMBERSHIPS.maid }).expect(201)).body.id;
  const wo = (await http().post('/v1/work-orders').set(head).send({ title: 'probe', category: 'CLEANING', instructions: [{ text: 'x' }] }).expect(201)).body.id;
  // Every id that belongs to H1 in the database (households, memberships, users who are only in H1, and the rows above).
  const rows = await worker.run((tx) => tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text FROM memberships WHERE "householdId" = ${H1}::uuid
    UNION SELECT "userId"::text FROM memberships m WHERE "householdId" = ${H1}::uuid
      AND NOT EXISTS (SELECT 1 FROM memberships x WHERE x."userId" = m."userId" AND x."householdId" <> ${H1}::uuid)
    UNION SELECT id::text FROM staff_profiles WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM vehicles WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM petty_cash_accounts WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM financial_accounts WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM transactions WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM salary_payments WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM identity_documents WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM requests WHERE "householdId" = ${H1}::uuid
    UNION SELECT id::text FROM roles WHERE "householdId" = ${H1}::uuid`);
  [H1, staff, vehicle, float, task, wo, ...rows.map((r) => r.id)].forEach((id) => h1Ids.add(id));
  routes = getRoutes(app);
});
afterAll(async () => { await app?.close(); await worker?.close(); });

/** H1 ids in a response, ignoring the problem+json `instance` (the URL the caller sent, echoed back). */
const leaks = (body: unknown) => {
  const b = body && typeof body === 'object' && 'instance' in body ? { ...(body as Record<string, unknown>), instance: undefined } : body;
  const s = JSON.stringify(b ?? '');
  return [...h1Ids].filter((id) => s.includes(id));
};

describe('cross-tenant security gate (HTTP)', () => {
  it('discovers the API surface', () => {
    expect(routes.length).toBeGreaterThanOrEqual(60);
    expect(h1Ids.size).toBeGreaterThan(20);
  });

  it('collection routes as the H2 Head: no H1 identifier in any response', async () => {
    const headers = await as(USERS.head2, H2);
    const found: string[] = [];
    for (const path of routes.filter((p) => !p.includes(':'))) {
      const r = await http().get(path).set(headers);
      const l = leaks(r.body);
      if (l.length) found.push(`${path} → ${r.status}: ${l.slice(0, 3).join(', ')}`);
    }
    expect(found).toEqual([]);
  });

  it('by-id routes filled with every H1 id: nothing of H1 comes back', async () => {
    const headers = await as(USERS.head2, H2);
    const found: string[] = []; let calls = 0;
    const ids = [...h1Ids];
    for (const path of routes.filter((p) => p.includes(':'))) {
      for (const id of ids) {
        const url = path.replace(/:[A-Za-z]+/g, id);
        const r = await http().get(url).set(headers);
        calls++;
        const l = leaks(r.body);
        if (l.length) found.push(`${url} → ${r.status}: ${l.slice(0, 3).join(', ')}`);
      }
    }
    expect(found).toEqual([]);
    expect(calls).toBeGreaterThan(500);
  });

  it('an H2 user cannot select H1 as the household (header) on any collection route', async () => {
    const headers = await as(USERS.head2, H1);
    const bad: string[] = [];
    for (const path of routes.filter((p) => !p.includes(':'))) {
      const r = await http().get(path).set(headers);
      if (leaks(r.body).length || (r.status === 200 && !/^\/v1\/(me|auth|health|households)/.test(path))) bad.push(`${path} → ${r.status}`);
    }
    expect(bad).toEqual([]);
  });
});
