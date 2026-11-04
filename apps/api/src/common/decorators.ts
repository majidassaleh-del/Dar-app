import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestContext } from '../tenancy/request-context';

export const IS_PUBLIC = 'herp:public';
export const NO_HOUSEHOLD = 'herp:no-household';

/** No authentication (health checks, webhooks verify their own signatures). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Authenticated, but not scoped to a household (/me, POST /households). */
export const NoHousehold = () => SetMetadata(NO_HOUSEHOLD, true);

/** Inject the caller's RequestContext into a handler parameter. */
export const Ctx = createParamDecorator((_: unknown, c: ExecutionContext): RequestContext =>
  c.switchToHttp().getRequest<Request>().ctx!);
