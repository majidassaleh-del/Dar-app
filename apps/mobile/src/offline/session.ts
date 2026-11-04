/**
 * Wiring for the worker app: daily biometric unlock → encrypted queue → sync.
 * Not device-tested; the flow it composes is tested in packages/offline.
 *
 *   const s = await openOfflineSession({ ... });
 *   if (s.status === 'unlocked') await s.queue.enqueue({ kind: 'TASK_UPDATE', entityId, baseVersion, data: { status: 'DONE' } });
 *   else if (s.status === 'needs-fallback') → OTP sign-in screen, then openOfflineSession({ ..., fallbackKey })
 *
 * WebCrypto: React Native has no crypto.subtle. Install react-native-quick-crypto and call
 * `install()` at app start, before this module runs.
 */
import { OfflineQueue, UnlockService, decodeFallbackKey, httpTransport } from '@herp/offline';
import { SecureStoreVault } from './secure-store-vault';
import { asyncStorageKv } from './async-storage-kv';

export interface SessionConfig {
  apiBaseUrl: string; householdId: string; membershipId: string; deviceId: string;
  token: () => Promise<string>;
  /** Prompt text in the worker's language, e.g. t('offline.unlockPrompt'). */
  prompt: string;
  /** Present right after an OTP sign-in: base64url key from POST /v1/sync/offline-key. */
  fallbackKey?: string;
}

export async function openOfflineSession(cfg: SessionConfig) {
  const unlock = new UnlockService(asyncStorageKv, new SecureStoreVault(cfg.membershipId), cfg.membershipId);
  let r;
  if (cfg.fallbackKey) {
    r = (await unlock.isSetUp())
      ? await unlock.unlockWithFallback(decodeFallbackKey(cfg.fallbackKey))
      : { status: 'unlocked' as const, key: await unlock.setup(decodeFallbackKey(cfg.fallbackKey)), via: 'fallback' as const };
  } else {
    r = await unlock.unlock(cfg.prompt);
  }
  if (r.status !== 'unlocked') return r;
  const queue = new OfflineQueue(asyncStorageKv, r.key, cfg.membershipId);
  const send = httpTransport({ baseUrl: cfg.apiBaseUrl, deviceId: cfg.deviceId, householdId: cfg.householdId, token: cfg.token });
  return { status: 'unlocked' as const, via: r.via, queue, sync: () => queue.flush(send),
           signOut: async () => { await queue.clear(); await unlock.reset(); } };
}
