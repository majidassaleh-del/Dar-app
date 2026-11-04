import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import { createPublicKey } from 'node:crypto';
import { PrismaService, type Tx } from '../db/prisma.service';
import { ZodBody } from '../common/zod.pipe';
import { AuthFlow, Ctx, NoHousehold } from '../common/decorators';
import type { RequestContext } from '../tenancy/request-context';
import { AuthCryptoService } from './auth-crypto.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { OnboardingGuard } from './onboarding.guard';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';

const Phone = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +9665XXXXXXXX') }).strict();
const Email = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
const Verify = z.object({ challengeId: z.guid(), code: z.string().regex(/^\d{6}$/) }).strict();
const Totp = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const P256 = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(40).max(50), y: z.string().min(40).max(50) }).passthrough();
const RegisterDevice = z.object({ deviceId: z.string().min(8).max(128), publicKeyJwk: P256, label: z.string().max(80).optional(), totpCode: z.string().regex(/^\d{6}$/) }).strict();
const UnlockChallenge = z.object({ deviceId: z.string().min(8).max(128) }).strict();
const Unlock = z.object({ challengeId: z.guid(), nonce: z.string().min(40).max(64), signature: z.string().min(80).max(200) }).strict();
const OTP_TTL_MS = 5 * 60_000;
const FRESH_AUTH_S = 600;

const mask = (s: string | null | undefined, keep = 3) => (s ? `${'•'.repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}` : null);

class TooManyRequests extends HttpException { constructor(m: string) { super(m, HttpStatus.TOO_MANY_REQUESTS); } }

/**
 * First-time onboarding (phone SMS OTP → email OTP → authenticator app), then the
 * daily unlock: the app signs a server nonce with a device-bound key released by
 * Face ID / Touch ID and receives a device-session token valid until 04:00 Riyadh.
 * If biometrics are unavailable, an authenticator code (after a fresh sign-in)
 * issues the same session.
 */
@Controller('auth')
@NoHousehold()
@AuthFlow()
export class AuthController {
  constructor(private readonly db: PrismaService, private readonly crypto: AuthCryptoService, private readonly otp: OtpDeliveryService,
              private readonly onboardingGuard: OnboardingGuard) {}

  @Get('onboarding')
  status(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => this.state(tx, ctx.userId));
  }

  @Post('onboarding/phone')
  startPhone(@Ctx() ctx: RequestContext, @Body(new ZodBody(Phone)) b: z.infer<typeof Phone>) {
    return this.challenge(ctx, 'PHONE_OTP', b.phone, (code) => ({ channel: 'sms', to: b.phone,
      text: `${code} رمز التحقق لمكتب EFA / EFA Private Office verification code. لا تشاركه / Do not share it.` }));
  }

  @Post('onboarding/phone/verify')
  verifyPhone(@Ctx() ctx: RequestContext, @Body(new ZodBody(Verify)) b: z.infer<typeof Verify>) { return this.consume(ctx, b, 'PHONE_OTP'); }

  @Post('onboarding/email')
  startEmail(@Ctx() ctx: RequestContext, @Body(new ZodBody(Email)) b: z.infer<typeof Email>) {
    return this.challenge(ctx, 'EMAIL_OTP', b.email, (code) => ({ channel: 'email', to: b.email, subject: 'EFA Private Office — verification code',
      text: `Your verification code is ${code}. It expires in 5 minutes.\nرمز التحقق الخاص بك هو ${code}، صالح لمدة 5 دقائق.` }));
  }

  @Post('onboarding/email/verify')
  verifyEmail(@Ctx() ctx: RequestContext, @Body(new ZodBody(Verify)) b: z.infer<typeof Verify>) { return this.consume(ctx, b, 'EMAIL_OTP'); }

  /** Start (or restart, until confirmed) authenticator enrolment: returns the otpauth URI for the QR code. */
  @Post('onboarding/totp')
  startTotp(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => {
      const f = await tx.userAuthFactor.findFirst({ where: { userId: ctx.userId } });
      if (!f?.phoneVerifiedAt || !f.emailVerifiedAt) throw new ForbiddenException('verify your phone and email first');
      const secret = newTotpSecret();
      await tx.$executeRaw`SELECT app.set_totp_secret(${this.crypto.encryptSecret(secret)})`;
      return { otpauthUri: otpauthUri(secret, f.email ?? f.phone ?? ctx.userId), secret, issuer: 'EFA Private Office', digits: 6, period: 30, algorithm: 'SHA1' };
    });
  }

  @Post('onboarding/totp/verify')
  async confirmTotp(@Ctx() ctx: RequestContext, @Body(new ZodBody(Totp)) b: z.infer<typeof Totp>) {
    await this.totp(ctx, b.code);
    this.onboardingGuard.forget(ctx.userId);
    return this.db.withRls(ctx, (tx) => this.state(tx, ctx.userId));
  }

  /** Register this phone's biometric-protected key. Needs onboarding, a fresh sign-in and an authenticator code. */
  @Post('devices')
  async registerDevice(@Ctx() ctx: RequestContext, @Body(new ZodBody(RegisterDevice)) b: z.infer<typeof RegisterDevice>) {
    this.requireFresh(ctx);
    const [on] = await this.db.withRls(ctx, (tx) => tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.user_onboarded(${ctx.userId}::uuid) AS ok`);
    if (!on?.ok) throw new ForbiddenException('complete onboarding first');
    await this.totp(ctx, b.totpCode);
    return this.db.withRls(ctx, async (tx) => {
      try {
        const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.publicKeyJwk.x, y: b.publicKeyJwk.y }, format: 'jwk' });
        if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('curve');
      } catch { throw new BadRequestException('publicKeyJwk is not a valid P-256 public key'); }
      const existing = await tx.deviceKey.findFirst({ where: { userId: ctx.userId, deviceId: b.deviceId } });
      if (existing && !existing.revokedAt) throw new BadRequestException('this device is already registered; revoke it first to re-enrol');
      if (existing) await tx.deviceKey.deleteMany({ where: { id: existing.id } }).catch(() => undefined);
      const k = await tx.deviceKey.create({ data: { userId: ctx.userId, deviceId: existing ? `${b.deviceId}#${Date.now()}` : b.deviceId, label: b.label,
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: b.publicKeyJwk.x, y: b.publicKeyJwk.y } } });
      return { id: k.id, deviceId: k.deviceId, label: k.label, createdAt: k.createdAt };
    });
  }

  @Get('devices')
  devices(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({ data: (await tx.deviceKey.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' } }))
      .map((k) => ({ id: k.id, deviceId: k.deviceId, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, current: ctx.session?.deviceKeyId === k.id })) }));
  }

  @Delete('devices/:id')
  revoke(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const { count } = await tx.deviceKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (!count) throw new NotFoundException('device not found');
      this.onboardingGuard.forget(ctx.userId, id);
      return { revoked: true };
    });
  }

  /** Daily unlock, step 1: a nonce for this device. */
  @Post('unlock/challenge')
  unlockChallenge(@Ctx() ctx: RequestContext, @Body(new ZodBody(UnlockChallenge)) b: z.infer<typeof UnlockChallenge>) {
    return this.db.withRls(ctx, async (tx) => {
      const k = await tx.deviceKey.findFirst({ where: { userId: ctx.userId, deviceId: b.deviceId, revokedAt: null } });
      if (!k) throw new NotFoundException('this device is not registered (or was revoked): sign in and register it again');
      const id = randomUUID(), nonce = this.crypto.newNonce();
      await tx.authChallenge.create({ data: { id, userId: ctx.userId, kind: 'DEVICE_UNLOCK', target: k.id, codeHash: this.crypto.hash(id, nonce), expiresAt: new Date(Date.now() + 2 * 60_000) } });
      return { challengeId: id, nonce, message: AuthCryptoService.unlockMessage(id, nonce, ctx.userId), expiresAt: new Date(Date.now() + 2 * 60_000).toISOString() };
    });
  }

  /** Daily unlock, step 2: the device's signature over the message (key released by Face ID / Touch ID). */
  @Post('unlock')
  async unlock(@Ctx() ctx: RequestContext, @Body(new ZodBody(Unlock)) b: z.infer<typeof Unlock>) {
    // The attempt is recorded (committed) before any refusal is returned.
    const out = await this.db.withRls(ctx, async (tx) => {
      const c = await tx.authChallenge.findFirst({ where: { id: b.challengeId, kind: 'DEVICE_UNLOCK' } });
      if (!c) return { error: 'unknown challenge' };
      const k = await tx.deviceKey.findFirst({ where: { id: c.target!, revokedAt: null } });
      if (!k) return { error: 'this device was revoked' };
      const signed = this.crypto.verifyDeviceSignature(k.publicKeyJwk as JsonWebKey, AuthCryptoService.unlockMessage(c.id, b.nonce, ctx.userId), b.signature);
      const r = await this.consumeRaw(tx, c.id, signed ? this.crypto.hash(c.id, b.nonce) : 'invalid-signature');
      if (!signed) return { error: 'signature does not verify' };
      if (r !== 'OK') return { error: `challenge ${r.toLowerCase().replace('_', ' ')}` };
      await tx.deviceKey.updateMany({ where: { id: k.id }, data: { lastUsedAt: new Date() } });
      return { deviceKeyId: k.id };
    });
    if ('error' in out) throw new UnauthorizedException(out.error);
    return { ...(await this.crypto.issueSession({ sub: ctx.userId, did: out.deviceKeyId!, amr: ['hwk', 'bio'] })), deviceKeyId: out.deviceKeyId };
  }

  /** Fallback when biometrics changed / are unavailable: fresh sign-in (OTP) + authenticator code. */
  @Post('unlock/totp')
  async unlockWithTotp(@Ctx() ctx: RequestContext, @Body(new ZodBody(UnlockChallenge.extend({ code: z.string().regex(/^\d{6}$/) }))) b: { deviceId: string; code: string }) {
    this.requireFresh(ctx);
    const k = await this.db.withRls(ctx, (tx) => tx.deviceKey.findFirst({ where: { userId: ctx.userId, deviceId: b.deviceId, revokedAt: null } }));
    if (!k) throw new NotFoundException('this device is not registered (or was revoked)');
    await this.totp(ctx, b.code);
    return { ...(await this.crypto.issueSession({ sub: ctx.userId, did: k.id, amr: ['otp', 'totp'] })), deviceKeyId: k.id };
  }

  // ---------------------------------------------------------------------------------------

  private requireFresh(ctx: RequestContext) {
    if (ctx.session || !ctx.authTime || Date.now() / 1000 - ctx.authTime > FRESH_AUTH_S) throw new UnauthorizedException('sign in again (SMS code) to continue');
  }

  private async state(tx: Tx, userId: string) {
    const f = await tx.userAuthFactor.findFirst({ where: { userId } });
    return { phone: { verified: !!f?.phoneVerifiedAt, value: mask(f?.phone) }, email: { verified: !!f?.emailVerifiedAt, value: f?.email ? f.email.replace(/^(.).*(@.*)$/, '$1•••$2') : null },
      authenticator: { enrolled: !!f?.totpSecretCiphertext, verified: !!f?.totpVerifiedAt },
      complete: !!f?.onboardedAt, onboardedAt: f?.onboardedAt ?? null,
      next: !f?.phoneVerifiedAt ? 'phone' : !f.emailVerifiedAt ? 'email' : !f.totpVerifiedAt ? 'authenticator' : 'device' };
  }

  private challenge(ctx: RequestContext, kind: 'PHONE_OTP' | 'EMAIL_OTP', target: string, message: (code: string) => Parameters<OtpDeliveryService['send']>[0]) {
    return this.db.withRls(ctx, async (tx) => {
      const recent = await tx.authChallenge.count({ where: { userId: ctx.userId, kind, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
      if (recent >= 5) throw new TooManyRequests('too many codes requested; try again in an hour');
      const id = randomUUID(), code = this.crypto.newCode();
      await tx.authChallenge.create({ data: { id, userId: ctx.userId, kind, target, codeHash: this.crypto.hash(id, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) } });
      await this.otp.send(message(code));
      return { challengeId: id, expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(), sentTo: kind === 'PHONE_OTP' ? mask(target, 4) : target.replace(/^(.).*(@.*)$/, '$1•••$2') };
    });
  }

  private async consume(ctx: RequestContext, b: z.infer<typeof Verify>, kind: 'PHONE_OTP' | 'EMAIL_OTP') {
    // Commit the attempt counter first; refuse afterwards (throwing inside would roll it back).
    const r = await this.db.withRls(ctx, async (tx) => {
      const c = await tx.authChallenge.findFirst({ where: { id: b.challengeId, kind } });
      return c ? this.consumeRaw(tx, c.id, this.crypto.hash(c.id, b.code)) : 'NOT_FOUND';
    });
    if (r === 'NOT_FOUND') throw new NotFoundException('code not found');
    if (r === 'INVALID') throw new BadRequestException('wrong code');
    if (r !== 'OK') throw new BadRequestException(`code ${r.toLowerCase()}; request a new one`);
    this.onboardingGuard.forget(ctx.userId);
    return this.db.withRls(ctx, (tx) => this.state(tx, ctx.userId));
  }

  private async consumeRaw(tx: Tx, id: string, hash: string) {
    const [r] = await tx.$queryRaw<Array<{ r: string }>>`SELECT app.consume_auth_challenge(${id}::uuid, ${hash}) AS r`;
    return r!.r;
  }

  /** Check an authenticator code in its own committed transaction (failures count towards the lock). */
  private async totp(ctx: RequestContext, code: string) {
    const r = await this.db.withRls(ctx, async (tx) => {
      const f = await tx.userAuthFactor.findFirst({ where: { userId: ctx.userId } });
      if (!f?.totpSecretCiphertext) return 'NONE';
      const [l] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT app.totp_locked() AS locked`;
      if (l?.locked) return 'LOCKED';
      const step = verifyTotp(this.crypto.decryptSecret(f.totpSecretCiphertext), code);
      if (step === null) {
        const [x] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT app.record_totp_failure() AS locked`;
        return x?.locked ? 'LOCKED' : 'WRONG';
      }
      await tx.$executeRaw`SELECT app.accept_totp_step(${step})`; // replay → 422
      return 'OK';
    });
    if (r === 'NONE') throw new ForbiddenException('no authenticator enrolled');
    if (r === 'LOCKED') throw new TooManyRequests('too many wrong authenticator codes; try again in 15 minutes');
    if (r === 'WRONG') throw new BadRequestException('wrong authenticator code');
  }

}
