import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { resolveI18n, type I18nText } from '@herp/i18n';
import type { HouseholdTask } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { Ctx } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { assertWritten } from '../common/rls-write';
import type { RequestContext } from '../tenancy/request-context';

const CreateTask = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), assigneeId: z.guid().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(), recurrence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']).optional(),
}).strict();
const UpdateTask = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), assigneeId: z.guid().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(), status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  proofPhotoUrl: z.string().url().optional(),
}).strict();
const ListQuery = z.object({ assignee: z.string().optional(), status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional() });

const dto = (t: HouseholdTask, locale: RequestContext['locale']) => {
  const title = resolveI18n(t.titleI18n as I18nText, { locale, originalLocale: Object.keys(t.titleI18n as object)[0] as never });
  return { id: t.id, title: title.text, titleTranslated: title.translated, titleI18n: t.titleI18n, description: t.description,
           assigneeId: t.assigneeId, createdById: t.createdById, status: t.status, dueAt: t.dueAt, recurrence: t.recurrence,
           completedAt: t.completedAt, proofPhotoUrl: t.proofPhotoUrl, createdAt: t.createdAt };
};

/** Chores for staff and children. Assignees may only move status and attach photo proof (DB trigger). */
@Controller('tasks')
export class TasksController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.householdTask.findMany({
        where: { status: q.status, assigneeId: q.assignee === 'me' ? ctx.membershipId : q.assignee },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }], take: 500,
      })).map((t) => dto(t, ctx.locale)),
    }));
  }

  /** Title is stored in the creator's language; translations are added under titleI18n by the translation worker. */
  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodBody(CreateTask)) b: z.infer<typeof CreateTask>) {
    return this.db.withRls(ctx, async (tx) => dto(await tx.householdTask.create({ data: {
      householdId: ctx.householdId!, createdById: ctx.membershipId!, titleI18n: { [ctx.locale]: b.title }, description: b.description,
      assigneeId: b.assigneeId, dueAt: b.dueAt ? new Date(b.dueAt) : undefined, recurrence: b.recurrence,
    } }), ctx.locale));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(UpdateTask)) b: z.infer<typeof UpdateTask>) {
    return this.db.withRls(ctx, async (tx) => {
      const t = await tx.householdTask.findFirst({ where: { id } });
      if (!t) throw new NotFoundException('task not found');
      const { title, dueAt, ...rest } = b;
      const { count } = await tx.householdTask.updateMany({ where: { id }, data: {
        ...rest, ...(dueAt ? { dueAt: new Date(dueAt) } : {}), ...(title ? { titleI18n: { [ctx.locale]: title } } : {}) } });
      await assertWritten(count, async () => t, 'task');
      return dto((await tx.householdTask.findFirst({ where: { id } }))!, ctx.locale);
    });
  }

  @Delete(':id')
  remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const t = await tx.householdTask.findFirst({ where: { id } });
      if (!t) throw new NotFoundException('task not found');
      const { count } = await tx.householdTask.deleteMany({ where: { id } });
      await assertWritten(count, async () => t, 'task');
      return { deleted: true };
    });
  }
}
