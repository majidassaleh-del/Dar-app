import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, Receipt } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { money } from '../common/rls-write';
import { StorageService } from '../files/storage.service';
import type { RequestContext } from '../tenancy/request-context';
import { OcrService } from './ocr.service';

const MAX_BYTES = 10 * 1024 * 1024;
const MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
type Mime = (typeof MIME)[number];
const UploadQuery = z.object({ mimeType: z.enum(MIME), pettyCashAccountId: z.guid().optional(), vehicleId: z.guid().optional() });
const ToExpense = z.object({
  accountId: z.guid(), amount: z.number().positive().max(1_000_000).optional(), merchantName: z.string().trim().max(120).optional(),
  description: z.string().trim().min(1).max(300).optional(), occurredAt: z.string().datetime({ offset: true }).optional(),
  vehicleId: z.guid().optional(), categoryId: z.guid().optional(),
}).strict();

/** The file must be what it claims (magic bytes), not just labelled so. */
function sniff(b: Buffer): Mime | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

interface Extracted { merchantName?: string; vatNumber?: string; date?: string; total?: string; vat?: string; currency?: string;
  source?: string; needsReview?: boolean; warnings?: string[]; fieldConfidence?: Record<string, number>; isReceipt?: boolean; error?: string }

const receiptDto = (r: Receipt) => {
  const x = (r.extracted ?? {}) as Extracted;
  return { id: r.id, status: r.status, mimeType: r.mimeType, uploadedById: r.uploadedById, createdAt: r.createdAt, processedAt: r.processedAt,
    ocrProvider: r.ocrProvider, confidence: r.confidence, zatcaVerified: !!r.zatcaQr,
    extracted: { merchantName: x.merchantName ?? null, vatNumber: x.vatNumber ?? null, date: x.date ?? null, total: x.total ?? null, vat: x.vat ?? null,
      currency: x.currency ?? 'SAR', source: x.source ?? null }, needsReview: x.needsReview ?? true, warnings: x.warnings ?? [], ocrError: x.error ?? null };
};

/** Noon in Riyadh on the receipt date, if it is plausible (not in the future, not older than 90 days). */
function receiptTime(date: string | undefined, now = Date.now()): { at: Date; warning?: string } {
  if (!date) return { at: new Date(now) };
  const at = new Date(`${date}T12:00:00+03:00`);
  if (Number.isNaN(at.getTime()) || at.getTime() > now + 86_400_000 || at.getTime() < now - 90 * 86_400_000)
    return { at: new Date(now), warning: `receipt date ${date} is implausible; used today` };
  return { at };
}

/**
 * Snap a receipt → OCR (Claude vision + local ZATCA QR decoding) → petty-cash
 * expense filled in from the receipt. The expense lands PENDING_REVIEW like any
 * custodian entry; low-confidence reads are flagged for the reviewer, and an
 * unreadable total leaves the expense for the worker to complete.
 */
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly db: PrismaService, private readonly storage: StorageService, private readonly ocr: OcrService) {}

  @Post()
  async upload(@Ctx() ctx: RequestContext, @Query(new ZodQuery(UploadQuery)) q: z.infer<typeof UploadQuery>, @Req() req: Request) {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || !body.length) throw new BadRequestException('send the image or PDF bytes with Content-Type: application/octet-stream');
    if (body.length > MAX_BYTES) throw new BadRequestException('receipt files are limited to 10 MB');
    if (sniff(body) !== q.mimeType) throw new BadRequestException(`the file content is not ${q.mimeType}`);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const id = randomUUID();
    const r = await this.db.withRls(ctx, async (tx) => {
      const dup = await tx.receipt.findFirst({ where: { sha256 } });
      if (dup) throw new ConflictException(`this receipt was already scanned (${dup.id})`);
      if (q.pettyCashAccountId && !(await tx.pettyCashAccount.findFirst({ where: { id: q.pettyCashAccountId } }))) throw new NotFoundException('petty cash float not found');
      return tx.receipt.create({ data: { id, householdId: ctx.householdId!, uploadedById: ctx.membershipId!, status: 'PROCESSING',
        storageKey: `${ctx.householdId}/${id}`, mimeType: q.mimeType, sha256 } });
    });
    await this.storage.put(r.storageKey, body);
    return this.process(ctx, r.id, body, q.pettyCashAccountId, q.vehicleId);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => receiptDto(await this.find(tx, id)));
  }

  /** Retry OCR (e.g. after a provider outage, or once OCR is configured). */
  @Post(':id/process')
  async reprocess(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withRls(ctx, (tx) => this.find(tx, id));
    if (r.status !== 'UPLOADED' && r.status !== 'PROCESSING') throw new ConflictException(`receipt already ${r.status.toLowerCase()}`);
    return this.process(ctx, id, await this.storage.get(r.storageKey));
  }

  /** Turn a scanned receipt into a petty-cash expense; any field may be corrected by the worker. */
  @Post(':id/expense')
  toExpense(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(ToExpense)) b: z.infer<typeof ToExpense>) {
    return this.db.withRls(ctx, async (tx) => {
      const r = await this.find(tx, id);
      const x = (r.extracted ?? {}) as Extracted;
      const amount = b.amount ?? (x.total ? Number(x.total) : undefined);
      if (!amount) throw new UnprocessableEntityException('the total could not be read from this receipt; enter the amount');
      const time = b.occurredAt ? { at: new Date(b.occurredAt) } : receiptTime(x.date);
      return this.createExpense(tx, ctx, r, x, b.accountId, { amount, merchantName: b.merchantName, description: b.description, at: time.at,
        vehicleId: b.vehicleId, categoryId: b.categoryId, corrected: b.amount !== undefined && x.total !== undefined && Number(x.total) !== b.amount });
    });
  }

  private async process(ctx: RequestContext, id: string, bytes: Buffer, accountId?: string, vehicleId?: string) {
    const mime = (await this.db.withRls(ctx, (tx) => this.find(tx, id))).mimeType;
    let x: Extracted; let status: 'EXTRACTED' | 'UPLOADED'; let provider: string | null = null; let confidence: number | null = null; let qr: string | null = null;
    if (!this.ocr.configured) { x = { error: 'OCR is not configured; enter the expense manually' }; status = 'UPLOADED'; }
    else {
      try {
        const out = await this.ocr.run(new Uint8Array(bytes), mime);
        x = { merchantName: out.merchantName, vatNumber: out.vatNumber, date: out.date, total: out.total, vat: out.vat, currency: out.currency,
          source: out.source, needsReview: out.needsReview || !out.isReceipt, isReceipt: out.isReceipt, fieldConfidence: out.fieldConfidence,
          warnings: [...out.warnings, ...(out.isReceipt ? [] : ['this does not look like a receipt'])] };
        status = 'EXTRACTED'; provider = out.ocrProvider; confidence = out.confidence; qr = out.qrPayload ?? null;
      } catch (e) {
        x = { error: `OCR failed: ${e instanceof Error ? e.message : String(e)}` }; status = 'UPLOADED';
      }
    }
    return this.db.withRls(ctx, async (tx) => {
      await tx.$executeRaw`SELECT app.record_receipt_extraction(${id}::uuid, ${status}, ${provider}, ${JSON.stringify(x)}::jsonb, ${confidence}::float8, ${qr})`;
      const r = await this.find(tx, id);
      let expense = null;
      if (accountId && status === 'EXTRACTED' && x.total && x.isReceipt !== false) {
        const time = receiptTime(x.date);
        if (time.warning) x.warnings = [...(x.warnings ?? []), time.warning];
        expense = (await this.createExpense(tx, ctx, r, x, accountId, { amount: Number(x.total), at: time.at, vehicleId })).expense;
      }
      return { receipt: receiptDto(r), expense, autoFilled: !!expense };
    });
  }

  private async createExpense(tx: Tx, ctx: RequestContext, r: Receipt, x: Extracted, accountId: string,
                              o: { amount: number; at: Date; merchantName?: string; description?: string; vehicleId?: string; categoryId?: string; corrected?: boolean }) {
    if (!(await tx.pettyCashAccount.findFirst({ where: { id: accountId } }))) throw new NotFoundException('petty cash float not found');
    const merchant = o.merchantName ?? x.merchantName;
    const description = o.description ?? (merchant ? `${merchant}${x.vat ? ` (VAT ${x.vat})` : ''}` : 'Scanned receipt');
    const log = await tx.pettyCashLog.create({ data: { householdId: ctx.householdId!, accountId, type: 'EXPENSE', amount: o.amount,
      descriptionI18n: { [ctx.locale]: description } as Prisma.InputJsonValue, originalLocale: ctx.locale, merchantName: merchant?.slice(0, 120),
      receiptId: r.id, occurredAt: o.at, vehicleId: o.vehicleId, categoryId: o.categoryId, recordedById: ctx.membershipId! } });
    return { receipt: receiptDto(r), expense: { id: log.id, accountId, status: log.status, amount: money(log.amount), merchantName: log.merchantName,
      occurredAt: log.occurredAt, description, needsReview: (x.needsReview ?? true) || !!o.corrected, warnings: x.warnings ?? [] } };
  }

  private async find(tx: Tx, id: string) {
    const r = await tx.receipt.findFirst({ where: { id } });
    if (!r) throw new NotFoundException('receipt not found');
    return r;
  }
}
