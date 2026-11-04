import type { Prisma } from '@prisma/client';
import type { Tx } from '../db/prisma.service';
import type { RequestContext } from '../tenancy/request-context';

/**
 * Append to the audit log. Uses createMany (no RETURNING): the caller may write
 * an audit entry for their own action without holding admin.audit.read, which
 * INSERT … RETURNING would require under RLS.
 */
export function audit(tx: Tx, ctx: RequestContext, e: { action: Prisma.AuditLogCreateManyInput['action']; entityType: string;
  entityId?: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue }) {
  return tx.auditLog.createMany({ data: [{ householdId: ctx.householdId, actorUserId: ctx.userId, requestId: ctx.requestId, ...e }] });
}
