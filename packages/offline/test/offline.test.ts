import { describe, expect, it } from 'vitest';
import {
  MemoryStore, OfflineQueue, UnlockService, VaultCancelledError, VaultInvalidatedError, httpTransport, importAesKey, randomBytes,
  QueueTamperedError, type KeyVault, type OpResult, type SyncOp,
} from '../src';

/** Simulates the OS vault: biometrics on/off, cancel, re-enrolment invalidation. */
class FakeVault implements KeyVault {
  secret: Uint8Array | null = null;
  available = true; mode: 'ok' | 'cancel' | 'invalidated' = 'ok'; prompts: string[] = [];
  async isAvailable() { return this.available; }
  async read(prompt: string) {
    this.prompts.push(prompt);
    if (this.mode === 'cancel') throw new VaultCancelledError();
    if (this.mode === 'invalidated') throw new VaultInvalidatedError();
    return this.secret ? new Uint8Array(this.secret) : null;
  }
  async write(s: Uint8Array) { this.secret = new Uint8Array(s); this.mode = 'ok'; }
  async remove() { this.secret = null; }
}

const NS = 'c0000000-0000-0000-0000-000000000006';
const fallback = randomBytes(32);

async function fresh() {
  const store = new MemoryStore(), vault = new FakeVault();
  const svc = new UnlockService(store, vault, NS);
  const key = await svc.setup(fallback);
  return { store, vault, svc, key };
}

describe('biometric unlock', () => {
  it('setup stores no plaintext key; everyday unlock is one biometric prompt and opens the queue', async () => {
    const { store, vault, svc, key } = await fresh();
    const q = new OfflineQueue(store, key, NS);
    await q.enqueue({ kind: 'TASK_UPDATE', entityId: 'e1', baseVersion: 1, data: { status: 'DONE' } });
    const dump = [...store.data.values()].join('|');
    expect(dump).not.toContain('DONE');
    expect(dump).not.toContain(Buffer.from(vault.secret!).toString('base64'));

    const u = await svc.unlock('Unlock your tasks');
    expect(u.status).toBe('unlocked');
    expect(vault.prompts).toEqual(['Unlock your tasks']);
    if (u.status !== 'unlocked') throw new Error();
    expect((await new OfflineQueue(store, u.key, NS).pending())[0]!.op).toMatchObject({ entityId: 'e1', data: { status: 'DONE' } });
  });

  it('cancelled prompt: nothing changes, try again', async () => {
    const { vault, svc } = await fresh();
    vault.mode = 'cancel';
    expect(await svc.unlock('p')).toEqual({ status: 'cancelled' });
    vault.mode = 'ok';
    expect((await svc.unlock('p')).status).toBe('unlocked');
  });

  it('biometrics re-enrolled → invalidated → OTP fallback recovers the same key and re-enrols; queued work survives', async () => {
    const { store, vault, svc, key } = await fresh();
    await new OfflineQueue(store, key, NS).enqueue({ kind: 'INSTRUCTION_COMPLETE', entityId: 'i1', baseVersion: 1, data: { note: 'fridge emptied' } });
    vault.mode = 'invalidated';
    expect(await svc.unlock('p')).toEqual({ status: 'needs-fallback', reason: 'invalidated' });
    expect(vault.secret).toBeNull();
    const r = await svc.unlockWithFallback(fallback);
    expect(r.via).toBe('fallback');
    expect((await new OfflineQueue(store, r.key, NS).pending())[0]!.op.data).toEqual({ note: 'fridge emptied' });
    expect((await svc.unlock('p')).status).toBe('unlocked'); // re-enrolled
  });

  it('no biometrics on the device → OTP fallback every time; wrong fallback key is refused', async () => {
    const { vault, svc } = await fresh();
    vault.available = false;
    expect(await svc.unlock('p')).toEqual({ status: 'needs-fallback', reason: 'no-biometrics' });
    await expect(svc.unlockWithFallback(randomBytes(32))).rejects.toThrow(/cannot open/);
    expect((await svc.unlockWithFallback(fallback)).status).toBe('unlocked');
  });

  it('a vault secret that does not match this device data is treated as invalidated', async () => {
    const { vault, svc } = await fresh();
    vault.secret = randomBytes(32);
    expect(await svc.unlock('p')).toEqual({ status: 'needs-fallback', reason: 'invalidated' });
  });

  it('not set up / reset', async () => {
    const { store, vault, svc } = await fresh();
    await svc.reset();
    expect(vault.secret).toBeNull();
    expect(await svc.unlock('p')).toEqual({ status: 'not-set-up' });
    expect(store.data.size).toBe(0);
  });
});

describe('encrypted offline queue', () => {
  const recorder = (answer: (op: SyncOp) => OpResult | undefined) => {
    const calls: SyncOp[][] = [];
    const send = async (ops: SyncOp[]) => { calls.push(ops); return ops.map(answer).filter((x): x is OpResult => !!x); };
    return { calls, send };
  };

  it('keeps order across many ops and batches of 100', async () => {
    const { store, key } = await fresh();
    const q = new OfflineQueue(store, key, NS);
    for (let i = 0; i < 150; i++) await q.enqueue({ kind: 'TASK_UPDATE', entityId: `t${i}`, baseVersion: 1, data: { status: 'IN_PROGRESS' } });
    const r = recorder((op) => ({ opId: op.opId, result: 'APPLIED', version: 2 }));
    expect(await q.flush(r.send)).toMatchObject({ applied: 150, remaining: 0 });
    expect(r.calls.map((c) => c.length)).toEqual([100, 50]);
    expect(r.calls.flat().map((o) => o.entityId)).toEqual(Array.from({ length: 150 }, (_, i) => `t${i}`));
  });

  it('network failure keeps everything; replay sends the same opIds (server dedupes)', async () => {
    const { store, key } = await fresh();
    const q = new OfflineQueue(store, key, NS);
    const id = await q.enqueue({ kind: 'TASK_UPDATE', entityId: 't', baseVersion: 1, data: { status: 'DONE' } });
    const down = await q.flush(async () => { throw new Error('offline'); });
    expect(down).toMatchObject({ applied: 0, remaining: 1 });
    expect(down.error).toBeInstanceOf(Error);
    const r = recorder((op) => ({ opId: op.opId, result: 'APPLIED' }));
    await q.flush(r.send);
    expect(r.calls[0]![0]!.opId).toBe(id);
  });

  it('conflicts and rejections are reported and leave the queue; unanswered ops stay', async () => {
    const { store, key } = await fresh();
    const q = new OfflineQueue(store, key, NS);
    for (const e of ['a', 'b', 'c', 'd']) await q.enqueue({ kind: 'TASK_UPDATE', entityId: e, baseVersion: 1, data: { status: 'DONE' } });
    const r = recorder((op) => op.entityId === 'a' ? { opId: op.opId, result: 'APPLIED' }
      : op.entityId === 'b' ? { opId: op.opId, result: 'CONFLICT', server: { status: 'TODO', version: 4 } }
      : op.entityId === 'c' ? { opId: op.opId, result: 'REJECTED', problem: { status: 422 } } : undefined);
    const rep = await q.flush(r.send);
    expect(rep).toMatchObject({ applied: 1, remaining: 1, conflicts: [{ op: { entityId: 'b' }, server: { version: 4 } }], rejected: [{ op: { entityId: 'c' } }] });
    expect((await q.pending()).map((p) => p.op.entityId)).toEqual(['d']);
  });

  it('tampering, slot swapping and another member key are detected', async () => {
    const { store, key } = await fresh();
    const q = new OfflineQueue(store, key, NS);
    await q.enqueue({ kind: 'TASK_UPDATE', entityId: 'x', baseVersion: 1, data: { status: 'DONE' } });
    await q.enqueue({ kind: 'TASK_UPDATE', entityId: 'y', baseVersion: 1, data: { status: 'DONE' } });
    const [s1, s2] = (await store.keys(`q:${NS}:`)).filter((k) => /\d{12}$/.test(k)).sort();
    const v1 = store.data.get(s1!)!, v2 = store.data.get(s2!)!;
    store.data.set(s1!, v2); store.data.set(s2!, v1);
    await expect(q.pending()).rejects.toBeInstanceOf(QueueTamperedError);
    store.data.set(s1!, v1); store.data.set(s2!, v2);
    await expect(new OfflineQueue(store, await importAesKey(randomBytes(32)), NS).pending()).rejects.toBeInstanceOf(QueueTamperedError);
    expect(await q.size()).toBe(2);
  });

  it('httpTransport: 400 rejects the batch, 5xx / 401 keep it queued', async () => {
    const ops = [{ opId: 'o1', kind: 'TASK_UPDATE', entityId: 't', baseVersion: 1, clientAt: 'x', data: {} }] as SyncOp[];
    const mk = (status: number, body: unknown) => httpTransport({ baseUrl: 'https://api', deviceId: 'd', householdId: 'h', token: async () => 'tok',
      fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch });
    expect(await mk(400, { code: 'VALIDATION' })(ops)).toEqual([{ opId: 'o1', result: 'REJECTED', problem: { code: 'VALIDATION' } }]);
    await expect(mk(503, {})(ops)).rejects.toThrow(/503/);
    await expect(mk(401, {})(ops)).rejects.toThrow(/401/);
    expect(await mk(201, { results: [{ opId: 'o1', result: 'APPLIED' }] })(ops)).toEqual([{ opId: 'o1', result: 'APPLIED' }]);
  });
});
