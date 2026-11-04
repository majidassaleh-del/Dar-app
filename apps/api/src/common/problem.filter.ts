import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * RFC 9457 problem+json for every error. Postgres errors raised by RLS and
 * the workflow triggers are translated to HTTP semantics here, so module
 * code can let the database be the source of truth:
 *   42501 insufficient_privilege / RLS violation → 403
 *   23514 check_violation (trigger business rule) → 422
 *   23505 unique_violation                         → 409
 *   23503 foreign_key_violation                     → 422
 * Trigger messages are shown (they are written for users); other database
 * errors are logged and returned as a generic 500.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const p = this.toProblem(err);
    if (p.status >= 500) this.log.error(err instanceof Error ? err.stack : String(err), req.ctx?.requestId);
    res.status(p.status).type('application/problem+json').json({ ...p, instance: req.originalUrl, requestId: req.ctx?.requestId });
  }

  private toProblem(err: unknown): { type: string; title: string; status: number; code: string; detail?: string } {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const body = err.getResponse();
      const detail = typeof body === 'string' ? body : (body as { message?: string | string[] }).message;
      return { type: 'about:blank', title: HttpStatus[status] ?? 'Error', status, code: HttpStatus[status] ?? 'ERROR',
               detail: Array.isArray(detail) ? detail.join('; ') : detail };
    }
    const pg = postgresError(err);
    if (pg) {
      const map: Record<string, [number, string]> = {
        '42501': [403, 'FORBIDDEN'], '23514': [422, 'BUSINESS_RULE'], '23505': [409, 'CONFLICT'], '23503': [422, 'INVALID_REFERENCE'],
        'P0002': [404, 'NOT_FOUND'],
      };
      const [status, code] = map[pg.code] ?? [500, 'DATABASE_ERROR'];
      if (status < 500) {
        const detail = /row-level security/i.test(pg.message) ? 'not permitted for your role' : pg.message;
        return { type: `https://errors.herp.app/${code.toLowerCase()}`, title: code, status, code, detail };
      }
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { type: 'https://errors.herp.app/conflict', title: 'CONFLICT', status: 409, code: 'CONFLICT',
               detail: `already exists (${([] as string[]).concat((err.meta?.target as string[] | string | undefined) ?? []).join(', ')})` };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      return { type: 'https://errors.herp.app/invalid_reference', title: 'INVALID_REFERENCE', status: 422, code: 'INVALID_REFERENCE', detail: 'referenced record does not exist' };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { type: 'about:blank', title: 'Not Found', status: 404, code: 'NOT_FOUND' };
    }
    return { type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'INTERNAL' };
  }
}

/** Dig the SQLSTATE and message out of the shapes Prisma wraps Postgres errors in. */
export function postgresError(err: unknown): { code: string; message: string } | undefined {
  if (!(err instanceof Error)) return undefined;
  const meta = (err as { meta?: Record<string, unknown> }).meta;
  const code = (meta?.code as string | undefined) ?? err.message.match(/Code: `?(\w{5})`?/)?.[1]
    ?? err.message.match(/\b(42501|23514|23505|23503|P0002)\b/)?.[1];
  if (!code || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  const message = (meta?.message as string | undefined) ?? err.message.match(/Message: `([^`]*)`/)?.[1]
    ?? err.message.match(/ERROR: ([^\n]*)/)?.[1] ?? err.message.split('\n').at(-1) ?? 'database error';
  return { code, message };
}
