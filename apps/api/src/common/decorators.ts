import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestContext } from '../tenancy/request-context';

export const IS_PUBLIC = 'herp:public';
export const NO_HOUSEHOLD = 'herp:no-household';
export const AUTH_FLOW = 'herp:auth-flow';

/** No authentication (health checks, webhooks verify their own signatures). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Authenticated, but not scoped to a household (/me, POST /households). */
export const NoHousehold = () => SetMetadata(NO_HOUSEHOLD, true);

/** Onboarding / unlock endpoints: reachable before onboarding and without a device session. */
export const AuthFlow = () => SetMetadata(AUTH_FLOW, true);

/** Inject the caller's RequestContext into a handler parameter. */
export const Ctx = createParamDecorator((_: unknown, c: ExecutionContext): RequestContext =>
  c.switchToHttp().getRequest<Request>().ctx!);
