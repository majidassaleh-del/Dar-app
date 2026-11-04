import { loadEnv } from '../config/env';
import { createKms } from '../crypto/kms';
import { ServiceDb } from './service-db';
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
      default: console.error('usage: worker <keys:provision | reminders:sync | recurring:run>'); process.exitCode = 2;
    }
  } finally { await db.close(); }
})();
