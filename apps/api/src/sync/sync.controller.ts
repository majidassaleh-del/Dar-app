import { Body, Controller, ForbiddenException, Get, Inject, Post, Query } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { HouseholdTask, Prisma, WorkOrderInstruction } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx, NoHousehold } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { ProblemFilter } from '../common/problem.filter';
import { ENV, type Env } from '../config/env';
import type { RequestContext } from '../tenancy/request-context';

const Base = { opId: z.guid(), entityId: z.guid(), baseVersion: z.number().int().min(1), clientAt: z.string().datetime({ offset: true }) };
const Op = z.discriminatedUnion('kind', [
  z.object({ ...Base, kind: z.literal('TASK_UPDATE'),
    data: z.object({ status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(), proofPhotoUrl: z.string().url().max(2000).optional() }).strict()
      .refine((d) => d.status || d.proofPhotoUrl, 'nothing to update') }).strict(),
  z.object({ ...Base, kind: z.literal('INSTRUCTION_COMPLETE'),
    data: z.object({ note: z.string().max(500).optional(), photoStorageKey: z.string().max(300).optional() }).strict() }).strict(),
]);
const Push = z.object({ deviceId: z.string().min(8).max(128), ops: z.array(Op).min(1).max(100) }).strict();
const Pull = z.object({ since: z.string().datetime({ offset: true }).optional() });
const OfflineKey = z.object({ deviceId: z.string().min(8).max(128) }).strict();

type OpIn = z.infer<typeof Op>;
type Outcome = { result: 'APPLIED' | 'CONFLICT' | 'REJECTED'; version?: number; server?: unknown; problem?: unknown; wrote?: boolean };
/** Pulls overlap by this much so rows committed late (older updatedAt) are not missed; clients merge by version. */
const PULL_OVERLAP_MS = 120_000;
/** The OTP fallback key is handed out only right after a real sign-in. */
const FRESH_AUTH_S = 600;

const taskDto = (t: HouseholdTask, locale: RequestContext['locale']) => ({
  id: t.id, title: resolveI18n(t.titleI18n as I18nText, { locale }).text, description: t.description, assigneeId: t.assigneeId,
  status: t.status, dueAt: t.dueAt, completedAt: t.completedAt, proofPhotoUrl: t.proofPhotoUrl, version: t.version, updatedAt: t.updatedAt });
const instructionDto = (i: WorkOrderInstruction, locale: RequestContext['locale']) => ({
  id: i.id, workOrderId: i.workOrderId, sequence: i.sequence, text: resolveI18n(i.textI18n as I18nText, { locale, originalLocale: i.originalLocale }).text,
  requiresPhoto: i.requiresPhoto, isSafetyCritical: i.isSafetyCritical, completedAt: i.completedAt, completedById: i.completedById,
  note: i.note, version: i.version, updatedAt: i.updatedAt });

/**
 * Offline sync for worker chores and work-order instructions.
 *
 * push: each op is applied in its own transaction under the caller's RLS
 * context, so the same database rules as the online endpoints apply. Ops are
 * idempotent on (member, opId): a replay returns the stored outcome. An op
 * conflicts when someone else changed the row after the version the device
 * saw. Versions produced by the member's own earlier ops count as seen, so a
 * queue of several edits to one chore made offline applies in order.
 *
 * pull: rows the caller can see that changed since the cursor.
 */
@Controller('sync')
export class SyncController {
  private readonly problems = new ProblemFilter();
  private readonly offlineSecret: Buffer;

  constructor(private readonly db: PrismaService, @Inject(ENV) env: Env) {
    this.offlineSecret = env.OFFLINE_KEY_SECRET ? Buffer.from(env.OFFLINE_KEY_SECRET) : randomBytes(32);
  }

  @Post('push')
  async push(@Ctx() ctx: RequestContext, @Body(new ZodBody(Push)) b: z.infer<typeof Push>) {
    const results = [];
    for (const op of b.ops) results.push({ opId: op.opId, ...(await this.apply(ctx, b.deviceId, op)) });
    return { results };
  }

  @Get('pull')
  pull(@Ctx() ctx: RequestContext, @Query(new ZodQuery(Pull)) q: z.infer<typeof Pull>) {
    return this.db.withRls(ctx, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp() AS now`;
      const now = row!.now;
      const since = q.since ? new Date(q.since) : new Date(0);
      // Chores: own (assignee) only — the offline app is the worker's view, not the manager's.
      const tasks = await tx.householdTask.findMany({ where: { assigneeId: ctx.membershipId, updatedAt: { gt: since } }, orderBy: { updatedAt: 'asc' }, take: 1000 });
      const instructions = await tx.workOrderInstruction.findMany({
        where: { updatedAt: { gt: since }, workOrder: { assigneeId: ctx.membershipId, deletedAt: null } }, orderBy: { updatedAt: 'asc' }, take: 1000 });
      return { cursor: new Date(now.getTime() - PULL_OVERLAP_MS).toISOString(),
               tasks: tasks.map((t) => taskDto(t, ctx.locale)), instructions: instructions.map((i) => instructionDto(i, ctx.locale)) };
    });
  }

  /**
   * Fallback unlock: a per-device key the app uses to unwrap its local data key
   * when biometrics are unavailable or were re-enrolled. Only issued right after
   * a real sign-in (OTP), never on a refreshed token.
   */
  @NoHousehold()
  @Post('offline-key')
  offlineKey(@Ctx() ctx: RequestContext, @Body(new ZodBody(OfflineKey)) b: z.infer<typeof OfflineKey>) {
    if (!ctx.authTime || Date.now() / 1000 - ctx.authTime > FRESH_AUTH_S) throw new ForbiddenException('sign in again (OTP) to unlock offline data');
    const key = createHmac('sha256', this.offlineSecret).update(`herp-offline-v1\0${ctx.userId}\0${b.deviceId}`).digest('base64url');
    return { key, alg: 'A256GCM-KW', version: 1 };
  }

  private async apply(ctx: RequestContext, deviceId: string, op: OpIn): Promise<Outcome & { replayed?: boolean }> {
    const prior = await this.prior(ctx, op.opId);
    if (prior) return prior;
    try {
      return await this.db.withRls(ctx, async (tx) => {
        const outcome = op.kind === 'TASK_UPDATE' ? await this.task(tx, ctx, op) : await this.instruction(tx, ctx, op);
        if (outcome) await this.record(tx, ctx, deviceId, op, outcome);
        return outcome ?? { result: 'REJECTED' as const, problem: { status: 404, code: 'NOT_FOUND', detail: `${op.kind === 'TASK_UPDATE' ? 'task' : 'instruction'} not found` } };
      });
    } catch (err) {
      const again = await this.prior(ctx, op.opId); // a concurrent replay of the same op won the race
      if (again) return again;
      const p = this.problems.toProblem(err);
      if (p.status >= 500) throw err;
      const outcome: Outcome = { result: 'REJECTED', problem: { status: p.status, code: p.code, detail: p.detail } };
      await this.db.withRls(ctx, (tx) => this.record(tx, ctx, deviceId, op, outcome)).catch(() => undefined);
      return outcome;
    }
  }

  private async prior(ctx: RequestContext, opId: string) {
    const r = await this.db.withRls(ctx, (tx) => tx.syncOperation.findUnique({ where: { membershipId_opId: { membershipId: ctx.membershipId!, opId } } }));
    return r ? { ...(r.response as Outcome), result: r.result, replayed: true } : null;
  }

  private record(tx: Tx, ctx: RequestContext, deviceId: string, op: OpIn, o: Outcome) {
    return tx.syncOperation.create({ data: { householdId: ctx.householdId!, membershipId: ctx.membershipId!, deviceId, opId: op.opId, kind: op.kind,
      entityId: op.entityId, result: o.result, response: o as Prisma.InputJsonValue, clientAt: new Date(op.clientAt) } });
  }

  /** Highest version this member's own applied ops produced for the entity. */
  private async ownVersion(tx: Tx, ctx: RequestContext, entityId: string) {
    const own = await tx.syncOperation.findMany({ where: { membershipId: ctx.membershipId, entityId, result: 'APPLIED' }, select: { response: true } });
    return Math.max(0, ...own.map((o) => o.response as Outcome).filter((o) => o.wrote).map((o) => Number(o.version ?? 0)));
  }

  private async task(tx: Tx, ctx: RequestContext, op: Extract<OpIn, { kind: 'TASK_UPDATE' }>): Promise<Outcome | null> {
    const t = await tx.householdTask.findFirst({ where: { id: op.entityId } });
    if (!t) return null;
    const wanted = { ...(op.data.status ? { status: op.data.status } : {}), ...(op.data.proofPhotoUrl ? { proofPhotoUrl: op.data.proofPhotoUrl } : {}) };
    const already = Object.entries(wanted).every(([k, v]) => (t as Record<string, unknown>)[k] === v);
    if (already) return { result: 'APPLIED', version: t.version };
    if (t.version > Math.max(op.baseVersion, await this.ownVersion(tx, ctx, t.id))) return { result: 'CONFLICT', version: t.version, server: taskDto(t, ctx.locale) };
    await tx.householdTask.updateMany({ where: { id: t.id }, data: wanted });
    const after = await tx.householdTask.findFirstOrThrow({ where: { id: t.id } });
    if (after.version === t.version) throw new ForbiddenException('not permitted for your role'); // RLS filtered the UPDATE
    return { result: 'APPLIED', version: after.version, wrote: true };
  }

  private async instruction(tx: Tx, ctx: RequestContext, op: Extract<OpIn, { kind: 'INSTRUCTION_COMPLETE' }>): Promise<Outcome | null> {
    const i = await tx.workOrderInstruction.findFirst({ where: { id: op.entityId } });
    if (!i) return null;
    if (i.completedAt) return i.completedById === ctx.membershipId ? { result: 'APPLIED', version: i.version }
                                                                   : { result: 'CONFLICT', version: i.version, server: instructionDto(i, ctx.locale) };
    if (i.version > Math.max(op.baseVersion, await this.ownVersion(tx, ctx, i.id))) return { result: 'CONFLICT', version: i.version, server: instructionDto(i, ctx.locale) };
    // Completion time is when it happened on the device (offline): never in the future, at most 7 days back.
    const at = new Date(Math.max(Math.min(Date.parse(op.clientAt), Date.now()), Date.now() - 7 * 86_400_000));
    await tx.workOrderInstruction.updateMany({ where: { id: i.id }, data: { completedAt: at, note: op.data.note, photoStorageKey: op.data.photoStorageKey } });
    const after = await tx.workOrderInstruction.findFirstOrThrow({ where: { id: i.id } });
    if (after.version === i.version) throw new ForbiddenException('not permitted for your role');
    return { result: 'APPLIED', version: after.version, wrote: true };
  }
}
