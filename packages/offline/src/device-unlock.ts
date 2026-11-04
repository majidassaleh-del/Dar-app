import { b64u, subtleOf } from './envelope';
import { VaultCancelledError, type KeyVault } from './unlock';

/**
 * Daily unlock against the API (POST /v1/auth/unlock/challenge → /v1/auth/unlock).
 *
 * Enrolment (once, after onboarding): a P-256 key pair is generated on the
 * device; the private key (PKCS#8) goes into the biometric vault (Face ID /
 * Touch ID), the public JWK to POST /v1/auth/devices. Each morning the vault
 * releases the private key after one biometric prompt, the app signs the
 * server nonce, and receives a device-session token valid until 04:00 Riyadh.
 *
 * Note: the private key lives in the Keychain / Keystore behind biometrics, not
 * inside the Secure Enclave itself (Expo has no enclave-signing API); a native
 * module could move signing into the enclave without changing the server.
 */
export interface UnlockApi {
  challenge(deviceId: string): Promise<{ challengeId: string; nonce: string; message: string }>;
  unlock(body: { challengeId: string; nonce: string; signature: string }): Promise<{ token: string; expiresAt: string; deviceKeyId: string }>;
}

export class DeviceUnlockClient {
  constructor(private readonly vault: KeyVault, private readonly api: UnlockApi, private readonly deviceId: string, private readonly subtle?: SubtleCrypto) {}

  /** Creates the key pair, stores the private half behind biometrics; returns the public JWK to register. */
  async enrol(): Promise<{ kty: 'EC'; crv: 'P-256'; x: string; y: string }> {
    const s = subtleOf(this.subtle);
    const pair = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await s.exportKey('pkcs8', pair.privateKey));
    try { await this.vault.write(pkcs8); } finally { pkcs8.fill(0); }
    const jwk = await s.exportKey('jwk', pair.publicKey);
    return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
  }

  /** One biometric prompt → signed nonce → session. 'cancelled' leaves everything as it was; 'reenrol' means the key is gone. */
  async unlock(prompt: string): Promise<{ status: 'unlocked'; token: string; expiresAt: string } | { status: 'cancelled' } | { status: 'reenrol' }> {
    let pkcs8: Uint8Array | null;
    try { pkcs8 = await this.vault.read(prompt); } catch (e) {
      if (e instanceof VaultCancelledError) return { status: 'cancelled' };
      return { status: 'reenrol' }; // biometrics changed: sign in with SMS + authenticator (POST /v1/auth/unlock/totp), then enrol again
    }
    if (!pkcs8) return { status: 'reenrol' };
    const s = subtleOf(this.subtle);
    try {
      const key = await s.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const ch = await this.api.challenge(this.deviceId);
      const sig = new Uint8Array(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(ch.message) as BufferSource));
      const r = await this.api.unlock({ challengeId: ch.challengeId, nonce: ch.nonce, signature: b64u.encode(sig) });
      return { status: 'unlocked', token: r.token, expiresAt: r.expiresAt };
    } finally { pkcs8.fill(0); }
  }
}

/** UnlockApi over fetch, authenticated with the identity provider's token. */
export function httpUnlockApi(cfg: { baseUrl: string; idToken: () => Promise<string>; fetch?: typeof fetch }): UnlockApi {
  const call = async <T>(path: string, body: object): Promise<T> => {
    const r = await (cfg.fetch ?? fetch)(`${cfg.baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await cfg.idToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  return { challenge: (deviceId) => call('/v1/auth/unlock/challenge', { deviceId }), unlock: (b) => call('/v1/auth/unlock', b) };
}
