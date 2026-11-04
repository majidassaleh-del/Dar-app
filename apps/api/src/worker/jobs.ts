import { esbFor } from '../hr/esb';
import { createTenantKeys, type KmsProvider } from '@herp/crypto';
import type { ServiceDb } from './service-db';
import { nextOccurrence } from '../banking/banking.common';

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
/** Medical checkups (every worker), training refreshers and item returns. Idempotent. */
export async function syncStaffComplianceReminders(db: ServiceDb, householdId?: string) {
  const [r] = await db.run((tx) => householdId
    ? tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_staff_compliance_reminders(${householdId}::uuid)`
    : tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_staff_compliance_reminders()`);
  return r ?? { inserted: 0, removed: 0 };
}

/** Istimara / insurance / Fahas expiries and preventive maintenance (date and km). Idempotent. */
export async function syncFleetReminders(db: ServiceDb, householdId?: string) {
  const [r] = await db.run((tx) => householdId
    ? tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_fleet_reminders(${householdId}::uuid)`
    : tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_fleet_reminders()`);
  return r ?? { inserted: 0, removed: 0 };
}

export async function syncDocumentReminders(db: ServiceDb, householdId?: string) {
  const [r] = await db.run((tx) => householdId
    ? tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_document_reminders(${householdId}::uuid)`
    : tx.$queryRaw<Array<{ inserted: number; removed: number }>>`SELECT * FROM app.sync_document_reminders()`);
  return r ?? { inserted: 0, removed: 0 };
}

/**
 * Recurring bills: one transaction per due occurrence (catching up at most 12),
 * idempotent through externalRef "recurring:<ruleId>:<YYYY-MM-DD>" and the
 * (household, account, externalRef) unique key. A failing rule (inactive
 * account, card limit…) is reported and retried next run; others continue.
 */
export async function runRecurringBills(db: ServiceDb, now = new Date()) {
  const due = await db.run((tx) => tx.recurringRule.findMany({ where: { isActive: true, nextRunAt: { lte: now } } }));
  const result = { rules: due.length, created: 0, failures: [] as Array<{ ruleId: string; error: string }> };
  for (const rule of due) {
    try {
      await db.run(async (tx) => {
        const h = await tx.household.findFirstOrThrow({ where: { id: rule.householdId }, select: { baseCurrency: true } });
        const t = rule.template as { type: 'EXPENSE' | 'INCOME' | 'TRANSFER'; accountId: string; amount: number; categoryId?: string; cardId?: string;
          counterAccountId?: string; merchantName?: string; description?: string };
        let next = rule.nextRunAt; let n = 0; let active = true;
        while (next <= now && n < 12) {
          if (rule.endsAt && next > rule.endsAt) { active = false; break; }
          const r = await tx.transaction.createMany({ skipDuplicates: true, data: [{
            householdId: rule.householdId, accountId: t.accountId, counterAccountId: t.counterAccountId, cardId: t.cardId, categoryId: t.categoryId,
            type: t.type, amount: t.amount, baseAmount: t.amount, currency: h.baseCurrency, merchantName: t.merchantName,
            descriptionI18n: t.description ? { en: t.description } : rule.nameI18n ?? {}, occurredAt: next, source: 'RECURRING',
            status: rule.autoPost ? 'POSTED' : 'PENDING', recurringRuleId: rule.id, createdById: rule.createdById,
            externalRef: `recurring:${rule.id}:${next.toISOString().slice(0, 10)}` }] });
          result.created += r.count; n++;
          next = nextOccurrence(next, rule.frequency, rule.interval, rule.dayOfPeriod);
        }
        if (rule.endsAt && next > rule.endsAt) active = false;
        await tx.recurringRule.update({ where: { id: rule.id }, data: { nextRunAt: next, lastRunAt: now, isActive: active } });
      });
    } catch (e) {
      result.failures.push({ ruleId: rule.id, error: e instanceof Error ? e.message.split('\n').slice(-1)[0]! : String(e) });
    }
  }
  return result;
}

/**
 * Monthly ESB accrual snapshots (one row per worker per month, idempotent):
 * vested amount, accounting provision and the change since the previous month.
 */
export async function accrueEndOfService(db: ServiceDb, year: number, month: number, householdId?: string) {
  const monthEnd = new Date(Date.UTC(year, month, 0));
  const staff = await db.run((tx) => tx.staffProfile.findMany({ where: { deletedAt: null, ...(householdId ? { householdId } : {}),
    contracts: { some: { startDate: { lte: monthEnd } } } }, select: { id: true, householdId: true } }));
  let written = 0;
  for (const s of staff) {
    await db.run(async (tx) => {
      const r = await esbFor(tx, s.id, monthEnd);
      if (!r) return;
      const prev = await tx.esbAccrual.findFirst({ where: { staffId: s.id, OR: [{ periodYear: { lt: year } }, { periodYear: year, periodMonth: { lt: month } }] },
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }] });
      const delta = (Number(r.provision) - Number(prev?.provision ?? 0)).toFixed(2);
      const data = { rule: r.rule, serviceDays: r.serviceDays, monthlyWage: r.monthlyWage, vested: r.vested, provision: r.provision, delta, detail: r, computedAt: new Date() };
      await tx.esbAccrual.upsert({ where: { staffId_periodYear_periodMonth: { staffId: s.id, periodYear: year, periodMonth: month } },
        create: { householdId: s.householdId, staffId: s.id, periodYear: year, periodMonth: month, ...data }, update: data });
      written++;
    });
  }
  return { period: `${year}-${String(month).padStart(2, '0')}`, workers: written };
}
