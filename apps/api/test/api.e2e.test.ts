import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { PrismaService } from '../src/db/prisma.service';

const H1 = 'b0000000-0000-0000-0000-000000000001';
const H2 = 'b0000000-0000-0000-0000-000000000002';
const HEAD = 'a0000000-0000-0000-0000-000000000001';
const EFA = 'a0000000-0000-0000-0000-000000000002';
const MAID = 'a0000000-0000-0000-0000-000000000003';
const MAID_MEMBERSHIP = 'c0000000-0000-0000-0000-000000000003';

let app: INestApplication;
const token = (sub: string, secret = process.env.AUTH_JWT_SECRET!) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
const as = async (sub: string, household = H1, lang = 'ar') => ({
  Authorization: `Bearer ${await token(sub)}`, 'X-Household-Id': household, 'Accept-Language': lang,
});

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://herp_api:herp_api_dev@localhost:5432/herp_api_test';
  process.env.AUTH_JWT_SECRET = 'test-secret-test-secret-test-secret-0123';
  app = await createApp();
  await app.init();
});
afterAll(async () => { await app?.close(); });

describe('platform', () => {
  it('health is public', async () => {
    await request(app.getHttpServer()).get('/v1/health').expect(200, { status: 'ok' });
  });

  it('no token → 401 problem+json', async () => {
    const r = await request(app.getHttpServer()).get('/v1/members').expect(401);
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.body).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('token signed with the wrong key → 401', async () => {
    await request(app.getHttpServer()).get('/v1/members')
      .set('Authorization', `Bearer ${await token(HEAD, 'x'.repeat(40))}`).set('X-Household-Id', H1).expect(401);
  });

  it('missing X-Household-Id → 400', async () => {
    await request(app.getHttpServer()).get('/v1/members').set('Authorization', `Bearer ${await token(HEAD)}`).expect(400);
  });

  it('fail-closed: the login role cannot read tables without the RLS context', async () => {
    const db = app.get(PrismaService);
    await expect(db.$queryRaw`SELECT count(*) FROM memberships`).rejects.toThrow(/permission denied/);
  });
});

describe('tenancy', () => {
  it('head lists their household; role names are localised (official EFA label)', async () => {
    const r = await request(app.getHttpServer()).get('/v1/members').set(await as(HEAD)).expect(200);
    expect(r.body.data).toHaveLength(3);
    expect(r.body.data.map((m: { role: { name: string } }) => m.role.name)).toContain('مكتب EFA - الإدارة التشغيلية');
  });

  it('same endpoint in English', async () => {
    const r = await request(app.getHttpServer()).get('/v1/members').set(await as(HEAD, H1, 'en')).expect(200);
    expect(r.body.data.map((m: { role: { name: string } }) => m.role.name)).toContain('EFA Office – Operations Management');
  });

  it('another household → 404, not 403 (existence is not revealed)', async () => {
    const r = await request(app.getHttpServer()).get('/v1/members').set(await as(HEAD, H2)).expect(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });

  it('GET /me lists only the caller\'s households, localised', async () => {
    const r = await request(app.getHttpServer()).get('/v1/me')
      .set({ Authorization: `Bearer ${await token(HEAD)}`, 'Accept-Language': 'en' }).expect(200);
    expect(r.body.households).toEqual([expect.objectContaining({ householdId: H1, name: 'Majid household', systemRole: 'HOUSEHOLD_HEAD' })]);
  });
});

describe('permissions & RLS errors over HTTP', () => {
  it('EFA admin is a household admin; maid is not and has OWN scopes', async () => {
    const efa = await request(app.getHttpServer()).get('/v1/me/permissions').set(await as(EFA)).expect(200);
    expect(efa.body.householdAdmin).toBe(true);
    expect(efa.body.permissions['admin.household.manage']).toBeUndefined();
    const maid = await request(app.getHttpServer()).get('/v1/me/permissions').set(await as(MAID)).expect(200);
    expect(maid.body).toMatchObject({ householdAdmin: false, membershipId: MAID_MEMBERSHIP });
    expect(maid.body.permissions['staff.payroll.read']).toBe('OWN');
  });

  it('maid can rename herself', async () => {
    const r = await request(app.getHttpServer()).patch(`/v1/members/${MAID_MEMBERSHIP}`).set(await as(MAID))
      .send({ displayName: 'Ate Maria' }).expect(200);
    expect(r.body.displayName).toBe('Ate Maria');
  });

  it('maid promoting herself to Head → 403 from the DB guard', async () => {
    const members = await request(app.getHttpServer()).get('/v1/members').set(await as(HEAD)).expect(200);
    const headRoleId = members.body.data.find((m: { role: { systemRole: string } }) => m.role.systemRole === 'HOUSEHOLD_HEAD').roleId;
    const r = await request(app.getHttpServer()).patch(`/v1/members/${MAID_MEMBERSHIP}`).set(await as(MAID))
      .send({ roleId: headRoleId }).expect(403);
    expect(r.body).toMatchObject({ code: 'FORBIDDEN', detail: expect.stringMatching(/admin role/) });
  });

  it('maid editing someone else → 404 (row invisible to her update)', async () => {
    const members = await request(app.getHttpServer()).get('/v1/members').set(await as(HEAD)).expect(200);
    const head = members.body.data.find((m: { role: { systemRole: string } }) => m.role.systemRole === 'HOUSEHOLD_HEAD');
    await request(app.getHttpServer()).patch(`/v1/members/${head.id}`).set(await as(MAID)).send({ displayName: 'x' }).expect(404);
  });

  it('last Head suspending themselves → 422 business rule', async () => {
    const members = await request(app.getHttpServer()).get('/v1/members').set(await as(HEAD)).expect(200);
    const head = members.body.data.find((m: { role: { systemRole: string } }) => m.role.systemRole === 'HOUSEHOLD_HEAD');
    const r = await request(app.getHttpServer()).patch(`/v1/members/${head.id}`).set(await as(HEAD))
      .send({ status: 'SUSPENDED' }).expect(422);
    expect(r.body.detail).toMatch(/at least one active Household Head/);
  });

  it('invalid body → 400 with field errors', async () => {
    const r = await request(app.getHttpServer()).patch(`/v1/members/${MAID_MEMBERSHIP}`).set(await as(MAID))
      .send({ roleId: 'nope', extra: 1 }).expect(400);
    expect(r.body.detail).toMatch(/roleId/);
  });
});
