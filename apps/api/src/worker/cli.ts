import { loadEnv } from '../config/env';
import { createKms } from '../crypto/kms';
import { ServiceDb } from './service-db';
import { provisionTenantKeys, syncDocumentReminders } from './jobs';

/** node dist/worker.js <keys:provision | reminders:documents> — run by Cloud Scheduler / cron. */
void (async () => {
  const env = loadEnv();
  if (!env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required for worker jobs');
  const db = new ServiceDb(env.WORKER_DATABASE_URL);
  try {
    switch (process.argv[2]) {
      case 'keys:provision': console.log(`provisioned keys for ${await provisionTenantKeys(db, await createKms(env))} household(s)`); break;
      case 'reminders:documents': console.log(JSON.stringify(await syncDocumentReminders(db))); break;
      default: console.error('usage: worker <keys:provision | reminders:documents>'); process.exitCode = 2;
    }
  } finally { await db.close(); }
})();
