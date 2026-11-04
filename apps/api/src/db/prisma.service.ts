import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import type { RequestContext } from '../tenancy/request-context';

export type Tx = Prisma.TransactionClient;

/**
 * The only way module code touches the database.
 *
 * `withRls` opens ONE interactive transaction per unit of work and, before
 * anything else, switches to the request role and sets the RLS context with
 * SET LOCAL semantics (transaction-scoped, so it is PgBouncer
 * transaction-mode safe and can never leak to the next request on the same
 * connection). The login role has no table privileges, so a query that skips
 * this fails closed instead of reading across tenants.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) private readonly env: Env) {
    super({ datasources: { db: { url: env.DATABASE_URL } } });
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }

  withRls<T>(ctx: Pick<RequestContext, 'userId' | 'householdId'>, fn: (tx: Tx) => Promise<T>,
             opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.$transaction(async (tx) => {
      // Role name is validated by the env schema (identifier regex), so interpolation is safe here.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${this.env.DB_REQUEST_ROLE}`);
      await tx.$queryRaw`SELECT set_config('app.user_id', ${ctx.userId}, true),
                                set_config('app.household_id', ${ctx.householdId ?? ''}, true)`;
      return fn(tx);
    }, { timeout: opts.timeoutMs ?? 10_000 });
  }
}
