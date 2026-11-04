import { base64ToBytes, decodeTlv, encodeTlv, ZatcaQrError } from './tlv';

export interface ZatcaInvoiceQr {
  phase: 1 | 2;
  sellerName: string;
  vatNumber: string;
  /** Normalised to UTC ISO-8601. A timestamp without offset is read as KSA time (+03:00). */
  issuedAt: string;
  /** Decimal strings with two places, e.g. "115.00". */
  total: string;
  vat: string;
  invoiceHash?: string;
  signature?: Uint8Array;
  publicKey?: Uint8Array;
  stampSignature?: Uint8Array;
  /** Non-fatal findings, e.g. VAT not matching 15 %. */
  warnings: string[];
}

const text = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);

/** Saudi VAT registration number: 15 digits, first and last digit 3. */
export function isValidSaudiVatNumber(v: string): boolean {
  return /^3\d{13}3$/.test(v);
}

function toAmount(raw: string, field: string): string {
  const s = raw.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,})?$/.test(s)) throw new ZatcaQrError(`${field} is not a number: "${raw}"`, 'INVALID_FIELD');
  return toFixed2(s);
}

/** Round a non-negative decimal string to 2 places without floating point. */
export function toFixed2(s: string): string {
  const [int = '0', frac = ''] = s.split('.');
  const cents = BigInt(int) * 100n + BigInt((frac + '00').slice(0, 2)) + (Number(frac[2] ?? '0') >= 5 ? 1n : 0n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const toHalalas = (amount: string): bigint => {
  const [i = '0', f = ''] = amount.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
};

function toUtcIso(raw: string): string {
  let s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + '+03:00';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ZatcaQrError(`timestamp is not ISO-8601: "${raw}"`, 'INVALID_FIELD');
  return d.toISOString();
}

export function decodeZatcaQr(payload: string): ZatcaInvoiceQr {
  const fields = decodeTlv(base64ToBytes(payload));
  const byTag = new Map(fields.map((f) => [f.tag, f.value]));
  for (const t of [1, 2, 3, 4, 5]) {
    if (!byTag.has(t)) throw new ZatcaQrError(`mandatory tag ${t} missing`, 'MISSING_TAG');
  }
  let sellerName: string;
  try { sellerName = text(byTag.get(1)!).trim(); } catch { throw new ZatcaQrError('seller name is not UTF-8', 'INVALID_FIELD'); }
  const vatNumber = text(byTag.get(2)!).trim();
  const warnings: string[] = [];
  if (!isValidSaudiVatNumber(vatNumber)) warnings.push(`VAT number "${vatNumber}" is not a valid Saudi VAT number`);

  const total = toAmount(text(byTag.get(4)!), 'total');
  const vat = toAmount(text(byTag.get(5)!), 'vat');
  const T = toHalalas(total), V = toHalalas(vat);
  if (V > T) warnings.push('VAT exceeds invoice total');
  // Standard rate is 15 % of the net, i.e. 15/115 of the gross. Allow ±1 halala per line rounding (±2 overall).
  else if (V !== 0n) {
    const expected = (T * 15n + 57n) / 115n;
    const diff = V > expected ? V - expected : expected - V;
    if (diff > 2n) warnings.push(`VAT ${vat} is not 15% of total ${total} (expected ≈ ${Number(expected) / 100})`);
  }

  const result: ZatcaInvoiceQr = {
    phase: byTag.has(6) || byTag.has(7) ? 2 : 1,
    sellerName, vatNumber, issuedAt: toUtcIso(text(byTag.get(3)!)), total, vat, warnings,
  };
  if (byTag.has(6)) result.invoiceHash = text(byTag.get(6)!);
  if (byTag.has(7)) result.signature = byTag.get(7);
  if (byTag.has(8)) result.publicKey = byTag.get(8);
  if (byTag.has(9)) result.stampSignature = byTag.get(9);
  if (result.phase === 2 && !(result.invoiceHash && result.signature && result.publicKey)) {
    warnings.push('Phase 2 QR is missing hash, signature or public key');
  }
  return result;
}

/** Build a QR payload (used for test fixtures and for receipts the household itself issues). */
export function encodeZatcaQr(i: { sellerName: string; vatNumber: string; issuedAt: string; total: string; vat: string }): string {
  return Buffer.from(encodeTlv([
    { tag: 1, value: i.sellerName }, { tag: 2, value: i.vatNumber }, { tag: 3, value: i.issuedAt },
    { tag: 4, value: i.total }, { tag: 5, value: i.vat },
  ])).toString('base64');
}
