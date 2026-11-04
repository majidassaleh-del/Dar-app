import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, randomBytes, randomInt, verify as verifySig, type JsonWebKey } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ENV, type Env } from '../config/env';

export interface SessionClaims { sub: string; did: string; amr: string[]; auth_time: number }

/**
 * Secrets for onboarding and the daily unlock:
 *  - TOTP secrets encrypted at rest (AES-256-GCM, AUTH_TOTP_KEY);
 *  - OTP codes / unlock nonces stored only as HMACs (pepper derived from the same key);
 *  - device-session tokens (HS256, SESSION_SIGNING_SECRET), issued after a Face ID /
 *    Touch ID device signature or the authenticator fallback, valid until 04:00 Riyadh.
 * Keys are random per process outside production (sessions and enrolments then do not
 * survive a restart, which is fine for dev and tests).
 */
@Injectable()
export class AuthCryptoService {
  private readonly totpKey: Buffer;
  private readonly pepper: Buffer;
  private readonly sessionKey: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.totpKey = env.AUTH_TOTP_KEY ? Buffer.from(env.AUTH_TOTP_KEY, 'base64') : randomBytes(32);
    if (this.totpKey.length !== 32) throw new Error('AUTH_TOTP_KEY must be 32 bytes (base64)');
    this.pepper = createHmac('sha256', this.totpKey).update('herp-otp-pepper-v1').digest();
    this.sessionKey = new TextEncoder().encode(env.SESSION_SIGNING_SECRET ?? randomBytes(32).toString('hex'));
  }

  encryptSecret(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.totpKey, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `t1.${iv.toString('base64url')}.${Buffer.concat([ct, c.getAuthTag()]).toString('base64url')}`;
  }

  decryptSecret(sealed: string): string {
    const [v, iv, data] = sealed.split('.');
    if (v !== 't1' || !iv || !data) throw new Error('bad TOTP ciphertext');
    const buf = Buffer.from(data, 'base64url');
    const d = createDecipheriv('aes-256-gcm', this.totpKey, Buffer.from(iv, 'base64url'));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
  }

  /** 6-digit code, uniformly random. */
  newCode() { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }
  newNonce() { return randomBytes(32).toString('base64url'); }
  hash(challengeId: string, secret: string) { return createHmac('sha256', this.pepper).update(`${challengeId}\0${secret}`).digest('base64url'); }

  /** ECDSA P-256 / SHA-256 over the message; accepts raw (r‖s, WebCrypto) and DER (iOS / Android) signatures. */
  verifyDeviceSignature(jwk: JsonWebKey, message: string, signatureB64u: string): boolean {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
      const sig = Buffer.from(signatureB64u, 'base64url');
      return verifySig('sha256', Buffer.from(message), { key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig);
    } catch { return false; }
  }

  static unlockMessage(challengeId: string, nonce: string, userId: string) { return `herp-unlock-v1:${challengeId}:${nonce}:${userId}`; }

  /** Session lasts until the next 04:00 in Riyadh (at most 24 h): one unlock per day. */
  async issueSession(c: Omit<SessionClaims, 'auth_time'>, now = Date.now()) {
    const riyadh = new Date(now + 3 * 3_600_000);
    const next4 = Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), riyadh.getUTCDate(), 4) - 3 * 3_600_000;
    const exp = Math.floor((next4 > now ? next4 : next4 + 86_400_000) / 1000);
    const token = await new SignJWT({ typ: 'herp-session', did: c.did, amr: c.amr, auth_time: Math.floor(now / 1000) })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(c.sub).setIssuer('herp-api').setIssuedAt(Math.floor(now / 1000)).setExpirationTime(exp).sign(this.sessionKey);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async verifySession(token: string): Promise<SessionClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.sessionKey, { issuer: 'herp-api', algorithms: ['HS256'] });
      if (payload.typ !== 'herp-session' || typeof payload.sub !== 'string' || typeof payload.did !== 'string') return null;
      return { sub: payload.sub, did: payload.did, amr: (payload.amr as string[]) ?? [], auth_time: Number(payload.auth_time) };
    } catch { return null; }
  }
}
