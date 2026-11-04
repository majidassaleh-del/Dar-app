/**
 * Key-encryption-key (KEK) port. The KEK never leaves the KMS; we only send
 * it 32-byte data keys to wrap/unwrap. `aad` binds a wrapped key to its
 * tenant + version so a wrapped DEK copied to another household is useless.
 */
export interface KmsProvider {
  readonly keyName: string;
  wrap(plaintextKey: Buffer, aad: string): Promise<Buffer>;
  unwrap(wrappedKey: Buffer, aad: string): Promise<Buffer>;
}
