import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { Category } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const Create = z.object({ kind: z.enum(['EXPENSE', 'INCOME']), name: z.string().trim().min(1).max(60), parentId: z.guid().optional(),
  icon: z.string().max(30).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), sortOrder: z.number().int().optional() }).strict();
const Update = z.object({ name: z.string().trim().min(1).max(60).optional(), parentId: z.guid().nullable().optional(),
  icon: z.string().max(30).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), sortOrder: z.number().int().optional() }).strict();
const ListQuery = z.object({ kind: z.enum(['EXPENSE', 'INCOME']).optional() });

const dto = (c: Category, locale: RequestContext['locale']) => ({ id: c.id, kind: c.kind, parentId: c.parentId, name: resolveI18n(c.nameI18n as I18nText, { locale }).text,
  nameI18n: c.nameI18n, icon: c.icon, color: c.color, isSystem: c.isSystem, sortOrder: c.sortOrder });

@Controller('categories')
export class CategoriesController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.category.findMany({ where: { kind: q.kind }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })).map((c) => dto(c, ctx.locale)),
    }));
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(Create)) b: z.infer<typeof Create>) {
    return this.db.withRls(ctx, async (tx) => {
      const { name, ...rest } = b;
      if (b.parentId) {
        const p = await tx.category.findFirst({ where: { id: b.parentId } });
        if (!p) throw new NotFoundException('parent category not found');
        if (p.kind !== b.kind) throw new NotFoundException('parent category must be of the same kind');
      }
      return dto(await tx.category.create({ data: { ...rest, householdId: ctx.householdId!, nameI18n: { [ctx.locale]: name } } }), ctx.locale);
    });
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(Update)) b: z.infer<typeof Update>) {
    return this.db.withRls(ctx, async (tx) => {
      const c = await tx.category.findFirst({ where: { id } });
      if (!c) throw new NotFoundException('category not found');
      const { name, ...rest } = b;
      const { count } = await tx.category.updateMany({ where: { id }, data: { ...rest, ...(name ? { nameI18n: { ...(c.nameI18n as object), [ctx.locale]: name } } : {}) } });
      await assertWritten(count, async () => c, 'category');
      return dto((await tx.category.findFirst({ where: { id } }))!, ctx.locale);
    });
  }

  @Delete(':id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const c = await tx.category.findFirst({ where: { id } });
      if (!c) throw new NotFoundException('category not found');
      const { count } = await tx.category.deleteMany({ where: { id } });
      await assertWritten(count, async () => c, 'category (system categories cannot be deleted)');
      return { deleted: true };
    });
  }
}
