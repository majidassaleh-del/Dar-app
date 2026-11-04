/** Normalisers and validators for the identifiers we encrypt. */

export const normalizeDigitsOnly = (v: string) =>
  v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
export const normalizeAlnumUpper = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const last4 = (v: string) => v.slice(-4);

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Saudi national ID (starts 1) or Iqama (starts 2): 10 digits, Luhn check digit. */
export function isValidSaudiId(v: string): boolean {
  const d = normalizeDigitsOnly(v);
  return /^[12]\d{9}$/.test(d) && luhn(d);
}

/** ISO 13616 IBAN, mod-97. Saudi IBANs are 24 chars: SAkk bb aaaaaaaaaaaaaaaaaa. */
export function isValidIban(v: string): boolean {
  const s = normalizeAlnumUpper(v);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  if (s.startsWith('SA') && s.length !== 24) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

/**
 * Which columns hold which secret (mirrors prisma/schema.prisma), keyed by
 * "<table>.<apiField>". The DB never stores the plaintext field.
 */
export const SENSITIVE_FIELDS = {
  'identity_documents.number':        { table: 'identity_documents', ciphertext: 'numberCiphertext', blindIndex: 'numberBlindIndex', last4: 'numberLast4', normalize: normalizeAlnumUpper },
  'financial_accounts.iban':          { table: 'financial_accounts', ciphertext: 'ibanCiphertext', blindIndex: 'ibanBlindIndex', last4: 'ibanLast4', normalize: normalizeAlnumUpper },
  'leases.counterpartyIdNo':          { table: 'leases', ciphertext: 'counterpartyIdCiphertext', normalize: normalizeDigitsOnly },
  'staff_profiles.borderNumber':      { table: 'staff_profiles', ciphertext: 'borderNumberCiphertext', normalize: normalizeDigitsOnly },
  'staff_profiles.payoutIban':        { table: 'staff_profiles', ciphertext: 'payoutIbanCiphertext', blindIndex: 'payoutIbanBlindIndex', last4: 'payoutIbanLast4', normalize: normalizeAlnumUpper },
} as const;

export type SensitiveField = keyof typeof SENSITIVE_FIELDS;
