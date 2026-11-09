import { ForbiddenException, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AUTH_FLOW, IS_PUBLIC } from '../common/decorators';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../db/prisma.service';
import { WEB_SESSION } from './session';

/**
 * After authentication: (1) the user must have completed first-time onboarding
 * (SMS OTP + email + authenticator) before any other endpoint; (2) when device
 * sessions are required (production default), the request must carry the token
 * from today's Face ID / Touch ID unlock, from a device key that is still active.
 * Positive answers are cached briefly; revocation takes effect within 30 s.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  private readonly onboarded = new Map<string, number>();
  private readonly activeKeys = new Map<string, number>();
  private readonly requireSession: boolean;

  constructor(private readonly reflector: Reflector, private readonly db: PrismaService, @Inject(ENV) env: Env) {
    this.requireSession = (env.AUTH_REQUIRE_DEVICE_SESSION ?? (env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(AUTH_FLOW, targets)) return true;
    const ctx = context.switchToHttp().getRequest<Request>().ctx!;
    const now = Date.now();
    if ((this.onboarded.get(ctx.userId) ?? 0) < now) {
      const [r] = await this.db.withRls({ userId: ctx.userId }, (tx) => tx.$queryRaw<Array<{ ok: boolean }>>`SELECT app.user_onboarded(${ctx.userId}::uuid) AS ok`);
      if (!r?.ok) throw new ForbiddenException('complete onboarding first: verify your phone, your email and an authenticator app (/v1/auth/onboarding)');
      this.onboarded.set(ctx.userId, now + 60_000);
    }
    if (ctx.session && ctx.session.deviceKeyId !== WEB_SESSION) {
      if ((this.activeKeys.get(ctx.session.deviceKeyId) ?? 0) < now) {
        const k = await this.db.withRls({ userId: ctx.userId }, (tx) => tx.deviceKey.findFirst({ where: { id: ctx.session!.deviceKeyId, userId: ctx.userId, revokedAt: null }, select: { id: true } }));
        if (!k) throw new UnauthorizedException('this device was signed out; unlock again');
        this.activeKeys.set(ctx.session.deviceKeyId, now + 30_000);
      }
    } else if (!ctx.session && this.requireSession) {
      throw new UnauthorizedException('unlock the app first (Face ID / Touch ID): POST /v1/auth/unlock');
    }
    return true;
  }

  forget(userId: string, deviceKeyId?: string) { this.onboarded.delete(userId); if (deviceKeyId) this.activeKeys.delete(deviceKeyId); }
}
