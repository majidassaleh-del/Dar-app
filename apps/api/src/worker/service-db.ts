import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Worker database access: logs in as herp_worker and acts as app_service
 * (BYPASSRLS) inside each transaction. Worker code must always filter by
 * householdId explicitly.
 */
export class ServiceDb {
  readonly client: PrismaClient;
  constructor(url: string) { this.client = new PrismaClient({ datasources: { db: { url } } }); }

  run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_service');
      return fn(tx);
    }, { timeout: 60_000 });
  }

  close() { return this.client.$disconnect(); }
}
