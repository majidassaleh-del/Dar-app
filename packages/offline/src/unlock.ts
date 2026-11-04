import { b64u, EnvelopeError, importAesKey, openBytes, randomBytes, sealBytes } from './envelope';
import type { KeyValueStore } from './kv';

/**
 * Hardware-backed secret slot gated by the platform's biometric prompt
 * (iOS Keychain with Face ID / Touch ID, Android Keystore + BiometricPrompt).
 * Implementations: apps/mobile/src/offline/secure-store-vault.ts (Expo).
 */
export interface KeyVault {
  /** Biometrics present and enrolled on this device. */
  isAvailable(): Promise<boolean>;
  /** Shows the biometric prompt. null = nothing stored. */
  read(prompt: string): Promise<Uint8Array | null>;
  write(secret: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}
/** The user dismissed the prompt or failed it: try again later, nothing is lost. */
export class VaultCancelledError extends Error { constructor() { super('biometric prompt cancelled'); this.name = 'VaultCancelledError'; } }
/** The OS invalidated the item (biometrics re-enrolled, passcode removed): fall back to OTP. */
export class VaultInvalidatedError extends Error { constructor(cause?: unknown) { super('biometric key invalidated', { cause }); this.name = 'VaultInvalidatedError'; } }

export type UnlockResult =
  | { status: 'unlocked'; key: CryptoKey; via: 'biometric' | 'fallback' }
  | { status: 'cancelled' }
  | { status: 'needs-fallback'; reason: 'no-biometrics' | 'not-enrolled' | 'invalidated' }
  | { status: 'not-set-up' };

const K = (ns: string) => ({ wrapped: `offline:${ns}:dek.fallback`, check: `offline:${ns}:dek.check` });
const CHECK = new TextEncoder().encode('herp-offline-key-check');

/**
 * Daily unlock for the offline queue.
 *
 * A random 256-bit data key (DEK) encrypts the queue. It is kept twice:
 *  - in the biometric vault, for the everyday Face ID / Touch ID unlock, which works offline;
 *  - wrapped (AES-GCM) under a per-device fallback key that the server hands out
 *    only right after an OTP sign-in (POST /v1/sync/offline-key).
 * If biometrics are re-enrolled, the OS destroys the vault item. The worker then
 * signs in with OTP once, the DEK is unwrapped, and the vault is re-enrolled. Queued
 * offline work survives. Neither copy is stored in plain text on the device.
 */
export class UnlockService {
  private readonly k: ReturnType<typeof K>;
  constructor(private readonly store: KeyValueStore, private readonly vault: KeyVault, namespace: string, private readonly subtle?: SubtleCrypto) {
    this.k = K(namespace);
  }

  async isSetUp() { return (await this.store.get(this.k.wrapped)) !== null; }

  /** First run (just after OTP sign-in): create the DEK, wrap it, enrol biometrics when available. */
  async setup(fallbackKey: Uint8Array): Promise<CryptoKey> {
    const dek = randomBytes(32);
    try {
      const wrap = await importAesKey(fallbackKey, this.subtle);
      const key = await importAesKey(dek, this.subtle);
      await this.store.set(this.k.wrapped, await sealBytes(wrap, dek, this.k.wrapped, this.subtle));
      await this.store.set(this.k.check, await sealBytes(key, CHECK, this.k.check, this.subtle));
      if (await this.vault.isAvailable()) await this.vault.write(dek);
      return key;
    } finally { dek.fill(0); }
  }

  /** Everyday unlock: one biometric prompt, no network. */
  async unlock(prompt: string): Promise<UnlockResult> {
    if (!(await this.isSetUp())) return { status: 'not-set-up' };
    if (!(await this.vault.isAvailable())) return { status: 'needs-fallback', reason: 'no-biometrics' };
    let raw: Uint8Array | null;
    try { raw = await this.vault.read(prompt); } catch (e) {
      if (e instanceof VaultCancelledError) return { status: 'cancelled' };
      await this.vault.remove().catch(() => undefined);
      return { status: 'needs-fallback', reason: 'invalidated' };
    }
    if (!raw) return { status: 'needs-fallback', reason: 'not-enrolled' };
    try {
      const key = await this.verified(raw);
      return key ? { status: 'unlocked', key, via: 'biometric' } : (await this.vault.remove(), { status: 'needs-fallback', reason: 'invalidated' });
    } finally { raw.fill(0); }
  }

  /** After an OTP sign-in: unwrap with the server-issued key and re-enrol biometrics. */
  async unlockWithFallback(fallbackKey: Uint8Array): Promise<UnlockResult & { status: 'unlocked' }> {
    const sealed = await this.store.get(this.k.wrapped);
    if (!sealed) throw new Error('offline storage is not set up');
    const dek = await openBytes(await importAesKey(fallbackKey, this.subtle), sealed, this.k.wrapped, this.subtle);
    try {
      const key = await this.verified(dek);
      if (!key) throw new EnvelopeError('fallback key does not match this device');
      if (await this.vault.isAvailable()) await this.vault.write(dek);
      return { status: 'unlocked', key, via: 'fallback' };
    } finally { dek.fill(0); }
  }

  /** Sign-out / device hand-over: forget both copies (the caller wipes the queue). */
  async reset() {
    await this.vault.remove().catch(() => undefined);
    await this.store.delete(this.k.wrapped);
    await this.store.delete(this.k.check);
  }

  private async verified(raw: Uint8Array): Promise<CryptoKey | null> {
    if (raw.length !== 32) return null;
    const key = await importAesKey(raw, this.subtle);
    const check = await this.store.get(this.k.check);
    if (!check) return null;
    try { await openBytes(key, check, this.k.check, this.subtle); return key; } catch { return null; }
  }
}

/** Server fallback keys arrive base64url-encoded. */
export const decodeFallbackKey = (s: string) => b64u.decode(s);
