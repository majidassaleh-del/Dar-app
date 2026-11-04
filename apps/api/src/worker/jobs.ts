import { createTenantKeys, type KmsProvider } from '@herp/crypto';
import type { ServiceDb } from './service-db';

/** Gives every household without an ACTIVE tenant key a fresh DEK + blind-index key (wrapped by KMS). */
export async function provisionTenantKeys(db: ServiceDb, kms: KmsProvider): Promise<number> {
  const missing = await db.run((tx) => tx.$queryRaw<Array<{ id: string }>>`
    SELECT h.id::text FROM households h
    WHERE h."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM tenant_keys k WHERE k."householdId" = h.id AND k.status = 'ACTIVE')`);
  for (const { id } of missing) {
    const rec = await createTenantKeys(kms, id, 1);
    await db.run((tx) => tx.tenantKey.create({ data: { householdId: id, version: 1, kmsKeyName: rec.kmsKeyName,
      wrappedDek: rec.wrappedDek, wrappedIndexKey: rec.wrappedIndexKey, status: 'ACTIVE' } }));
  }
  return missing.length;
}

/** Daily: keep 60/30/15-day (per-document) expiry reminders in sync. Idempotent. */
export async function syncDocumentReminders(db: ServiceDb, householdId?: string) {
  const [r] = await db.run((tx) => householdId
    ? tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_document_reminders(${householdId}::uuid)`
    : tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_document_reminders()`);
  return r ?? { inserted: 0, removed: 0 };
}
