import { describe, expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { DeviceUnlockClient, VaultCancelledError, VaultInvalidatedError, type KeyVault, type UnlockApi } from '../src';

class FakeVault implements KeyVault {
  secret: Uint8Array | null = null; mode: 'ok' | 'cancel' | 'invalidated' = 'ok';
  async isAvailable() { return true; }
  async read() { if (this.mode === 'cancel') throw new VaultCancelledError(); if (this.mode === 'invalidated') throw new VaultInvalidatedError(); return this.secret && new Uint8Array(this.secret); }
  async write(s: Uint8Array) { this.secret = new Uint8Array(s); }
  async remove() { this.secret = null; }
}

/** Plays the server: issues a nonce and verifies the signature exactly as the API does (node:crypto, P1363 for 64-byte sigs). */
function fakeServer(jwk: () => object) {
  const issued = new Map<string, string>();
  const api: UnlockApi = {
    async challenge() { const id = crypto.randomUUID(); const nonce = 'n'.repeat(43); const message = `herp-unlock-v1:${id}:${nonce}:user-1`; issued.set(id, message); return { challengeId: id, nonce, message }; },
    async unlock(b) {
      const sig = Buffer.from(b.signature, 'base64url');
      const ok = verify('sha256', Buffer.from(issued.get(b.challengeId)!), { key: createPublicKey({ key: jwk() as never, format: 'jwk' }), dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig);
      if (!ok) throw new Error('401');
      return { token: 'session-token', expiresAt: '2026-11-05T01:00:00.000Z', deviceKeyId: 'k1' };
    },
  };
  return api;
}

describe('DeviceUnlockClient', () => {
  it('enrol stores only the private key behind biometrics; unlock signs a nonce the server accepts', async () => {
    const vault = new FakeVault(); let pub: object = {};
    const client = new DeviceUnlockClient(vault, fakeServer(() => pub), 'iphone-1');
    pub = await client.enrol();
    expect(pub).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(vault.secret!.length).toBeGreaterThan(100); // PKCS#8
    expect(await client.unlock('Unlock')).toEqual({ status: 'unlocked', token: 'session-token', expiresAt: '2026-11-05T01:00:00.000Z' });
  });

  it('cancel keeps state; invalidated or missing key asks to re-enrol; a foreign key is rejected by the server', async () => {
    const vault = new FakeVault(); let pub: object = {};
    const client = new DeviceUnlockClient(vault, fakeServer(() => pub), 'iphone-1');
    pub = await client.enrol();
    vault.mode = 'cancel'; expect(await client.unlock('p')).toEqual({ status: 'cancelled' });
    vault.mode = 'invalidated'; expect(await client.unlock('p')).toEqual({ status: 'reenrol' });
    vault.mode = 'ok'; vault.secret = null; expect(await client.unlock('p')).toEqual({ status: 'reenrol' });
    const other = new DeviceUnlockClient(new FakeVault(), fakeServer(() => pub), 'iphone-1');
    await other.enrol();
    await expect(other.unlock('p')).rejects.toThrow('401');
  });
});
