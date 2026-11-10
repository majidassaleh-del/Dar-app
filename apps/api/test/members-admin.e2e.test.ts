import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.factory';
import { IdpAdminService } from '../src/auth/idp-admin.service';
import { ServiceDb } from '../src/worker/service-db';
import { H1, H2, USERS, as, testEnv } from './helpers';

/**
 * Member, role and permission management: the household owner's alone.
 * Custom roles on a base role, role permission matrices, per-member overrides,
 * suspension and removal, and invitations addressed to an e-mail only.
 */
const T1 = 'a0000000-0000-0000-0000-0000000ad001';
const MAIL = 'office.staff@members.example.test';
let app: INestApplication, worker: ServiceDb;
let t1 = '', staffRole = '', driverRole = '', headRole = '', headMember = '', headDriver = '';
const http = () => request(app.getHttpServer());
const perms = async (who = T1) => (await http().get('/v1/me/permissions').set(await as(who)).expect(200)).body.permissions as Record<string, string>;

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await worker.run(async (tx) => {
    const roles = await tx.role.findMany({ where: { householdId: H1, isDefault: true } });
    staffRole = roles.find((r) => r.systemRole === 'STAFF')!.id; driverRole = roles.find((r) => r.systemRole === 'DRIVER')!.id;
    headRole = roles.find((r) => r.systemRole === 'HOUSEHOLD_HEAD')!.id;
    headMember = (await tx.membership.findFirstOrThrow({ where: { householdId: H1, userId: USERS.head } })).id;
    await tx.user.upsert({ where: { id: T1 }, create: { id: T1, fullNameI18n: { en: 'Managed member' }, preferredLocale: 'en' }, update: {} });
    t1 = (await tx.membership.create({ data: { householdId: H1, userId: T1, roleId: staffRole, status: 'ACTIVE', displayName: 'Managed' } })).id;
    await tx.$executeRaw`INSERT INTO user_auth_factors ("userId", "phoneVerifiedAt", "emailVerifiedAt", "onboardedAt") VALUES (${T1}::uuid, now(), now(), now()) ON CONFLICT DO NOTHING`;
  });
  app = await createApp(); await app.init();
});
afterAll(async () => {
  await worker?.run(async (tx) => {
    const invited = (await tx.user.findMany({ where: { email: MAIL }, select: { id: true } })).map((u) => u.id);
    await tx.invitation.deleteMany({ where: { OR: [{ email: MAIL }, { phone: '+966500004601' }] } });
    await tx.membership.deleteMany({ where: { userId: { in: [T1, ...invited] } } });
    await tx.user.deleteMany({ where: { id: { in: [T1, ...invited] } } });
    await tx.role.deleteMany({ where: { householdId: H1, isDefault: false, nameI18n: { path: ['en'], string_contains: '(test)' } } });
  });
  await app?.close(); await worker?.close();
});

describe('only the household owner manages members, roles and permissions', () => {
  it('EFA office admin, spouse and staff are refused; the other household cannot reach them', async () => {
    for (const who of [USERS.efa, USERS.spouse, USERS.maid]) {
      const h = await as(who);
      const tries = [
        http().patch(`/v1/members/${t1}`).set(h).send({ roleId: driverRole }),
        http().patch(`/v1/members/${t1}`).set(h).send({ status: 'SUSPENDED' }),
        http().delete(`/v1/members/${t1}`).set(h),
        http().get(`/v1/members/${t1}/permissions`).set(h),
        http().put(`/v1/members/${t1}/permissions`).set(h).send({ overrides: [{ permissionId: 'invest.read', granted: true }] }),
        http().post('/v1/roles').set(h).send({ baseRole: 'DRIVER', name: 'Sneaky (test)' }),
        http().get(`/v1/roles/${staffRole}/permissions`).set(h),
        http().put(`/v1/roles/${staffRole}/permissions`).set(h).send({ permissions: [{ permissionId: 'invest.manage', scope: 'ALL' }] }),
      ];
      for (const [i, r] of (await Promise.all(tries)).entries()) {
        expect([who, i, r.status]).toEqual([who, i, 403]);
        expect(r.body.detail).toMatch(/only the household owner/);
      }
    }
    const other = await as(USERS.head2, H2);
    await http().patch(`/v1/members/${t1}`).set(other).send({ status: 'SUSPENDED' }).expect(404);
    await http().delete(`/v1/members/${t1}`).set(other).expect(404);
    await http().put(`/v1/roles/${staffRole}/permissions`).set(other).send({ permissions: [] }).expect(404);
    await http().put(`/v1/members/${t1}/permissions`).set(other).send({ overrides: [] }).expect(404);
    await worker.run(async (tx) => {
      expect(await tx.membership.findUniqueOrThrow({ where: { id: t1 } })).toMatchObject({ roleId: staffRole, status: 'ACTIVE' });
      expect(await tx.membershipPermission.count({ where: { membershipId: t1 } })).toBe(0);
    });
    // Everyone still reads the roster and the role list; a member still renames themselves.
    expect((await http().get('/v1/roles').set(await as(USERS.maid)).expect(200)).body.data.length).toBeGreaterThanOrEqual(8);
    await http().patch(`/v1/members/${t1}`).set(await as(T1)).send({ displayName: 'Managed' }).expect(200);
    await http().patch(`/v1/members/${t1}`).set(await as(T1)).send({ roleId: driverRole }).expect(403);
  });

  it('the owner changes a role: the member\'s permissions follow at once', async () => {
    expect((await perms())['fleet.trips.log']).toBeUndefined();
    await http().patch(`/v1/members/${t1}`).set(await as(USERS.head)).send({ roleId: driverRole }).expect(200);
    expect((await perms())['fleet.trips.log']).toBeDefined();
    const row = (await http().get('/v1/members').set(await as(USERS.head)).expect(200)).body.data.find((m: { id: string }) => m.id === t1);
    expect(row).toMatchObject({ name: 'Managed', status: 'ACTIVE', self: false, role: { systemRole: 'DRIVER', custom: false } });
    await http().patch(`/v1/members/${t1}`).set(await as(USERS.head)).send({ roleId: staffRole }).expect(200);
  });

  it('suspend and remove end access immediately; history stays; the owner can restore', async () => {
    const owner = await as(USERS.head);
    await http().get('/v1/members').set(await as(T1)).expect(200);
    await http().patch(`/v1/members/${t1}`).set(owner).send({ status: 'SUSPENDED' }).expect(200);
    await http().get('/v1/members').set(await as(T1)).expect(404); // the household is gone for them, at once
    await http().patch(`/v1/members/${t1}`).set(owner).send({ status: 'ACTIVE' }).expect(200);
    await http().get('/v1/members').set(await as(T1)).expect(200);
    await http().delete(`/v1/members/${t1}`).set(owner).expect(200);
    await http().delete(`/v1/members/${t1}`).set(owner).expect(404);
    expect((await http().get('/v1/members').set(owner).expect(200)).body.data.find((m: { id: string }) => m.id === t1).status).toBe('REVOKED');
    await http().get('/v1/members').set(await as(T1)).expect(404);
    await http().patch(`/v1/members/${t1}`).set(owner).send({ status: 'ACTIVE' }).expect(200);
    // The owner cannot remove themselves, and the last Head cannot be suspended.
    await http().delete(`/v1/members/${headMember}`).set(owner).expect(422);
    await http().patch(`/v1/members/${headMember}`).set(owner).send({ status: 'SUSPENDED' }).expect(422);
  });
});

describe('custom roles on a base role', () => {
  it('"Head Driver" on Driver starts as a copy of Driver, then diverges; the base role is untouched', async () => {
    const owner = await as(USERS.head);
    const r = (await http().post('/v1/roles').set(owner).send({ baseRole: 'DRIVER', name: 'Head Driver (test)', nameI18n: { ar: 'رئيس السائقين' } }).expect(201)).body;
    headDriver = r.id;
    await http().post('/v1/roles').set(owner).send({ baseRole: 'DRIVER', name: 'Night Driver (test)' }).expect(201); // several on one base
    await http().post('/v1/roles').set(owner).send({ baseRole: 'STAFF', name: 'Office Staff (test)' }).expect(201);
    for (const baseRole of ['HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN']) await http().post('/v1/roles').set(owner).send({ baseRole, name: 'Second owner (test)' }).expect(400);
    const list = (await http().get('/v1/roles').set(owner).expect(200)).body.data;
    expect(list.find((x: { id: string }) => x.id === headDriver)).toMatchObject({ systemRole: 'DRIVER', custom: true, name: 'Head Driver (test)', members: 0 });
    expect((await http().get('/v1/roles').set({ ...owner, 'Accept-Language': 'ar' }).expect(200)).body.data.find((x: { id: string }) => x.id === headDriver).name).toBe('رئيس السائقين');
    const scopes = async (id: string) => Object.fromEntries((await http().get(`/v1/roles/${id}/permissions`).set(owner).expect(200)).body.permissions
      .filter((p: { scope: string | null }) => p.scope).map((p: { id: string; scope: string }) => [p.id, p.scope]));
    const driver = await scopes(driverRole);
    expect(await scopes(headDriver)).toEqual(driver);
    expect(driver['fleet.manage']).toBeUndefined();
    await http().put(`/v1/roles/${headDriver}/permissions`).set(owner)
      .send({ permissions: [...Object.entries(driver).map(([permissionId, scope]) => ({ permissionId, scope })), { permissionId: 'fleet.manage', scope: 'ALL' }] }).expect(200);
    expect(await scopes(driverRole)).toEqual(driver);
    await http().patch(`/v1/members/${t1}`).set(owner).send({ roleId: headDriver }).expect(200);
    expect((await perms())['fleet.manage']).toBe('ALL');
    expect((await perms(USERS.driver))['fleet.manage']).toBeUndefined();
    const row = (await http().get('/v1/members').set(owner).expect(200)).body.data.find((m: { id: string }) => m.id === t1);
    expect(row.role).toEqual({ systemRole: 'DRIVER', custom: true, name: 'Head Driver (test)' });
  });

  it('a custom role can be the role of an invitation, renamed, and deleted only when nobody holds it', async () => {
    const owner = await as(USERS.head);
    const inv = (await http().post('/v1/invitations').set(owner).send({ phone: '+966500004601', roleId: headDriver }).expect(201)).body;
    const listed = (await http().get('/v1/invitations').set(owner).expect(200)).body.data.find((i: { id: string }) => i.id === inv.id);
    expect(listed.role).toMatchObject({ systemRole: 'DRIVER', name: 'Head Driver (test)' });
    await http().patch(`/v1/roles/${headDriver}`).set(owner).send({ name: 'Chief Driver (test)' }).expect(200);
    await http().delete(`/v1/roles/${headDriver}`).set(owner).expect(409); // T1 holds it
    await http().patch(`/v1/members/${t1}`).set(owner).send({ roleId: staffRole }).expect(200);
    await http().delete(`/v1/roles/${headDriver}`).set(owner).expect(409); // an invitation points at it
    const spare = (await http().post('/v1/roles').set(owner).send({ baseRole: 'GUEST', name: 'Visitor (test)' }).expect(201)).body.id;
    await http().delete(`/v1/roles/${spare}`).set(owner).expect(200);
    await http().get(`/v1/roles/${spare}/permissions`).set(owner).expect(404);
    // Built-in roles keep their name and cannot be deleted.
    await http().patch(`/v1/roles/${staffRole}`).set(owner).send({ name: 'Renamed' }).expect(422);
    await http().delete(`/v1/roles/${staffRole}`).set(owner).expect(422);
  });
});

describe('permissions: role matrix and per-member overrides', () => {
  it('an override denies what the role gives and grants what it does not; clearing it restores the role', async () => {
    const owner = await as(USERS.head);
    const before = await perms();
    expect(before['staff.payroll.read']).toBe('OWN'); expect(before['invest.read']).toBeUndefined();
    await http().put(`/v1/members/${t1}/permissions`).set(owner)
      .send({ overrides: [{ permissionId: 'staff.payroll.read', granted: false }, { permissionId: 'invest.read', granted: true, scope: 'ALL' }] }).expect(200);
    const after = await perms();
    expect(after['staff.payroll.read']).toBeUndefined(); expect(after['invest.read']).toBe('ALL');
    const view = (await http().get(`/v1/members/${t1}/permissions`).set(owner).expect(200)).body;
    expect(view.member).toMatchObject({ id: t1, locked: false, role: { systemRole: 'STAFF' } });
    const byId = Object.fromEntries(view.permissions.map((p: { id: string }) => [p.id, p]));
    expect(byId['staff.payroll.read']).toMatchObject({ role: 'OWN', override: { granted: false, scope: null }, effective: null, module: 'staff' });
    expect(byId['invest.read']).toMatchObject({ role: null, override: { granted: true, scope: 'ALL' }, effective: 'ALL' });
    expect(byId['requests.create']).toMatchObject({ override: null });
    // The override is this member's only: another staff member is unchanged.
    expect((await perms(USERS.maid))['staff.payroll.read']).toBe('OWN');
    await http().put(`/v1/members/${t1}/permissions`).set(owner).send({ overrides: [] }).expect(200);
    expect(await perms()).toEqual(before);
  });

  it('refuses nonsense: unknown permission or scope, duplicates, and anything on a Household Head', async () => {
    const owner = await as(USERS.head);
    await http().put(`/v1/members/${t1}/permissions`).set(owner).send({ overrides: [{ permissionId: 'no.such.permission', granted: true }] }).expect(422);
    await http().put(`/v1/members/${t1}/permissions`).set(owner).send({ overrides: [{ permissionId: 'invest.read', granted: true, scope: 'EVERYTHING' }] }).expect(400);
    await http().put(`/v1/members/${t1}/permissions`).set(owner).send({ overrides: [{ permissionId: 'invest.read', granted: true }, { permissionId: 'invest.read', granted: false }] }).expect(422);
    await http().put(`/v1/members/${headMember}/permissions`).set(owner).send({ overrides: [{ permissionId: 'invest.read', granted: false }] }).expect(422);
    await http().put(`/v1/roles/${headRole}/permissions`).set(owner).send({ permissions: [] }).expect(422);
    expect(Object.keys(await perms(USERS.head)).length).toBeGreaterThan(40);
    expect(await perms()).not.toHaveProperty('invest.read');
    expect((await http().get('/v1/permissions').set(await as(USERS.maid)).expect(200)).body.data.length).toBeGreaterThan(40);
  });
});

describe('invitations addressed to an e-mail only', () => {
  it('creates the account on the e-mail; the pending member cannot be switched active by hand', async () => {
    const owner = await as(USERS.head);
    await http().post('/v1/invitations').set(owner).send({ roleId: staffRole }).expect(400); // nobody to invite
    const office = (await http().get('/v1/roles').set(owner).expect(200)).body.data.find((r: { name: string }) => r.name === 'Office Staff (test)');
    const inv = (await http().post('/v1/invitations').set(owner).send({ email: MAIL, roleId: office.id, displayName: 'Office clerk' }).expect(201)).body;
    const p = (await http().post('/v1/auth/invitations/preview').set('Accept-Language', 'en').send({ token: inv.token }).expect(200)).body;
    expect(p).toMatchObject({ phone: null, email: 'o•••@members.example.test', role: 'Office Staff (test)' });
    await http().post('/v1/auth/invitations/accept').send({ token: inv.token }).expect(201);
    expect(app.get(IdpAdminService).local.find((u) => u.email === MAIL)).toMatchObject({ phone: null });
    const m = await worker.run(async (tx) => {
      const u = await tx.user.findFirstOrThrow({ where: { email: MAIL } });
      expect(u.phone).toBeNull();
      return tx.membership.findFirstOrThrow({ where: { userId: u.id } });
    });
    expect(m).toMatchObject({ householdId: H1, roleId: office.id, status: 'INVITED' });
    await http().patch(`/v1/members/${m.id}`).set(owner).send({ status: 'ACTIVE' }).expect(422);
    await http().patch(`/v1/members/${m.id}`).set(owner).send({ roleId: staffRole }).expect(200); // the role can still be corrected
  });
});
