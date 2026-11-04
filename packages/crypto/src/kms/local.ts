import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KmsProvider } from './provider';

/**
 * Development / test KEK held in an env var (base64, 32 bytes).
 * Refuses to run in production so it cannot be deployed by accident.
 * Wrapped format: iv(12) ‖ tag(16) ‖ ciphertext.
 */
export class LocalKmsProvider implements KmsProvider {
  readonly keyName = 'local';
  readonly #kek: Buffer;

  constructor(masterKeyB64: string | undefined = process.env.HERP_LOCAL_KEK, env = process.env.NODE_ENV) {
    if (env === 'production') throw new Error('LocalKmsProvider must not be used in production; configure GcpKmsProvider');
    const k = Buffer.from(masterKeyB64 ?? '', 'base64');
    if (k.length !== 32) throw new Error('HERP_LOCAL_KEK must be 32 bytes, base64-encoded');
    this.#kek = k;
  }

  async wrap(key: Buffer, aad: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#kek, iv).setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(key), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer, aad: string): Promise<Buffer> {
    const d = createDecipheriv('aes-256-gcm', this.#kek, wrapped.subarray(0, 12)).setAAD(Buffer.from(aad));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}
