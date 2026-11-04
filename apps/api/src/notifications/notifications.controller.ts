import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { Ctx, NoHousehold } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import type { RequestContext } from '../tenancy/request-context';

const Device = z.object({ platform: z.enum(['ios', 'android', 'web']), pushToken: z.string().min(20).max(4096), appVersion: z.string().max(40).optional() }).strict();
const ListQuery = z.object({ unread: z.enum(['true', 'false']).optional() });

/** In-app inbox and push-device registration. Deliveries are written by the dispatcher only. */
@Controller()
export class NotificationsController {
  constructor(private readonly db: PrismaService) {}

  @Get('notifications')
  list(@Ctx() ctx: RequestContext, @Query(new ZodQuery(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.db.withRls(ctx, async (tx) => ({
      data: (await tx.notification.findMany({ where: { channel: 'IN_APP', ...(q.unread === 'true' ? { readAt: null } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 }))
        .map((n) => ({ id: n.id, title: n.title, body: n.body, deepLink: n.deepLink, locale: n.locale, createdAt: n.createdAt, readAt: n.readAt })),
    }));
  }

  @Post('notifications/:id/read')
  read(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const { count } = await tx.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } });
      if (!count && !(await tx.notification.findFirst({ where: { id }, select: { id: true } }))) throw new NotFoundException('notification not found');
      return { read: true };
    });
  }

  @Post('notifications/read-all')
  readAll(@Ctx() ctx: RequestContext) {
    return this.db.withRls(ctx, async (tx) => ({ read: (await tx.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } })).count }));
  }

  @NoHousehold()
  @Post('me/devices')
  register(@Ctx() ctx: RequestContext, @Body(new ZodBody(Device)) b: z.infer<typeof Device>) {
    return this.db.withRls(ctx, async (tx) => {
      // Upsert by token for this user. A token registered to ANOTHER account is invisible under RLS,
      // so the upsert is refused by RLS (403) rather than silently re-binding it.
      const d = await tx.userDevice.upsert({ where: { pushToken: b.pushToken }, create: { ...b, userId: ctx.userId }, update: { ...b, userId: ctx.userId, lastSeenAt: new Date() } });
      return { id: d.id, platform: d.platform, appVersion: d.appVersion };
    });
  }

  @NoHousehold()
  @Delete('me/devices/:id')
  unregister(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withRls(ctx, async (tx) => {
      const { count } = await tx.userDevice.deleteMany({ where: { id } });
      if (!count) throw new NotFoundException('device not found');
      return { deleted: true };
    });
  }
}
