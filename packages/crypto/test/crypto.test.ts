import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTenantKeys, crc32c, FieldCipher, GcpKmsProvider, isValidIban, isValidSaudiId, LocalKmsProvider,
  lookupIndex, seal, TenantKeyring, unseal, type GcpKmsClientLike, type TenantKeyRecord,
} from '../src';

const H1 = '11111111-1111-1111-1111-111111111111';
const H2 = '22222222-2222-2222-2222-222222222222';
const kms = new LocalKmsProvider(randomBytes(32).toString('base64'), 'test');

let rows: TenantKeyRecord[];
let keyring: TenantKeyring;
let cipher: FieldCipher;
beforeEach(async () => {
  rows = [await createTenantKeys(kms, H1, 1), await createTenantKeys(kms, H2, 1)];
  keyring = new TenantKeyring(kms, async (h) => rows.filter((r) => r.householdId === h));
  cipher = new FieldCipher(keyring);
});
const ctx = (householdId = H1, column = 'numberCiphertext') => ({ householdId, table: 'identity_documents', column });

describe('envelope encryption', () => {
  it('round-trips and never repeats ciphertext', async () => {
    const a = await cipher.encrypt('2123456789', ctx());
    const b = await cipher.encrypt('2123456789', ctx());
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.1\./);
    expect(await cipher.decrypt(a, ctx())).toBe('2123456789');
  });

  it('a ciphertext moved to another household fails', async () => {
    const t = await cipher.encrypt('2123456789', ctx(H1));
    await expect(cipher.decrypt(t, ctx(H2))).rejects.toThrow();
  });

  it('a ciphertext moved to another column fails (AAD)', async () => {
    const t = await cipher.encrypt('SA0380000000608010167519', ctx(H1, 'ibanCiphertext'));
    await expect(cipher.decrypt(t, ctx(H1, 'numberCiphertext'))).rejects.toThrow();
  });

  it('tampering is detected', async () => {
    const t = await cipher.encrypt('A1234567', ctx());
    const parts = t.split('.'); const ct = Buffer.from(parts[3]!, 'base64url'); ct[0]! ^= 1;
    await expect(cipher.decrypt([...parts.slice(0, 3), ct.toString('base64url')].join('.'), ctx())).rejects.toThrow();
  });

  it('wrapped DEK is bound to its tenant', async () => {
    rows = [{ ...rows[0]!, householdId: H2 }];  // H1's wrapped key relabelled as H2's
    await expect(new TenantKeyring(kms, async () => rows).get(H2)).rejects.toThrow();
  });

  it('rotation: old ciphertexts still decrypt, new ones use the new version', async () => {
    const old = await cipher.encrypt('2123456789', ctx());
    rows[0]!.status = 'DECRYPT_ONLY';
    rows.push(await createTenantKeys(kms, H1, 2));
    const rotated = await cipher.rotate(old, ctx());
    expect(rotated).toMatch(/^v1\.2\./);
    expect(await cipher.decrypt(old, ctx())).toBe('2123456789');
    expect(await cipher.decrypt(rotated, ctx())).toBe('2123456789');
  });

  it('crypto-shredding: destroyed key ⇒ data unrecoverable', async () => {
    const t = await cipher.encrypt('2123456789', ctx());
    rows[0]!.status = 'DESTROYED';
    keyring.clear(H1);
    await expect(cipher.decrypt(t, ctx())).rejects.toThrow(/destroyed or missing/);
  });

  it('caches unwrapped keys (one KMS call per tenant per TTL)', async () => {
    const spy = vi.spyOn(kms, 'unwrap');
    for (let i = 0; i < 20; i++) await cipher.encrypt(`P${i}`, ctx());
    expect(spy).toHaveBeenCalledTimes(2); // dek + index key, once
  });
});

describe('blind index', () => {
  it('is deterministic within a tenant and normalised', async () => {
    const a = await lookupIndex(cipher, 'identity_documents', H1, 'a12 345-67');
    const b = await lookupIndex(cipher, 'identity_documents', H1, 'A1234567');
    expect(a).toBe(b);
  });
  it('differs across tenants (no cross-household correlation)', async () => {
    expect(await lookupIndex(cipher, 'identity_documents', H1, 'A1234567'))
      .not.toBe(await lookupIndex(cipher, 'identity_documents', H2, 'A1234567'));
  });
});

describe('seal / unseal', () => {
  it('produces exactly the DB columns, then reverses', async () => {
    const cols = await seal(cipher, 'identity_documents', H1, '2123 456 789');
    expect(Object.keys(cols).sort()).toEqual(['numberBlindIndex', 'numberCiphertext', 'numberLast4']);
    expect(cols.numberLast4).toBe('6789');
    expect(JSON.stringify(cols)).not.toContain('2123456789');
    expect(await unseal(cipher, 'identity_documents', H1, cols)).toBe('2123456789');
  });
});

describe('validators', () => {
  it('Saudi ID / Iqama (Luhn)', () => {
    expect(isValidSaudiId('1000000008')).toBe(true);
    expect(isValidSaudiId('2000000006')).toBe(true);
    expect(isValidSaudiId('2000000007')).toBe(false);
    expect(isValidSaudiId('3000000008')).toBe(false);
  });
  it('IBAN mod-97', () => {
    expect(isValidIban('SA03 8000 0000 6080 1016 7519')).toBe(true);
    expect(isValidIban('SA03 8000 0000 6080 1016 7518')).toBe(false);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });
});

describe('KMS providers', () => {
  it('LocalKmsProvider refuses to run in production', () => {
    expect(() => new LocalKmsProvider(randomBytes(32).toString('base64'), 'production')).toThrow(/production/);
  });

  it('crc32c matches the standard check value', () => {
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
  });

  // Fake Cloud KMS that behaves like the real API (including CRC fields).
  const fakeGcp = (corrupt = false): GcpKmsClientLike => {
    const store = new LocalKmsProvider(randomBytes(32).toString('base64'), 'test');
    return {
      async encrypt(req) {
        const ct = await store.wrap(req.plaintext, req.additionalAuthenticatedData.toString());
        return [{ ciphertext: ct, ciphertextCrc32c: { value: crc32c(ct) + (corrupt ? 1 : 0) },
          verifiedPlaintextCrc32c: req.plaintextCrc32c.value === crc32c(req.plaintext),
          verifiedAdditionalAuthenticatedDataCrc32c: true }];
      },
      async decrypt(req) {
        const pt = await store.unwrap(req.ciphertext, req.additionalAuthenticatedData.toString());
        return [{ plaintext: pt, plaintextCrc32c: { value: crc32c(pt) } }];
      },
    };
  };

  it('GcpKmsProvider wraps/unwraps with integrity checks', async () => {
    const gcp = new GcpKmsProvider(fakeGcp(), 'projects/p/locations/me-central2/keyRings/herp/cryptoKeys/household-dek');
    const key = randomBytes(32);
    expect((await gcp.unwrap(await gcp.wrap(key, 'aad'), 'aad')).equals(key)).toBe(true);
  });

  it('GcpKmsProvider rejects a corrupted response', async () => {
    const gcp = new GcpKmsProvider(fakeGcp(true), 'k');
    await expect(gcp.wrap(randomBytes(32), 'aad')).rejects.toThrow(/corrupted/);
  });
});
