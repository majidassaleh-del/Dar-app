import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { TenantKeyring } from './keyring';

/**
 * Field-level encryption for Iqama / passport / national-ID numbers, IBANs
 * and other identifiers.
 *
 *   ciphertext  "v1.<keyVersion>.<iv>.<ct‖tag>"   (base64url parts)
 *   AAD         "<householdId>|<table>.<column>|v<keyVersion>"
 *
 * The AAD means a ciphertext pasted into another household's row, or into
 * a different column (IBAN → passport), fails authentication.
 * The blind index (HMAC-SHA256 with a separate per-tenant key) supports
 * exact-match search and duplicate detection without decrypting; it is
 * tenant-specific, so equal numbers in two households do not correlate.
 */
export interface FieldContext { householdId: string; table: string; column: string }

const b64u = (b: Buffer) => b.toString('base64url');
const aad = (c: FieldContext, v: number) => Buffer.from(`${c.householdId}|${c.table}.${c.column}|v${v}`);

export class FieldCipher {
  constructor(private readonly keyring: TenantKeyring) {}

  async encrypt(plaintext: string, ctx: FieldContext): Promise<string> {
    const { dek, version } = await this.keyring.get(ctx.householdId);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, iv).setAAD(aad(ctx, version));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
    return `v1.${version}.${b64u(iv)}.${b64u(ct)}`;
  }

  async decrypt(token: string, ctx: FieldContext): Promise<string> {
    const [fmt, ver, ivs, cts] = token.split('.');
    if (fmt !== 'v1' || !ver || !ivs || !cts) throw new Error('not a v1 field ciphertext');
    const version = Number(ver);
    const { dek } = await this.keyring.get(ctx.householdId, version); // old versions stay decryptable after rotation
    const raw = Buffer.from(cts, 'base64url');
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(ivs, 'base64url')).setAAD(aad(ctx, version));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
  }

  /** Re-encrypt under the household's current ACTIVE key (key-rotation worker). */
  async rotate(token: string, ctx: FieldContext): Promise<string> {
    return this.encrypt(await this.decrypt(token, ctx), ctx);
  }

  async blindIndex(value: string, ctx: FieldContext, normalize: (v: string) => string = (v) => v): Promise<string> {
    // Always the ACTIVE index key: on rotation, the worker recomputes indexes too.
    const { indexKey } = await this.keyring.get(ctx.householdId);
    return createHmac('sha256', indexKey).update(`${ctx.table}.${ctx.column}|${normalize(value)}`).digest('hex');
  }
}
