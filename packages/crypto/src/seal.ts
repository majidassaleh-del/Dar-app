import type { FieldCipher } from './fields';
import { SENSITIVE_FIELDS, last4, type SensitiveField } from './identifiers';

const ctxFor = (field: SensitiveField, householdId: string) => {
  const f = SENSITIVE_FIELDS[field];
  return { householdId, table: f.table, column: f.ciphertext };
};

/**
 * Turn a plaintext API field into its DB columns (ciphertext, blind index, last-4), e.g.
 *   data: { ...rest, ...(await seal(cipher, 'identity_documents.number', householdId, body.number)) }
 */
export async function seal(cipher: FieldCipher, field: SensitiveField, householdId: string, plain: string | null | undefined) {
  const f = SENSITIVE_FIELDS[field];
  if (plain == null || plain === '') return {};
  const normalized = f.normalize(plain);
  const ctx = ctxFor(field, householdId);
  const out: Record<string, string> = { [f.ciphertext]: await cipher.encrypt(normalized, ctx) };
  if ('blindIndex' in f) out[f.blindIndex] = await cipher.blindIndex(normalized, ctx);
  if ('last4' in f) out[f.last4] = last4(normalized);
  return out;
}

export async function unseal(cipher: FieldCipher, field: SensitiveField, householdId: string, row: Record<string, unknown>): Promise<string | null> {
  const token = row[SENSITIVE_FIELDS[field].ciphertext];
  return typeof token === 'string' ? cipher.decrypt(token, ctxFor(field, householdId)) : null;
}

/** Blind-index value for a WHERE clause: findFirst({ where: { numberBlindIndex: await lookupIndex(...) } }). */
export async function lookupIndex(cipher: FieldCipher, field: SensitiveField, householdId: string, plain: string) {
  const f = SENSITIVE_FIELDS[field];
  if (!('blindIndex' in f)) throw new Error(`${field} has no blind index`);
  return cipher.blindIndex(f.normalize(plain), ctxFor(field, householdId));
}
