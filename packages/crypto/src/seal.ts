import type { FieldCipher } from './fields';
import { SENSITIVE_FIELDS, last4 } from './identifiers';

type Table = keyof typeof SENSITIVE_FIELDS;

/**
 * Turn an API payload into DB columns (and back). Used by the repository
 * layer before Prisma writes / after Prisma reads, e.g.
 *   data: { ...rest, ...(await seal(cipher, 'identity_documents', householdId, { number })) }
 */
export async function seal(cipher: FieldCipher, table: Table, householdId: string, plain: string | null | undefined) {
  const f = SENSITIVE_FIELDS[table];
  if (plain == null || plain === '') return {};
  const normalized = f.normalize(plain);
  const ctx = { householdId, table, column: f.ciphertext };
  const out: Record<string, string> = { [f.ciphertext]: await cipher.encrypt(normalized, ctx) };
  if ('blindIndex' in f) out[f.blindIndex] = await cipher.blindIndex(normalized, ctx);
  if ('last4' in f) out[f.last4] = last4(normalized);
  return out;
}

export async function unseal(cipher: FieldCipher, table: Table, householdId: string, row: Record<string, unknown>): Promise<string | null> {
  const f = SENSITIVE_FIELDS[table];
  const token = row[f.ciphertext];
  return typeof token === 'string' ? cipher.decrypt(token, { householdId, table, column: f.ciphertext }) : null;
}

/** Blind-index value to put in a WHERE clause: findFirst({ where: { numberBlindIndex: await lookupIndex(...) } }). */
export async function lookupIndex(cipher: FieldCipher, table: Table, householdId: string, plain: string) {
  const f = SENSITIVE_FIELDS[table];
  if (!('blindIndex' in f)) throw new Error(`${table} has no blind index`);
  return cipher.blindIndex(f.normalize(plain), { householdId, table, column: f.ciphertext });
}
