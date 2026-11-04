import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { LocalKmsProvider } from '@herp/crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.factory';
import { ServiceDb } from '../src/worker/service-db';
import { provisionTenantKeys } from '../src/worker/jobs';
import { dispatchNotifications } from '../src/notifications/dispatch';
import { OutboxSender, type Channel, type ChannelSender, type SendResult } from '../src/notifications/senders';
import { H1, H2, MEMBERSHIPS, USERS, as, riyadhDate, testEnv } from './helpers';

let app: INestApplication;
let worker: ServiceDb;
const http = () => request(app.getHttpServer());
let staffId = '';
const DAY = 86_400_000;
const HEAD_TOKEN = 'fcm-token-head-ios-0000000000000000000001';

/** Records every provider call; optionally fails one channel. */
class RecordingSender implements ChannelSender {
  calls: Array<{ channel: Channel; payload: any }> = [];
  constructor(private readonly failing?: Channel) {}
  async send(channel: Channel, payload: unknown): Promise<SendResult> {
    this.calls.push({ channel, payload });
    return channel === this.failing ? { status: 'FAILED', error: 'provider said no' } : { status: 'SENT', providerMessageId: `${channel}-${this.calls.length}` };
  }
}

async function reminder(fields: { recipientId?: string; channels: Channel[]; dueInDays: number }) {
  const [r] = await worker.run((tx) => tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO reminders (id, "householdId", "recipientId", "entityType", "entityId", "titleI18n", "dueAt", "remindAt", channels)
    VALUES (gen_random_uuid(), ${H1}::uuid, ${fields.recipientId ?? null}::uuid, 'MEDICAL_CHECKUP', ${staffId}::uuid, '{"en":"Medical"}',
            ${new Date(Date.now() + fields.dueInDays * DAY)}, now() - interval '1 minute', ${fields.channels}::"NotificationChannel"[])
    RETURNING id::text`);
  return r!.id;
}
const deliveries = (reminderId: string) => worker.run((tx) => tx.notification.findMany({ where: { reminderId }, orderBy: [{ userId: 'asc' }, { channel: 'asc' }] }));

beforeAll(async () => {
  testEnv();
  worker = new ServiceDb(process.env.WORKER_DATABASE_URL!);
  await provisionTenantKeys(worker, new LocalKmsProvider(process.env.HERP_LOCAL_KEK, 'test'));
  app = await createApp(); await app.init();
  staffId = (await http().post('/v1/staff').set(await as(USERS.head)).send({ staffType: 'DRIVER', fullName: { en: 'Karim Saleh', ar: 'كريم صالح' },
    nationality: 'SD', hireDate: riyadhDate(-40) }).expect(201)).body.id;
  await worker.run(async (tx) => {
    await tx.user.update({ where: { id: USERS.head }, data: { phone: '+966500000101' } });
    await tx.user.update({ where: { id: USERS.maid }, data: { phone: '+639170000103' } });
  });
});
afterAll(async () => {
  await worker?.run((tx) => tx.user.updateMany({ where: { id: { in: [USERS.head, USERS.maid] } }, data: { phone: null } }));
  await app?.close(); await worker?.close();
});

describe('push devices', () => {
  it('register (upsert by token), a token bound to another account is refused (not re-bound), delete own only', async () => {
    const d = await http().post('/v1/me/devices').set(await as(USERS.head)).send({ platform: 'ios', pushToken: HEAD_TOKEN, appVersion: '1.0.0' }).expect(201);
    const again = await http().post('/v1/me/devices').set(await as(USERS.head)).send({ platform: 'ios', pushToken: HEAD_TOKEN, appVersion: '1.0.1' }).expect(201);
    expect(again.body).toMatchObject({ id: d.body.id, appVersion: '1.0.1' });
    await http().post('/v1/me/devices').set(await as(USERS.head2, H2)).send({ platform: 'android', pushToken: HEAD_TOKEN }).expect(403);
    expect((await worker.run((tx) => tx.userDevice.findUniqueOrThrow({ where: { pushToken: HEAD_TOKEN } }))).userId).toBe(USERS.head);
    await http().delete(`/v1/me/devices/${d.body.id}`).set(await as(USERS.efa)).expect(404);
  });
});

describe('multi-channel reminder dispatch', () => {
  let adminReminder = '';
  let sender: RecordingSender;

  it('admin reminder → WhatsApp template + FCM push + in-app, in each admin’s language; SKIPPED without phone / device', async () => {
    adminReminder = await reminder({ channels: ['WHATSAPP', 'PUSH', 'IN_APP'], dueInDays: 10 });
    sender = new RecordingSender();
    const r = await dispatchNotifications(worker, sender, new Date(), { reminderIds: [adminReminder] });
    expect(r).toMatchObject({ reminders: 1, created: 6, skipped: 2, sent: 4, failed: 0 });

    const rows = await deliveries(adminReminder);
    const head = rows.filter((n) => n.userId === USERS.head), efa = rows.filter((n) => n.userId === USERS.efa);
    expect(head.map((n) => [n.channel, n.status]).sort()).toEqual([['IN_APP', 'SENT'], ['PUSH', 'SENT'], ['WHATSAPP', 'SENT']]);
    expect(efa.filter((n) => n.status === 'SKIPPED').map((n) => [n.channel, n.error]).sort()).toEqual([['PUSH', 'no registered device'], ['WHATSAPP', 'user has no phone number']]);
    expect(efa.find((n) => n.channel === 'IN_APP')!.status).toBe('SENT');

    const wa = head.find((n) => n.channel === 'WHATSAPP')!;
    expect(wa).toMatchObject({ locale: 'ar', attempts: 1, providerMessageId: expect.stringMatching(/^WHATSAPP-/) });
    expect(wa.payload).toMatchObject({ messaging_product: 'whatsapp', to: '966500000101', type: 'template',
      template: { name: 'herp_medical_due', language: { code: 'ar' } } });
    const params = (wa.payload as any).template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(params[0]).toBe('كريم صالح');
    expect(params).toHaveLength(2);
    expect(wa.body).toContain('كريم صالح');

    const push = head.find((n) => n.channel === 'PUSH')!;
    expect(push.payload).toEqual([expect.objectContaining({ message: expect.objectContaining({ token: HEAD_TOKEN,
      notification: { title: wa.title, body: wa.body }, data: expect.objectContaining({ reminderId: adminReminder, kind: 'medical', deepLink: `herp://staff/${staffId}/health` }) }) })]);
    expect(sender.calls.map((c) => c.channel).sort()).toEqual(['IN_APP', 'IN_APP', 'PUSH', 'WHATSAPP']);
    expect((await worker.run((tx) => tx.reminder.findUniqueOrThrow({ where: { id: adminReminder } }))).status).toBe('SENT');
  });

  it('idempotent: a second run creates and sends nothing', async () => {
    const again = new RecordingSender();
    expect(await dispatchNotifications(worker, again, new Date(), { reminderIds: [adminReminder] })).toMatchObject({ reminders: 0, created: 0, sent: 0 });
    expect(again.calls).toHaveLength(0);
  });

  it('member reminder in Tagalog; WhatsApp language mapped to fil', async () => {
    const id = await reminder({ recipientId: MEMBERSHIPS.maid, channels: ['WHATSAPP', 'IN_APP'], dueInDays: 1 });
    await dispatchNotifications(worker, new RecordingSender(), new Date(), { reminderIds: [id] });
    const rows = await deliveries(id);
    expect(rows.every((n) => n.userId === USERS.maid && n.locale === 'tl' && n.status === 'SENT')).toBe(true);
    const wa = rows.find((n) => n.channel === 'WHATSAPP')!;
    expect((wa.payload as any).template.language.code).toBe('fil');
    expect(wa.body).toContain('كريم صالح'); // no Tagalog name: falls back to the household default (ar)
    expect(wa.body).toMatch(/1 araw/);
  });

  it('overdue reminders use the overdue wording', async () => {
    const id = await reminder({ recipientId: MEMBERSHIPS.maid, channels: ['IN_APP'], dueInDays: -3 });
    await dispatchNotifications(worker, new RecordingSender(), new Date(), { reminderIds: [id] });
    expect((await deliveries(id))[0]!.body).toMatch(/^Overdue/);
  });

  it('provider failure → FAILED (attempt counted), retried on the next run', async () => {
    const id = await reminder({ recipientId: MEMBERSHIPS.maid, channels: ['WHATSAPP'], dueInDays: 30 });
    expect(await dispatchNotifications(worker, new RecordingSender('WHATSAPP'), new Date(), { reminderIds: [id] })).toMatchObject({ failed: 1 });
    expect((await deliveries(id))[0]).toMatchObject({ status: 'FAILED', attempts: 1, error: 'provider said no' });
    expect(await dispatchNotifications(worker, new RecordingSender(), new Date(), { reminderIds: [id] })).toMatchObject({ reminders: 0, sent: 1 });
    expect((await deliveries(id))[0]).toMatchObject({ status: 'SENT', attempts: 2, error: null });
  });

  it('no provider configured: stays QUEUED with its payload, no attempt spent; sent once a provider exists', async () => {
    const id = await reminder({ recipientId: MEMBERSHIPS.maid, channels: ['WHATSAPP', 'IN_APP'], dueInDays: 15 });
    expect(await dispatchNotifications(worker, new OutboxSender(), new Date(), { reminderIds: [id] })).toMatchObject({ queued: 1, sent: 1 });
    expect((await deliveries(id)).find((n) => n.channel === 'WHATSAPP')).toMatchObject({ status: 'QUEUED', attempts: 0, payload: expect.objectContaining({ to: '639170000103' }) });
    await dispatchNotifications(worker, new RecordingSender(), new Date(), { reminderIds: [id] });
    expect((await deliveries(id)).find((n) => n.channel === 'WHATSAPP')).toMatchObject({ status: 'SENT', attempts: 1 });
  });
});

describe('in-app inbox', () => {
  it('own notifications only, in the stored language; mark read / read all', async () => {
    const list = await http().get('/v1/notifications?unread=true').set(await as(USERS.head)).expect(200);
    const mine = list.body.data.find((n: { body: string }) => n.body.includes('كريم صالح'));
    expect(mine).toMatchObject({ locale: 'ar', deepLink: `herp://staff/${staffId}/health`, readAt: null });
    const spouse = await http().get('/v1/notifications').set(await as(USERS.spouse)).expect(200);
    expect(spouse.body.data.find((n: { id: string }) => n.id === mine.id)).toBeUndefined();
    await http().post(`/v1/notifications/${mine.id}/read`).set(await as(USERS.efa)).expect(404);
    await http().post(`/v1/notifications/${mine.id}/read`).set(await as(USERS.head)).expect(201);
    expect((await http().get('/v1/notifications?unread=true').set(await as(USERS.head))).body.data.find((n: { id: string }) => n.id === mine.id)).toBeUndefined();
    await http().post('/v1/notifications/read-all').set(await as(USERS.maid)).expect(201);
    expect((await http().get('/v1/notifications?unread=true').set(await as(USERS.maid))).body.data).toHaveLength(0);
  });

  it('deliveries are written by the dispatcher only (app_user has no INSERT / DELETE)', async () => {
    const [n] = await worker.run((tx) => tx.notification.findMany({ where: { userId: USERS.head }, take: 1 }));
    const r = await worker.run((tx) => tx.$queryRaw<Array<{ ins: boolean; del: boolean; upd_body: boolean; upd_read: boolean }>>`
      SELECT has_table_privilege('app_user', 'notifications', 'INSERT') AS ins, has_table_privilege('app_user', 'notifications', 'DELETE') AS del,
             has_column_privilege('app_user', 'notifications', 'body', 'UPDATE') AS upd_body, has_column_privilege('app_user', 'notifications', 'readAt', 'UPDATE') AS upd_read`);
    expect(r[0]).toEqual({ ins: false, del: false, upd_body: false, upd_read: true });
    expect(n).toBeDefined();
  });
});

describe('EFA Daily Pulse', () => {
  it('Head and EFA get the summary; attention sorted by severity', async () => {
    const r = await http().get('/v1/dashboard/pulse').set(await as(USERS.efa)).expect(200);
    expect(r.body).toMatchObject({ today: riyadhDate(0), payroll: { currentMonth: { period: riyadhDate(0).slice(0, 7) } },
      medical: expect.objectContaining({ workers: expect.any(Number) }), workOrders: expect.any(Object), pettyCash: expect.any(Object),
      budgets: expect.any(Object), fundingClearing: expect.any(Object), handovers: expect.any(Object) });
    expect(r.body.medical.needsAction).toEqual(expect.arrayContaining([expect.objectContaining({ staffId, status: 'MISSING', name: 'Karim Saleh' })]));
    expect(r.body.attention).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'pulse.medicalOverdue', severity: 'critical' })]));
    const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
    for (const l of ['ar', 'en', 'hi', 'tl', 'am', 'bn']) {
      const pulse = JSON.parse(readFileSync(`${__dirname}/../../../packages/i18n/messages/${l}.json`, 'utf8')).pulse;
      for (const a of r.body.attention) expect(pulse[a.key.replace(/^pulse\./, '')], `${l}:${a.key}`).toBeTruthy();
    }
    const ranks = r.body.attention.map((a: { severity: string }) => rank[a.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const ar = await http().get('/v1/dashboard/pulse').set(await as(USERS.head, H1, 'ar')).expect(200);
    expect(ar.body.medical.needsAction.find((x: { staffId: string }) => x.staffId === staffId).name).toBe('كريم صالح');
  });

  it('isolated per household; spouse and staff are refused', async () => {
    const other = await http().get('/v1/dashboard/pulse').set(await as(USERS.head2, H2)).expect(200);
    expect(other.body.medical.needsAction.find((x: { staffId: string }) => x.staffId === staffId)).toBeUndefined();
    await http().get('/v1/dashboard/pulse').set(await as(USERS.spouse)).expect(403);
    await http().get('/v1/dashboard/pulse').set(await as(USERS.maid)).expect(403);
    await http().get('/v1/dashboard/pulse').set(await as(USERS.head2)).expect(404); // not a member of H1
  });
});
