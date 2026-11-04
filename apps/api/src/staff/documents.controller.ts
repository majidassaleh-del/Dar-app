import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { lookupIndex, seal, unseal } from '@herp/crypto';
import { resolveI18n, type I18nText } from '@herp/i18n';
import { PrismaService, type Tx } from '../db/prisma.service';
import { CryptoService } from '../crypto/crypto.module';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { audit } from '../common/audit';
import { assertWritten, isoDate } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';
import { CreateDocument, ExpiringQuery, LookupDocument, UpdateDocument, validateDocNumber, type DocType } from './staff.schemas';
import { documentDto, todayIn } from './staff.dto';

const DEFAULT_ALERT_DAYS = [60, 30, 15];

async function householdCalendar(tx: Tx, householdId: string) {
  const h = await tx.household.findFirst({ where: { id: householdId }, select: { timezone: true, settings: true } });
  const configured = (h?.settings as { documentAlertDays?: unknown } | null)?.documentAlertDays;
  const alertDays = Array.isArray(configured) && configured.every((n) => Number.isInteger(n) && n > 0) ? (configured as number[]) : DEFAULT_ALERT_DAYS;
  return { timezone: h?.timezone ?? 'Asia/Riyadh', alertDays: [...alertDays].sort((a, b) => b - a) };
}

/**
 * Household-wide document queries. Registered BEFORE the per-staff controller
 * so "/staff/documents/…" is not parsed as "/staff/:staffId/…".
 */
@Controller('staff/documents')
export class DocumentQueriesController {
  constructor(private readonly db: PrismaService, private readonly crypto: CryptoService) {}

  /** Exact-match search by number through the blind index: no decryption, no full-table scan of secrets. */
  @Get('lookup')
  lookup(@Ctx() ctx: RequestContext, @Query(new ZodQuery(LookupDocument)) q: z.infer<typeof LookupDocument>) {
    return this.db.withRls(ctx, async (tx) => {
      const idx = await lookupIndex(this.crypto.cipher, 'identity_documents.number', ctx.householdId!, q.number);
      const d = await tx.identityDocument.findFirst({ where: { type: q.type, numberBlindIndex: idx },
        include: { staff: { select: { id: true, fullNameI18n: true, staffType: true } } } });
      if (!d) throw new NotFoundException('no document with that number');
      const { timezone } = await householdCalendar(tx, ctx.householdId!);
      return { ...documentDto(d, todayIn(timezone)),
               staff: { id: d.staff.id, staffType: d.staff.staffType, name: resolveI18n(d.staff.fullNameI18n as I18nText, { locale: ctx.locale }).text } };
    });
  }

  /**
   * Documents expired or expiring within `withinDays` (default: the largest alert tier, 60),
   * each with its tier: EXPIRED, 15, 30 or 60 (per-document tiers), plus counts per tier.
   */
  @Get('expiring')
  expiring(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ExpiringQuery)) q: z.infer<typeof ExpiringQuery>) {
    return this.db.withRls(ctx, async (tx) => {
      const { alertDays } = await householdCalendar(tx, ctx.householdId!);
      const within = q.withinDays ?? Math.max(...alertDays);
      const rows = await tx.$queryRaw<Array<{ id: string; staff_id: string; staff_name: I18nText; staff_type: string; type: string;
        number_last4: string | null; expiry_date: Date; days_left: number; tier: string | null; held_by_employer: boolean }>>`
        WITH d AS (
          SELECT d.id, d."staffId", s."fullNameI18n", s."staffType", d.type, d."numberLast4", d."expiryDate", d."alertDays",
                 d."heldByEmployer", (d."expiryDate" - (now() AT TIME ZONE h.timezone)::date) AS days_left
          FROM identity_documents d
          JOIN staff_profiles s ON s.id = d."staffId" AND s."deletedAt" IS NULL AND s.status NOT IN ('TERMINATED', 'FINAL_EXIT')
          JOIN households h ON h.id = d."householdId"
          WHERE d."expiryDate" IS NOT NULL)
        SELECT id::text, "staffId"::text AS staff_id, "fullNameI18n" AS staff_name, "staffType"::text AS staff_type, type::text,
               "numberLast4" AS number_last4, "expiryDate" AS expiry_date, days_left, "heldByEmployer" AS held_by_employer,
               app.document_alert_tier(days_left, "alertDays") AS tier
        FROM d WHERE days_left <= ${within} ORDER BY "expiryDate", id`;
      const data = rows.map((r) => ({
        id: r.id, type: r.type, numberLast4: r.number_last4, expiryDate: isoDate(r.expiry_date), daysLeft: r.days_left,
        alertTier: r.tier, heldByEmployer: r.held_by_employer,
        staff: { id: r.staff_id, staffType: r.staff_type, name: resolveI18n(r.staff_name, { locale: ctx.locale }).text },
      }));
      const summary: Record<string, number> = { EXPIRED: 0, ...Object.fromEntries(alertDays.map((t) => [String(t), 0])) };
      for (const r of data) if (r.alertTier) summary[r.alertTier] = (summary[r.alertTier] ?? 0) + 1;
      return { withinDays: within, alertDays, summary, data };
    });
  }
}

@Controller('staff/:staffId/documents')
export class StaffDocumentsController {
  constructor(private readonly db: PrismaService, private readonly crypto: CryptoService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staffVisible(tx, staffId);
      const { timezone } = await householdCalendar(tx, ctx.householdId!);
      const rows = await tx.identityDocument.findMany({ where: { staffId }, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }] });
      return { data: rows.map((d) => documentDto(d, todayIn(timezone))) };
    });
  }

  /** The number is encrypted with the household DEK; only last-4 and an HMAC blind index are stored beside it. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Body(new ZodBody(CreateDocument)) b: z.infer<typeof CreateDocument>) {
    return this.db.withRls(ctx, async (tx) => {
      await this.staffVisible(tx, staffId);
      const cal = await householdCalendar(tx, ctx.householdId!);
      const { number, ...rest } = b;
      const row = await tx.identityDocument.create({
        data: { ...rest, staffId, householdId: ctx.householdId!, alertDays: b.alertDays ?? cal.alertDays,
                ...(await seal(this.crypto.cipher, 'identity_documents.number', ctx.householdId!, number)) } as never,
      });
      return documentDto(row, todayIn(cal.timezone));
    });
  }

  /** Renewal / correction. Protected table: only Head and EFA Office Admin may modify (RLS). */
  @Patch(':docId')
  update(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Param('docId', ParseUUIDPipe) docId: string,
         @Body(new ZodBody(UpdateDocument)) b: z.infer<typeof UpdateDocument>) {
    return this.db.withRls(ctx, async (tx) => {
      const doc = await this.find(tx, staffId, docId);
      if (b.number) {
        const err = validateDocNumber(doc.type as DocType, b.number);
        if (err) throw new BadRequestException(`number: ${err}`);
      }
      const { number, ...rest } = b;
      const { count } = await tx.identityDocument.updateMany({
        where: { id: docId, staffId },
        data: { ...rest, ...(await seal(this.crypto.cipher, 'identity_documents.number', ctx.householdId!, number)) },
      });
      await assertWritten(count, async () => doc, 'document');
      const { timezone } = await householdCalendar(tx, ctx.householdId!);
      return documentDto(await this.find(tx, staffId, docId), todayIn(timezone));
    });
  }

  /** Full number, decrypted on demand. Every reveal is written to the audit log (VIEW_SENSITIVE). */
  @Get(':docId/reveal')
  reveal(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Param('docId', ParseUUIDPipe) docId: string) {
    return this.db.withRls(ctx, async (tx) => {
      const doc = await this.find(tx, staffId, docId);
      const number = await unseal(this.crypto.cipher, 'identity_documents.number', ctx.householdId!, doc as unknown as Record<string, unknown>);
      await audit(tx, ctx, { action: 'VIEW_SENSITIVE', entityType: 'identity_documents', entityId: docId, after: { type: doc.type } });
      return { id: doc.id, type: doc.type, number };
    });
  }

  private async staffVisible(tx: Tx, staffId: string) {
    if (!(await tx.staffProfile.findFirst({ where: { id: staffId, deletedAt: null }, select: { id: true } }))) throw new NotFoundException('staff member not found');
  }

  private async find(tx: Tx, staffId: string, docId: string) {
    const d = await tx.identityDocument.findFirst({ where: { id: docId, staffId } });
    if (!d) throw new NotFoundException('document not found');
    return d;
  }
}
