import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Attachment } from '@prisma/client';
import { PrismaService, type Tx } from '../db/prisma.service';
import { CryptoService } from '../crypto/crypto.module';
import { Ctx, Public } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { audit } from '../common/audit';
import type { RequestContext } from '../tenancy/request-context';
import { StorageService } from './storage.service';

const ENTITY = ['RECEIPT', 'TRANSACTION', 'STAFF_DOCUMENT', 'REQUEST', 'VEHICLE', 'MAINTENANCE', 'PROPERTY', 'LEASE', 'BILL', 'TICKET', 'ASSET', 'POLICY',
  'WORK_ORDER', 'TRIP', 'PETTY_CASH', 'STAFF', 'MEDICAL_CHECKUP', 'TRAINING', 'ASSET_HANDOVER', 'EVALUATION', 'OTHER'] as const;
export const STAFF_FILE_CATEGORIES = ['PASSPORT', 'IQAMA', 'DRIVING_LICENSE', 'ACADEMIC_CERTIFICATE', 'EMPLOYMENT_CONTRACT', 'MEDICAL_REPORT',
  'SICK_LEAVE_CERTIFICATE', 'TRAINING_CERTIFICATE', 'OTHER'] as const;
const SENSITIVE = new Set(['PASSPORT', 'IQAMA', 'DRIVING_LICENSE', 'MEDICAL_REPORT', 'SICK_LEAVE_CERTIFICATE']);
const MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']);
const MAX_BYTES = 15 * 1024 * 1024;

const Create = z.object({
  entityType: z.enum(ENTITY), entityId: z.guid(), fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().refine((m) => MIME.has(m), 'allowed: pdf, jpeg, png, heic, webp'),
  sizeBytes: z.number().int().positive().max(MAX_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  staffId: z.guid().optional(), category: z.enum(STAFF_FILE_CATEGORIES).optional(),
}).strict().refine((a) => !a.category || a.staffId, { message: 'category is for staff files: staffId is required', path: ['staffId'] });
const ListQuery = z.object({ category: z.enum(STAFF_FILE_CATEGORIES).optional() });
const TokenQuery = z.object({ token: z.string().min(20).max(2000) });

export const fileDto = (a: Attachment) => ({ id: a.id, entityType: a.entityType, entityId: a.entityId, staffId: a.staffId, category: a.category,
  fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, status: a.status, isSensitive: a.isSensitive, encrypted: a.encrypted,
  uploadedById: a.uploadedById, uploadedAt: a.uploadedAt, createdAt: a.createdAt });

/**
 * Files in three steps: declare (POST /files) → upload bytes (PUT /files/{id}/content,
 * size + sha256 verified) → download through a short-lived signed URL
 * (GET /files/{id}/url). Sensitive staff files (passport, iqama, licence,
 * medical) are encrypted at rest with the household DEK and every URL issued
 * for them is audited. The download token names the requester and is
 * re-checked under RLS, so revoked access also revokes outstanding links.
 */
@Controller()
export class FilesController {
  constructor(private readonly db: PrismaService, private readonly crypto: CryptoService, private readonly storage: StorageService) {}

  @Post('files')
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      const sensitive = (b.category && SENSITIVE.has(b.category)) || b.entityType === 'STAFF_DOCUMENT' || b.entityType === 'MEDICAL_CHECKUP';
      const id = randomUUID();
      const a = await tx.attachment.create({ data: { id, householdId: ctx.householdId!, entityType: b.entityType, entityId: b.entityId, staffId: b.staffId,
        category: b.category, fileName: b.fileName, mimeType: b.mimeType, sizeBytes: b.sizeBytes, sha256: b.sha256, isSensitive: sensitive, encrypted: sensitive,
        storageKey: `${ctx.householdId}/${id}`, uploadedById: ctx.membershipId! } });
      return { ...fileDto(a), upload: { method: 'PUT', url: `/v1/files/${a.id}/content`, contentType: 'application/octet-stream' } };
    });
  }

  @Put('files/:id/content')
  async upload(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || !body.length) throw new BadRequestException('send the file bytes with Content-Type: application/octet-stream');
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      if (a.status === 'UPLOADED') throw new ConflictException('already uploaded; files are immutable');
      if (a.uploadedById !== ctx.membershipId) throw new NotFoundException('file not found');
      if (body.length !== a.sizeBytes) throw new BadRequestException(`size ${body.length} ≠ declared ${a.sizeBytes}`);
      if (createHash('sha256').update(body).digest('hex') !== a.sha256) throw new BadRequestException('sha256 does not match the declared hash');
      const blob = a.encrypted ? await this.crypto.cipher.encryptBytes(body, { householdId: a.householdId, table: 'attachments', column: `content:${a.id}` }) : body;
      await this.storage.put(a.storageKey, blob);
      await tx.attachment.updateMany({ where: { id }, data: { status: 'UPLOADED' } });
      return fileDto(await this.find(tx, id));
    });
  }

  @Get('files/:id/url')
  url(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const a = await this.find(tx, id);
      if (a.status !== 'UPLOADED') throw new ConflictException('the file has not been uploaded yet');
      const ttl = a.isSensitive ? 60 : 300;
      const exp = Math.floor(Date.now() / 1000) + ttl;
      if (a.isSensitive) await audit(tx, ctx, { action: 'VIEW_SENSITIVE', entityType: 'attachments', entityId: a.id, after: { category: a.category, fileName: a.fileName } });
      const token = this.storage.sign({ a: a.id, h: a.householdId, u: ctx.userId, e: exp });
      return { url: `/v1/files/${a.id}/content?token=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000).toISOString() };
    });
  }

  /** Signed link: no bearer token needed, but the requester named in the link must still pass RLS. */
  @Public()
  @Get('files/:id/content')
  async download(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(TokenQuery)) q: z.infer<typeof TokenQuery>, @Res() res: Response) {
    const c = this.storage.verify(q.token);
    if (!c || c.a !== id) throw new UnauthorizedException('link is invalid or expired');
    const { a, data } = await this.db.withRls({ userId: c.u, householdId: c.h }, async (tx) => {
      const [m] = await tx.$queryRaw<Array<{ id: string | null }>>`SELECT app.current_membership_id()::text AS id`;
      if (!m?.id) throw new UnauthorizedException('link is invalid or expired');
      const att = await tx.attachment.findFirst({ where: { id } });
      if (!att) throw new NotFoundException('file not found');
      const raw = await this.storage.get(att.storageKey);
      return { a: att, data: att.encrypted ? await this.crypto.cipher.decryptBytes(raw, { householdId: att.householdId, table: 'attachments', column: `content:${att.id}` }) : raw };
    });
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }

  @Get('staff/:staffId/files')
  staffFiles(@Ctx() ctx: RequestContext, @Param('staffId', ParseUUIDPipe) staffId: string, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.attachment.findMany({ where: { staffId, category: q.category }, orderBy: { createdAt: 'desc' } })).map(fileDto),
    }));
  }

  private async find(tx: Tx, id: string) {
    const a = await tx.attachment.findFirst({ where: { id } });
    if (!a) throw new NotFoundException('file not found');
    return a;
  }
}
