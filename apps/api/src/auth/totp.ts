import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits): the profile Microsoft
 * Authenticator, Google Authenticator and 1Password all accept from an
 * otpauth:// QR code.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20)); // 160-bit, as RFC 4226 recommends

export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(counter);
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (atMs: number, period = 30) => BigInt(Math.floor(atMs / 1000 / period));

/** Accepts the current step ±window (clock drift); returns the matching step, or null. Constant work per call. */
export function verifyTotp(secretB32: string, code: string, atMs = Date.now(), window = 1): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const now = totpStep(atMs);
  let match: bigint | null = null;
  for (let d = -window; d <= window; d++) {
    const step = now + BigInt(d);
    if (hotp(secret, step) === code && match === null) match = step;
  }
  return match;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'EFA Private Office') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
