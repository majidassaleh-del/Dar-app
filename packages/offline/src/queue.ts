import { openJson, sealJson } from './envelope';
import type { KeyValueStore } from './kv';

export type SyncOp =
  | { opId: string; kind: 'TASK_UPDATE'; entityId: string; baseVersion: number; clientAt: string;
      data: { status?: 'TODO' | 'IN_PROGRESS' | 'DONE'; proofPhotoUrl?: string } }
  | { opId: string; kind: 'INSTRUCTION_COMPLETE'; entityId: string; baseVersion: number; clientAt: string;
      data: { note?: string; photoStorageKey?: string } };
export type NewOp = SyncOp extends infer O ? O extends SyncOp ? Omit<O, 'opId' | 'clientAt'> : never : never;

export interface OpResult { opId: string; result: 'APPLIED' | 'CONFLICT' | 'REJECTED'; version?: number; server?: unknown; problem?: unknown }
/** Sends a batch to POST /v1/sync/push. Throw on network / 5xx errors, so ops stay queued. */
export type Transport = (ops: SyncOp[]) => Promise<OpResult[]>;

export interface FlushReport {
  applied: number;
  conflicts: Array<{ op: SyncOp; server: unknown }>;
  rejected: Array<{ op: SyncOp; problem: unknown }>;
  remaining: number;
  error?: unknown;
}

export class QueueTamperedError extends Error {
  constructor(readonly slot: string) { super(`offline queue entry ${slot} cannot be decrypted`); this.name = 'QueueTamperedError'; }
}

const BATCH = 100;

/**
 * Encrypted, ordered, at-least-once outbox for chore and instruction updates.
 *
 * Each op is sealed with the data key (AES-256-GCM). The AAD is `<namespace>:<slot>`, so
 * entries cannot be swapped between members or reordered undetected. Nothing in
 * the store reveals what was done, only how many ops are pending.
 * The server deduplicates on opId, so a flush that dies after sending is safe to
 * retry. Conflicts and rejections are handed back to the app (shown to the
 * worker) and leave the queue.
 */
export class OfflineQueue {
  private readonly prefix: string;
  constructor(private readonly store: KeyValueStore, private readonly key: CryptoKey, namespace: string,
              private readonly opts: { subtle?: SubtleCrypto; now?: () => Date; uuid?: () => string } = {}) {
    if (!/^[\w-]+$/.test(namespace)) throw new Error('namespace must be a membership id');
    this.prefix = `q:${namespace}:`;
  }

  async enqueue(op: NewOp): Promise<string> {
    const full = { ...op, opId: (this.opts.uuid ?? (() => globalThis.crypto.randomUUID()))(), clientAt: (this.opts.now?.() ?? new Date()).toISOString() } as SyncOp;
    const seqKey = `${this.prefix}seq`;
    const seq = Number((await this.store.get(seqKey)) ?? '0') + 1;
    await this.store.set(seqKey, String(seq));
    const slot = `${this.prefix}${String(seq).padStart(12, '0')}`;
    await this.store.set(slot, await sealJson(this.key, full, slot, this.opts.subtle));
    return full.opId;
  }

  private async slots() {
    return (await this.store.keys(this.prefix)).filter((k) => /:\d{12}$/.test(k)).sort();
  }

  async size() { return (await this.slots()).length; }

  /** Decrypted ops, oldest first. */
  async pending(): Promise<Array<{ slot: string; op: SyncOp }>> {
    const out = [];
    for (const slot of await this.slots()) {
      const sealed = await this.store.get(slot);
      if (!sealed) continue;
      try { out.push({ slot, op: await openJson<SyncOp>(this.key, sealed, slot, this.opts.subtle) }); }
      catch { throw new QueueTamperedError(slot); }
    }
    return out;
  }

  async flush(send: Transport): Promise<FlushReport> {
    const report: FlushReport = { applied: 0, conflicts: [], rejected: [], remaining: 0 };
    const all = await this.pending();
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      let results: OpResult[];
      try { results = await send(batch.map((b) => b.op)); } catch (error) {
        report.error = error; break;
      }
      const byId = new Map(results.map((r) => [r.opId, r]));
      for (const { slot, op } of batch) {
        const r = byId.get(op.opId);
        if (!r) continue; // not answered: keep it for the next flush
        if (r.result === 'APPLIED') report.applied++;
        else if (r.result === 'CONFLICT') report.conflicts.push({ op, server: r.server });
        else report.rejected.push({ op, problem: r.problem });
        await this.store.delete(slot);
      }
    }
    report.remaining = await this.size();
    return report;
  }

  /** Sign-out: drop everything (ciphertext is useless without the key anyway). */
  async clear() {
    for (const k of await this.store.keys(this.prefix)) await this.store.delete(k);
  }
}

/** Transport for POST /v1/sync/push. */
export function httpTransport(cfg: { baseUrl: string; deviceId: string; householdId: string; token: () => Promise<string>; fetch?: typeof fetch }): Transport {
  return async (ops) => {
    const res = await (cfg.fetch ?? fetch)(`${cfg.baseUrl}/v1/sync/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await cfg.token()}`, 'X-Household-Id': cfg.householdId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: cfg.deviceId, ops }),
    });
    // 400 = the batch itself is invalid (e.g. an op from an older app version): drop it, report every op.
    if (res.status === 400) { const problem = await res.json().catch(() => ({ status: 400 })); return ops.map((o) => ({ opId: o.opId, result: 'REJECTED' as const, problem })); }
    if (!res.ok) throw new Error(`sync push failed: HTTP ${res.status}`); // 401 / 429 / 5xx: keep queued
    return ((await res.json()) as { results: OpResult[] }).results;
  };
}
