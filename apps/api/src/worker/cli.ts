import { loadEnv } from '../config/env';
import { createKms } from '../crypto/kms';
import { ServiceDb } from './service-db';
import { dispatchNotifications } from '../notifications/dispatch';
import { HttpSender, OutboxSender } from '../notifications/senders';
import { provisionTenantKeys, runRecurringBills, syncDocumentReminders, syncStaffComplianceReminders } from './jobs';

/** node dist/worker.js <keys:provision | reminders:documents> — run by Cloud Scheduler / cron. */
void (async () => {
  const env = loadEnv();
  if (!env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required for worker jobs');
  const db = new ServiceDb(env.WORKER_DATABASE_URL);
  try {
    switch (process.argv[2]) {
      case 'keys:provision': console.log(`provisioned keys for ${await provisionTenantKeys(db, await createKms(env))} household(s)`); break;
      case 'reminders:documents': // kept as an alias of reminders:sync
      case 'reminders:sync': console.log(JSON.stringify({ documents: await syncDocumentReminders(db), compliance: await syncStaffComplianceReminders(db) })); break;
      case 'recurring:run': console.log(JSON.stringify(await runRecurringBills(db))); break;
      case 'notifications:dispatch': {
        const configured = (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TOKEN) || (env.FCM_PROJECT_ID && env.FCM_ACCESS_TOKEN);
        const sender = configured ? new HttpSender({ whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, whatsappToken: env.WHATSAPP_TOKEN,
          fcmProjectId: env.FCM_PROJECT_ID, fcmAccessToken: env.FCM_ACCESS_TOKEN ? async () => env.FCM_ACCESS_TOKEN! : undefined }) : new OutboxSender();
        console.log(JSON.stringify(await dispatchNotifications(db, sender)));
        break;
      }
      default: console.error('usage: worker <keys:provision | reminders:sync | recurring:run | notifications:dispatch>'); process.exitCode = 2;
    }
  } finally { await db.close(); }
})();
