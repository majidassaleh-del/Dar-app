import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys, syncStaffComplianceReminders } from '../src/worker/jobs';
import { H1, H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
let staffId = '';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function upload(user: string, body: object, bytes: Buffer) {
  const f = await http().post('/v1/files').set(await as(user)).send({ ...body, sizeBytes: bytes.length, sha256: sha(bytes) }).expect(201);
  await http().put(f.body.upload.url).set(await as(user)).set('Content-Type', 'application/octet-stream').send(bytes).expect(200);
  return f.body.id as string;
}

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp(); await app.init();
  staffId = (await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'GARDENER', fullName: { en: 'Samir Hassan', ar: 'سمير حسن' },
    nationality: 'EG', membershipId: MEMBERSHIPS.gardener, hireDate: riyadhDate(-10) }).expect(201)).body.id;
});
afterAll(async () => { await app?.close(); await worker?.close(); });

describe('mandatory annual medical checkup (every role)', () => {
  it('a gardener cannot be activated without one; UNFIT does not count; FIT does', async () => {
    expect((await http().post(`/v1/staff/${staffId}/status`).set(await as(USERS.head)).send({ status: 'ACTIVE' }).expect(422)).body.detail).toMatch(/medical checkup/);
    await http().post(`/v1/staff/${staffId}/medical-checkups`).set(await as(USERS.head)).send({ checkupDate: riyadhDate(-1), result: 'UNFIT' }).expect(201);
    await http().post(`/v1/staff/${staffId}/status`).set(await as(USERS.head)).send({ status: 'ACTIVE' }).expect(422);
    const c = await http().post(`/v1/staff/${staffId}/medical-checkups`).set(await as(USERS.head)).send({ checkupDate: riyadhDate(0), result: 'FIT_WITH_RESTRICTIONS',
      clinicName: 'Dallah Clinic', restrictions: 'No heavy lifting over 20 kg' }).expect(201);
    expect(c.body).toMatchObject({ validUntil: riyadhDate(365), restrictions: 'No heavy lifting over 20 kg' });
    await http().post(`/v1/staff/${staffId}/status`).set(await as(USERS.head)).send({ status: 'ACTIVE' }).expect(201);
  });

  it('medical notes are ciphertext at rest; staff cannot record checkups', async () => {
    const [r] = await worker.run((tx) => tx.$queryRaw<Array<{ c: string }>>`SELECT "restrictionsCiphertext" AS c FROM medical_checkups WHERE "staffId" = ${staffId}::uuid AND "clinicName" = 'Dallah Clinic'`);
    expect(r!.c).toMatch(/^v1\./);
    await http().post(`/v1/staff/${staffId}/medical-checkups`).set(await as(USERS.gardener)).send({ checkupDate: riyadhDate(0), result: 'FIT' }).expect(403);
  });

  it('compliance view (Head / EFA): VALID; the spouse has no access to health data', async () => {
    const r = await http().get('/v1/compliance/staff').set(await as(USERS.efa)).expect(200);
    expect(r.body.data.find((x: { staffId: string }) => x.staffId === staffId).medical).toMatchObject({ status: 'VALID', validUntil: riyadhDate(365) });
    await http().get('/v1/compliance/staff').set(await as(USERS.spouse)).expect(403);
  });
});

describe('staff files', () => {
  let passportId = '';
  const scan = Buffer.from('%PDF-1.7\n% passport scan of Samir Hassan, no. A12345678');

  it('declare → upload → signed download; sensitive files are encrypted at rest and audited', async () => {
    passportId = await upload(USERS.head, { entityType: 'STAFF', entityId: staffId, staffId, category: 'PASSPORT', fileName: 'passport.pdf', mimeType: 'application/pdf' }, scan);
    const meta = (await http().get(`/v1/staff/${staffId}/files`).set(await as(USERS.head))).body.data.find((f: { id: string }) => f.id === passportId);
    expect(meta).toMatchObject({ status: 'UPLOADED', isSensitive: true, encrypted: true, category: 'PASSPORT' });
    const dir = `${process.env.STORAGE_DIR}/${H1}`;
    const onDisk = await readFile(`${dir}/${(await readdir(dir)).find((n) => n === passportId)}`);
    expect(onDisk.includes(Buffer.from('A12345678'))).toBe(false);
    const link = await http().get(`/v1/files/${passportId}/url`).set(await as(USERS.head)).expect(200);
    const dl = await http().get(link.body.url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(Buffer.compare(dl.body as Buffer, scan)).toBe(0);
    expect(dl.headers['cache-control']).toBe('private, no-store');
    const [a] = await worker.run((tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'VIEW_SENSITIVE' AND "entityId" = ${passportId}`);
    expect(a!.n).toBe(1);
  });

  it('upload integrity: wrong size or hash refused; files are immutable', async () => {
    const f = await http().post('/v1/files').set(await as(USERS.head)).send({ entityType: 'STAFF', entityId: staffId, staffId, category: 'ACADEMIC_CERTIFICATE',
      fileName: 'diploma.pdf', mimeType: 'application/pdf', sizeBytes: 5, sha256: sha(Buffer.from('12345')) }).expect(201);
    await http().put(f.body.upload.url).set(await as(USERS.head)).set('Content-Type', 'application/octet-stream').send(Buffer.from('1234')).expect(400);
    await http().put(f.body.upload.url).set(await as(USERS.head)).set('Content-Type', 'application/octet-stream').send(Buffer.from('12346')).expect(400);
    await http().put(f.body.upload.url).set(await as(USERS.head)).set('Content-Type', 'application/octet-stream').send(Buffer.from('12345')).expect(200);
    await http().put(f.body.upload.url).set(await as(USERS.head)).set('Content-Type', 'application/octet-stream').send(Buffer.from('12345')).expect(409);
  });

  it('the worker sees her own files; others and other households do not; tokens cannot be forged', async () => {
    expect((await http().get(`/v1/staff/${staffId}/files`).set(await as(USERS.gardener)).expect(200)).body.data.map((f: { id: string }) => f.id)).toContain(passportId);
    expect((await http().get(`/v1/staff/${staffId}/files`).set(await as(USERS.maid)).expect(200)).body.data).toEqual([]);
    await http().get(`/v1/files/${passportId}/url`).set(await as(USERS.maid)).expect(404);
    await http().get(`/v1/files/${passportId}/url`).set(await as(USERS.head2, H2)).expect(404);
    const link = (await http().get(`/v1/files/${passportId}/url`).set(await as(USERS.gardener)).expect(200)).body.url as string;
    await http().get(link.replace(/token=([^&]+)/, (_m, t: string) => `token=${t.slice(0, -2)}xx`)).expect(401);
    await http().get(link.replace(passportId, '7f9c2ba4-e88f-4d3b-9b0e-6c1d2a3b4c5d')).expect(401);
  });

  it('a worker cannot file documents about another worker; bad input is refused', async () => {
    const maidStaff = (await http().get('/v1/staff').set(await as(USERS.head))).body.data.find((s: { membershipId: string }) => s.membershipId === MEMBERSHIPS.maid);
    if (maidStaff) await http().post('/v1/files').set(await as(USERS.gardener)).send({ entityType: 'STAFF', entityId: maidStaff.id, staffId: maidStaff.id, category: 'OTHER',
      fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(Buffer.from('x')) }).expect(403);
    await http().post('/v1/files').set(await as(USERS.head)).send({ entityType: 'STAFF', entityId: staffId, category: 'PASSPORT', fileName: 'x', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha(Buffer.from('x')) }).expect(400);
    await http().post('/v1/files').set(await as(USERS.head)).send({ entityType: 'STAFF', entityId: staffId, staffId, fileName: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 1, sha256: sha(Buffer.from('x')) }).expect(400);
  });
});

describe('health record & sick leave', () => {
  it('the worker discloses her own allergies (encrypted); Head reads them; the spouse cannot', async () => {
    await http().put(`/v1/staff/${staffId}/health`).set(await as(USERS.gardener)).send({ bloodType: 'O_POS', allergies: ['Peanuts', 'Penicillin'], conditions: ['Asthma'] }).expect(200);
    const r = await http().get(`/v1/staff/${staffId}/health`).set(await as(USERS.head)).expect(200);
    expect(r.body).toMatchObject({ bloodType: 'O_POS', allergies: ['Peanuts', 'Penicillin'], conditions: ['Asthma'], medical: { status: 'VALID' } });
    const [row] = await worker.run((tx) => tx.$queryRaw<Array<{ a: string }>>`SELECT "allergiesCiphertext" AS a FROM staff_health_profiles WHERE "staffId" = ${staffId}::uuid`);
    expect(row!.a).not.toContain('Peanuts');
    await http().get(`/v1/staff/${staffId}/health`).set(await as(USERS.spouse)).expect(404);
  });

  it('sick leave over one day needs her own medical certificate (DB rule); one day does not', async () => {
    const noCert = await http().post('/v1/requests').set(await as(USERS.gardener)).send({ type: 'LEAVE', leaveType: 'SICK', startDate: riyadhDate(2), endDate: riyadhDate(4) }).expect(422);
    expect(noCert.body.detail).toMatch(/needs a medical certificate/);
    const cert = await upload(USERS.gardener, { entityType: 'STAFF', entityId: staffId, staffId, category: 'SICK_LEAVE_CERTIFICATE', fileName: 'sick-note.jpg', mimeType: 'image/jpeg' }, Buffer.from('jpeg-bytes'));
    const ok = await http().post('/v1/requests').set(await as(USERS.gardener)).send({ type: 'LEAVE', leaveType: 'SICK', startDate: riyadhDate(2), endDate: riyadhDate(4), certificateAttachmentId: cert }).expect(201);
    expect(ok.body.status).toBe('IN_REVIEW');
    await http().post('/v1/requests').set(await as(USERS.gardener)).send({ type: 'LEAVE', leaveType: 'SICK', startDate: riyadhDate(7), endDate: riyadhDate(7) }).expect(201);
    await http().post(`/v1/requests/${ok.body.id}/approve`).set(await as(USERS.head)).send({}).expect(201);
    expect((await http().get(`/v1/staff/${staffId}/health`).set(await as(USERS.efa))).body.sickLeave).toEqual([expect.objectContaining({ requestId: ok.body.id, days: 3 })]);
  });
});

describe('asset handover with digital sign-off', () => {
  let phone = '';
  it('Head issues a phone; only the worker can sign; the signature is hashed', async () => {
    const r = await http().post(`/v1/staff/${staffId}/handovers`).set(await as(USERS.head)).send({ itemType: 'PHONE', description: 'Samsung A15 (work phone)',
      serialOrTag: 'IMEI 356938035643809', expectedReturnAt: `${riyadhDate(3)}T18:00:00+03:00` }).expect(201);
    phone = r.body.id;
    expect(r.body.status).toBe('PENDING_ACK');
    await http().post(`/v1/handovers/${phone}/acknowledge`).set(await as(USERS.head)).send({}).expect(403);
    const ack = await http().post(`/v1/handovers/${phone}/acknowledge`).set(await as(USERS.gardener)).send({ method: 'OTP_CONFIRMED' }).expect(201);
    expect(ack.body).toMatchObject({ status: 'ISSUED', ackMethod: 'OTP_CONFIRMED', ackContentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('exit clearance: no final exit while the phone is out; returns are received by a manager', async () => {
    expect((await http().post(`/v1/staff/${staffId}/status`).set(await as(USERS.head)).send({ status: 'FINAL_EXIT' }).expect(422)).body.detail).toMatch(/exit clearance/);
    await http().post(`/v1/handovers/${phone}/return`).set(await as(USERS.gardener)).send({}).expect(403);
    expect((await http().post(`/v1/handovers/${phone}/return`).set(await as(USERS.head)).send({ conditionIn: 'good' }).expect(201)).body.status).toBe('RETURNED');
    await http().post(`/v1/handovers/${phone}/lost`).set(await as(USERS.head)).send({ note: 'too late' }).expect(422);
  });
});

describe('evaluations & training', () => {
  it('a draft is hidden from the worker; once shared she acknowledges it with a comment, once', async () => {
    const e = await http().post(`/v1/staff/${staffId}/evaluations`).set(await as(USERS.head)).send({ periodStart: '2026-07-01', periodEnd: '2026-09-30',
      scores: { punctuality: 5, quality: 4, conduct: 5, safety: 4, communication: 3 }, comments: 'Reliable; improve reporting' }).expect(201);
    expect(e.body).toMatchObject({ overall: 4.2, status: 'DRAFT' });
    expect((await http().get(`/v1/staff/${staffId}/evaluations`).set(await as(USERS.gardener))).body.data).toEqual([]);
    await http().post(`/v1/evaluations/${e.body.id}/acknowledge`).set(await as(USERS.head)).send({}).expect(403);
    await http().post(`/v1/evaluations/${e.body.id}/share`).set(await as(USERS.head)).expect(201);
    const ack = await http().post(`/v1/evaluations/${e.body.id}/acknowledge`).set(await as(USERS.gardener)).send({ comment: 'شكراً' }).expect(201);
    expect(ack.body).toMatchObject({ status: 'ACKNOWLEDGED', workerComment: 'شكراً' });
    await http().post(`/v1/evaluations/${e.body.id}/acknowledge`).set(await as(USERS.gardener)).send({}).expect(403);
  });

  it('training & safety log with worker acknowledgment; refresher reminders are scheduled', async () => {
    const t = await http().post(`/v1/staff/${staffId}/trainings`).set(await as(USERS.head)).send({ category: 'EQUIPMENT_SAFETY', title: 'Lawn mower & trimmer safety',
      completedAt: riyadhDate(-345), validUntil: riyadhDate(20), hours: 2 }).expect(201);
    expect((await http().post(`/v1/trainings/${t.body.id}/acknowledge`).set(await as(USERS.gardener)).expect(201)).body.workerAckAt).toBeTruthy();
    await http().post(`/v1/trainings/${t.body.id}/acknowledge`).set(await as(USERS.gardener)).expect(403);
    await syncStaffComplianceReminders(worker, H1);
    const rows = await worker.run((tx) => tx.$queryRaw<Array<{ et: string; tier: number }>>`
      SELECT "entityType"::text AS et, ("titleI18n"->>'tier')::int AS tier FROM reminders
      WHERE "entityId" IN (${t.body.id}::uuid, ${staffId}::uuid) AND status = 'PENDING' ORDER BY et, tier DESC`);
    expect(rows).toEqual([{ et: 'MEDICAL_CHECKUP', tier: 60 }, { et: 'MEDICAL_CHECKUP', tier: 30 }, { et: 'MEDICAL_CHECKUP', tier: 15 },
                          { et: 'TRAINING', tier: 30 }, { et: 'TRAINING', tier: 15 }]);
  });
});
