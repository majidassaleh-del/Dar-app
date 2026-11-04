import { resolveI18n, type I18nText, type Locale } from '@herp/i18n';
import type { Prisma } from '@prisma/client';
import type { ServiceDb } from '../worker/service-db';
import { fcmMessage, whatsappTemplate } from './payloads';
import { renderReminder, WHATSAPP_LANG, WHATSAPP_TEMPLATE, type ReminderKind } from './render';
import type { Channel, ChannelSender } from './senders';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const MAX_ATTEMPTS = 5;

/** What a reminder is about, from its entity (all reads inside the reminder's household). */
async function describe(tx: Tx, r: { householdId: string; entityType: string; entityId: string }) {
  const staffName = (s: { fullNameI18n: Prisma.JsonValue } | null | undefined) => (s?.fullNameI18n ?? {}) as I18nText;
  switch (r.entityType) {
    case 'STAFF_DOCUMENT': {
      const d = await tx.identityDocument.findFirst({ where: { id: r.entityId, householdId: r.householdId }, include: { staff: { select: { fullNameI18n: true } } } });
      return d && { kind: 'document' as ReminderKind, itemKey: d.type, name: staffName(d.staff), deepLink: `herp://staff/${d.staffId}/documents/${d.id}` };
    }
    case 'MEDICAL_CHECKUP': {
      const s = await tx.staffProfile.findFirst({ where: { id: r.entityId, householdId: r.householdId }, select: { id: true, fullNameI18n: true } });
      return s && { kind: 'medical' as ReminderKind, itemKey: 'MEDICAL', name: staffName(s), deepLink: `herp://staff/${s.id}/health` };
    }
    case 'TRAINING': {
      const t = await tx.staffTraining.findFirst({ where: { id: r.entityId, householdId: r.householdId }, include: { staff: { select: { fullNameI18n: true } } } });
      return t && { kind: 'training' as ReminderKind, itemKey: t.category, name: staffName(t.staff), deepLink: `herp://staff/${t.staffId}/trainings` };
    }
    case 'ASSET_HANDOVER': {
      const h = await tx.assetHandover.findFirst({ where: { id: r.entityId, householdId: r.householdId }, include: { staff: { select: { fullNameI18n: true } } } });
      return h && { kind: 'handover' as ReminderKind, itemKey: h.itemType, name: staffName(h.staff), deepLink: `herp://staff/${h.staffId}/handovers` };
    }
    default: return null;
  }
}

/**
 * Reminder → per-recipient, per-channel deliveries (WhatsApp template, FCM push,
 * in-app), each rendered in the recipient's preferred language and stored with
 * its exact provider payload. Idempotent per (reminder, user, channel).
 * Recipients: the reminder's member, else the household admins (Head / EFA).
 * A reminder becomes SENT once its deliveries exist; each delivery is then sent
 * on its own, and FAILED ones are retried up to 5 times.
 */
export async function dispatchNotifications(db: ServiceDb, sender: ChannelSender, now = new Date(),
  scope: { householdId?: string; reminderIds?: string[] } = {}) {
  const result = { reminders: 0, created: 0, sent: 0, queued: 0, skipped: 0, failed: 0 };
  const due = await db.run((tx) => tx.reminder.findMany({ where: { status: 'PENDING', remindAt: { lte: now },
    ...(scope.householdId ? { householdId: scope.householdId } : {}), ...(scope.reminderIds ? { id: { in: scope.reminderIds } } : {}) }, orderBy: { remindAt: 'asc' }, take: 500 }));
  for (const r of due) {
    await db.run(async (tx) => {
      const about = await describe(tx, r);
      const recipients = r.recipientId
        ? await tx.membership.findMany({ where: { id: r.recipientId, status: 'ACTIVE' }, include: { user: { include: { devices: true } } } })
        : await tx.membership.findMany({ where: { householdId: r.householdId, status: 'ACTIVE', role: { systemRole: { in: ['HOUSEHOLD_HEAD', 'EFA_OFFICE_ADMIN'] } } },
            include: { user: { include: { devices: true } } } });
      const days = Math.ceil((r.dueAt.getTime() - now.getTime()) / DAY);
      for (const m of recipients) {
        const locale = m.user.preferredLocale as Locale;
        const name = about ? resolveI18n(about.name, { locale }).text : '';
        const text = about ? await renderReminder(locale, about.kind, { name, itemKey: about.itemKey, days })
                           : { title: resolveI18n(r.titleI18n as I18nText, { locale }).text, body: resolveI18n(r.titleI18n as I18nText, { locale }).text, item: '' };
        const dueLocal = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : locale, { dateStyle: 'medium', timeZone: 'Asia/Riyadh' }).format(r.dueAt);
        const data = { reminderId: r.id, kind: about?.kind ?? 'reminder', entityType: r.entityType, entityId: r.entityId, deepLink: about?.deepLink ?? 'herp://reminders' };
        for (const channel of r.channels as Channel[]) {
          let payload: unknown = null; let skip: string | null = null;
          if (channel === 'WHATSAPP') {
            if (!m.user.phone) skip = 'user has no phone number';
            else if (!about) skip = 'no WhatsApp template for this reminder kind';
            else payload = whatsappTemplate(m.user.phone, WHATSAPP_TEMPLATE[about.kind], WHATSAPP_LANG[locale],
              about.kind === 'medical' ? [name, dueLocal] : [name, text.item, dueLocal]);
          } else if (channel === 'PUSH') {
            if (!m.user.devices.length) skip = 'no registered device';
            else payload = m.user.devices.map((d) => fcmMessage(d.pushToken, text.title, text.body, data));
          } else if (channel === 'IN_APP') payload = { title: text.title, body: text.body, data };
          else skip = `channel ${channel} not implemented`;
          const res = await tx.notification.createMany({ skipDuplicates: true, data: [{
            householdId: r.householdId, userId: m.userId, reminderId: r.id, channel, locale, templateKey: `notify.${about?.kind ?? 'reminder'}`,
            params: { name, item: text.item, days: Math.max(0, days) }, title: text.title, body: text.body, deepLink: data.deepLink,
            payload: (payload ?? {}) as Prisma.InputJsonValue, status: skip ? 'SKIPPED' : 'QUEUED', error: skip } ] });
          result.created += res.count;
          if (skip) result.skipped += res.count;
        }
      }
      // Deliveries are materialised: the reminder is done; sending is tracked per delivery.
      await tx.reminder.update({ where: { id: r.id }, data: { status: 'SENT' } });
      result.reminders++;
    });
  }

  // Send every delivery still QUEUED (new, or waiting for a provider) or FAILED (retry).
  // "No provider configured" leaves it QUEUED without spending an attempt, so it goes out
  // once credentials are set; real failures count towards MAX_ATTEMPTS.
  const pending = await db.run((tx) => tx.notification.findMany({ where: { status: { in: ['QUEUED', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS },
    ...(scope.householdId ? { householdId: scope.householdId } : {}), ...(scope.reminderIds ? { reminderId: { in: scope.reminderIds } } : {}) },
    orderBy: { createdAt: 'asc' }, take: 2000 }));
  for (const n of pending) {
    const messages = n.channel === 'PUSH' ? (n.payload as unknown[]) : [n.payload];
    const outcomes = await Promise.all(messages.map((p) => sender.send(n.channel as Channel, p)));
    const failed = outcomes.find((o) => o.status === 'FAILED');
    const status = failed ? 'FAILED' : outcomes.every((o) => o.status === 'SENT') ? 'SENT' : 'QUEUED';
    const tried = outcomes.some((o) => o.status !== 'QUEUED');
    await db.run((tx) => tx.notification.update({ where: { id: n.id }, data: { status, ...(tried ? { attempts: { increment: 1 } } : {}),
      error: failed?.error ?? outcomes.find((o) => o.error)?.error ?? null,
      providerMessageId: outcomes.map((o) => o.providerMessageId).filter(Boolean).join(',') || null, sentAt: status === 'SENT' ? new Date() : null } }));
    result[status === 'SENT' ? 'sent' : status === 'FAILED' ? 'failed' : 'queued']++;
  }
  return result;
}
