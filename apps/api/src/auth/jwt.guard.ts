import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { negotiateLocale } from '@herp/i18n';
import { ENV, type Env } from '../config/env';
import { IS_PUBLIC } from '../common/decorators';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifies the Bearer JWT (JWKS in production, HS256 in dev) and starts the request context. */
@Injectable()
export class JwtGuard implements CanActivate {
  private readonly key: JWTVerifyGetKey | Uint8Array;

  constructor(@Inject(ENV) private readonly env: Env, private readonly reflector: Reflector) {
    this.key = env.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)) : new TextEncoder().encode(env.AUTH_JWT_SECRET!);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const locale = negotiateLocale(req.headers['accept-language']);
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      req.ctx = { userId: '', locale, requestId };
      return true;
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('missing bearer token');
    try {
      const { payload } = await jwtVerify(token, this.key as never, {
        issuer: this.env.AUTH_ISSUER, audience: this.env.AUTH_AUDIENCE,
        algorithms: this.env.AUTH_JWKS_URL ? ['RS256', 'ES256', 'EdDSA'] : ['HS256'],
      });
      if (!payload.sub || !UUID.test(payload.sub)) throw new Error('sub is not a user id');
      const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : payload.iat;
      req.ctx = { userId: payload.sub, locale, requestId, authTime };
      return true;
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
  }
}
