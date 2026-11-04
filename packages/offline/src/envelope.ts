/**
 * AES-256-GCM envelope over WebCrypto: "o1.<iv>.<ciphertext+tag>" (base64url).
 * The AAD binds a record to its slot (member and op id), so ciphertext moved
 * between slots or members fails to open.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  encode(b: Uint8Array): string {
    let s = ''; for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(t, (c) => c.charCodeAt(0));
  },
};

export class EnvelopeError extends Error { constructor(msg = 'cannot open: wrong key, wrong slot or tampered') { super(msg); this.name = 'EnvelopeError'; } }

export function subtleOf(subtle?: SubtleCrypto): SubtleCrypto {
  const s = subtle ?? (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!s) throw new Error('WebCrypto SubtleCrypto is required (on React Native install a polyfill such as react-native-quick-crypto)');
  return s;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b;
}

export function importAesKey(raw: Uint8Array, subtle?: SubtleCrypto): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('AES-256 key must be 32 bytes');
  return subtleOf(subtle).importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealBytes(key: CryptoKey, plain: Uint8Array, aad: string, subtle?: SubtleCrypto): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtleOf(subtle).encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, key, plain as BufferSource));
  return `o1.${b64u.encode(iv)}.${b64u.encode(ct)}`;
}

export async function openBytes(key: CryptoKey, sealed: string, aad: string, subtle?: SubtleCrypto): Promise<Uint8Array> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'o1' || !iv || !ct) throw new EnvelopeError('not an o1 envelope');
  try {
    return new Uint8Array(await subtleOf(subtle).decrypt({ name: 'AES-GCM', iv: b64u.decode(iv) as BufferSource, additionalData: enc.encode(aad) }, key, b64u.decode(ct) as BufferSource));
  } catch { throw new EnvelopeError(); }
}

export const sealJson = (key: CryptoKey, value: unknown, aad: string, subtle?: SubtleCrypto) => sealBytes(key, enc.encode(JSON.stringify(value)), aad, subtle);
export const openJson = async <T>(key: CryptoKey, sealed: string, aad: string, subtle?: SubtleCrypto) => JSON.parse(dec.decode(await openBytes(key, sealed, aad, subtle))) as T;
