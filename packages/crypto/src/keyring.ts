import { randomBytes } from 'node:crypto';
import type { KmsProvider } from './kms/provider';

/** Row shape of the `tenant_keys` table. */
export interface TenantKeyRecord {
  householdId: string;
  version: number;
  kmsKeyName: string;
  wrappedDek: Buffer;
  wrappedIndexKey: Buffer;
  status: 'ACTIVE' | 'DECRYPT_ONLY' | 'DESTROYED' | string;
}

export interface TenantKeys {
  version: number;
  dek: Buffer;
  indexKey: Buffer;
}

const aadFor = (householdId: string, version: number, purpose: 'dek' | 'index') =>
  `herp:tenant-key:${householdId}:v${version}:${purpose}`;

/** Called by the key-management worker (app_service) when a household is created or a key is rotated. */
export async function createTenantKeys(kms: KmsProvider, householdId: string, version: number): Promise<TenantKeyRecord> {
  const dek = randomBytes(32), indexKey = randomBytes(32);
  try {
    return {
      householdId, version, kmsKeyName: kms.keyName, status: 'ACTIVE',
      wrappedDek: await kms.wrap(dek, aadFor(householdId, version, 'dek')),
      wrappedIndexKey: await kms.wrap(indexKey, aadFor(householdId, version, 'index')),
    };
  } finally {
    dek.fill(0); indexKey.fill(0);
  }
}

/**
 * Unwraps tenant keys on demand and caches the plaintext for a short TTL, so
 * a list of 50 passports costs one KMS call, not 50. Evicted keys are zeroed.
 */
export class TenantKeyring {
  readonly #cache = new Map<string, { keys: TenantKeys; expires: number }>();

  constructor(
    private readonly kms: KmsProvider,
    /** Loads wrapped key rows for a household (RLS lets the API read only its own tenant's). */
    private readonly load: (householdId: string) => Promise<TenantKeyRecord[]>,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(householdId: string, version?: number): Promise<TenantKeys> {
    const records = await this.load(householdId);
    const usable = records.filter((r) => r.householdId === householdId && r.status !== 'DESTROYED');
    const rec = version === undefined
      ? usable.filter((r) => r.status === 'ACTIVE').sort((a, b) => b.version - a.version)[0]
      : usable.find((r) => r.version === version);
    if (!rec) throw new Error(version === undefined ? `no active key for household ${householdId}` : `key v${version} unavailable for household ${householdId} (destroyed or missing)`);

    const id = `${householdId}:${rec.version}`;
    const hit = this.#cache.get(id);
    if (hit && hit.expires > this.now()) return hit.keys;
    if (hit) this.#evict(id);

    const keys: TenantKeys = {
      version: rec.version,
      dek: await this.kms.unwrap(rec.wrappedDek, aadFor(householdId, rec.version, 'dek')),
      indexKey: await this.kms.unwrap(rec.wrappedIndexKey, aadFor(householdId, rec.version, 'index')),
    };
    this.#cache.set(id, { keys, expires: this.now() + this.ttlMs });
    return keys;
  }

  #evict(id: string) {
    const e = this.#cache.get(id);
    if (e) { e.keys.dek.fill(0); e.keys.indexKey.fill(0); this.#cache.delete(id); }
  }

  /** Call on shutdown and after crypto-shredding a tenant. */
  clear(householdId?: string) {
    for (const id of [...this.#cache.keys()]) if (!householdId || id.startsWith(`${householdId}:`)) this.#evict(id);
  }
}
