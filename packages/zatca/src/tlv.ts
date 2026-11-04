/**
 * ZATCA (Fatoora) e-invoice QR code: Base64 of a TLV byte stream.
 *
 *   Phase 1 (generation, since Dec 2021)  tags 1–5
 *   Phase 2 (integration, simplified B2C) adds tags 6–9
 *
 *   1 seller name (UTF-8)          6 invoice hash (Base64 of SHA-256 of the XML, as text)
 *   2 seller VAT number            7 ECDSA signature
 *   3 timestamp (ISO 8601)         8 ECDSA public key
 *   4 invoice total incl. VAT      9 ZATCA's signature of the cryptographic stamp (simplified only)
 *   5 VAT total
 *
 * Length is a single byte in the specification. Some third-party POS
 * encoders emit BER long-form lengths (0x81 nn / 0x82 nn nn); we accept
 * those only as a fallback when the strict parse does not consume the input
 * exactly, because 0x81 is also a legal single-byte length (129).
 */

export interface TlvField {
  tag: number;
  value: Uint8Array;
}

export class ZatcaQrError extends Error {
  constructor(message: string, readonly code: 'NOT_BASE64' | 'MALFORMED_TLV' | 'MISSING_TAG' | 'INVALID_FIELD') {
    super(message);
    this.name = 'ZatcaQrError';
  }
}

function parse(bytes: Uint8Array, ber: boolean): TlvField[] | null {
  const out: TlvField[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 2 > bytes.length) return null;
    const tag = bytes[i++]!;
    let len = bytes[i++]!;
    if (ber && len > 0x80) {
      const n = len & 0x7f;
      if (n > 2 || i + n > bytes.length) return null;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | bytes[i++]!;
    }
    if (tag === 0 || i + len > bytes.length) return null;
    out.push({ tag, value: bytes.subarray(i, i + len) });
    i += len;
  }
  return out;
}

export function decodeTlv(bytes: Uint8Array): TlvField[] {
  const strict = parse(bytes, false);
  if (strict && strict.length) return strict;
  const ber = parse(bytes, true);
  if (ber && ber.length) return ber;
  throw new ZatcaQrError('QR payload is not a valid TLV stream', 'MALFORMED_TLV');
}

export function encodeTlv(fields: Array<{ tag: number; value: string | Uint8Array }>): Uint8Array {
  const parts: number[] = [];
  for (const { tag, value } of fields) {
    const v = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (v.length > 255) throw new RangeError(`tag ${tag}: value longer than 255 bytes`);
    parts.push(tag, v.length, ...v);
  }
  return Uint8Array.from(parts);
}

/** Accepts standard or URL-safe Base64, with stray whitespace from scanners. */
export function base64ToBytes(input: string): Uint8Array {
  const clean = input.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length < 8) {
    throw new ZatcaQrError('QR payload is not Base64', 'NOT_BASE64');
  }
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
