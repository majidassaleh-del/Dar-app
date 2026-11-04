import type { KmsProvider } from './provider';
import { crc32c } from './crc32c';

/**
 * Minimal structural type of @google-cloud/kms KeyManagementServiceClient,
 * so this package does not hard-depend on the SDK (it is an optional peer).
 * Usage:
 *   import { KeyManagementServiceClient } from '@google-cloud/kms';
 *   new GcpKmsProvider(new KeyManagementServiceClient(),
 *     'projects/p/locations/me-central2/keyRings/herp/cryptoKeys/household-dek');
 */
export interface GcpKmsClientLike {
  encrypt(req: {
    name: string; plaintext: Buffer; additionalAuthenticatedData: Buffer;
    plaintextCrc32c: { value: number }; additionalAuthenticatedDataCrc32c: { value: number };
  }): Promise<[{ ciphertext?: Uint8Array | string | null; ciphertextCrc32c?: { value?: number | string | null } | null;
                 verifiedPlaintextCrc32c?: boolean | null; verifiedAdditionalAuthenticatedDataCrc32c?: boolean | null; name?: string | null }, ...unknown[]]>;
  decrypt(req: {
    name: string; ciphertext: Buffer; additionalAuthenticatedData: Buffer;
    ciphertextCrc32c: { value: number }; additionalAuthenticatedDataCrc32c: { value: number };
  }): Promise<[{ plaintext?: Uint8Array | string | null; plaintextCrc32c?: { value?: number | string | null } | null }, ...unknown[]]>;
}

export class GcpKmsProvider implements KmsProvider {
  constructor(private readonly client: GcpKmsClientLike, readonly keyName: string) {}

  async wrap(key: Buffer, aad: string): Promise<Buffer> {
    const a = Buffer.from(aad);
    const [res] = await this.client.encrypt({
      name: this.keyName, plaintext: key, additionalAuthenticatedData: a,
      plaintextCrc32c: { value: crc32c(key) }, additionalAuthenticatedDataCrc32c: { value: crc32c(a) },
    });
    if (!res.verifiedPlaintextCrc32c || !res.verifiedAdditionalAuthenticatedDataCrc32c) {
      throw new Error('Cloud KMS: request corrupted in transit (CRC32C not verified)');
    }
    const ct = Buffer.from(res.ciphertext as Uint8Array);
    if (Number(res.ciphertextCrc32c?.value) !== crc32c(ct)) throw new Error('Cloud KMS: response corrupted in transit');
    return ct;
  }

  async unwrap(wrapped: Buffer, aad: string): Promise<Buffer> {
    const a = Buffer.from(aad);
    const [res] = await this.client.decrypt({
      name: this.keyName, ciphertext: wrapped, additionalAuthenticatedData: a,
      ciphertextCrc32c: { value: crc32c(wrapped) }, additionalAuthenticatedDataCrc32c: { value: crc32c(a) },
    });
    const pt = Buffer.from(res.plaintext as Uint8Array);
    if (Number(res.plaintextCrc32c?.value) !== crc32c(pt)) throw new Error('Cloud KMS: response corrupted in transit');
    return pt;
  }
}
