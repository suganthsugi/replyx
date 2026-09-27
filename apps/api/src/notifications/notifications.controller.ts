import { Body, Controller, Get, HttpCode, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { StaffApi } from '../authorization/registry/module-permissions.js';
import { NOTIFICATION_EVENT_TYPES } from '../platform-kernel/db/tables/notifications.js';
import { paginationQuery } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { NotificationsService, type NotificationPage } from './notifications.service.js';

import type { ResolvedPreferences } from './notification-preferences.js';
import type { Request } from 'express';

/**
 * `/notifications`, `/notifications/read` and `/notification-preferences`
 * (contracts/operations.yaml, T164). `@StaffApi()`: every staff user has their own notification
 * center and preferences, with no permission key (route-audit.ts allows these two segments).
 * `POST /notification-preferences/push-subscriptions` arrives with push delivery in US15.
 */

const ListQuery = z
  .object({
    ...paginationQuery,
    unread: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  })
  .strict();

const MarkReadBody = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

const Toggles = z.object({ inApp: z.boolean().optional(), push: z.boolean().optional(), email: z.boolean().optional() }).strict();

const PreferencesBody = z
  .object({
    enabled: z.boolean(),
    events: z.partialRecord(z.enum(NOTIFICATION_EVENT_TYPES), Toggles),
  })
  .strict();

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @StaffApi()
  list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<NotificationPage> {
    return this.notifications.list(tenantContextOf(req), query);
  }

  @Post('notifications/read')
  @StaffApi()
  @HttpCode(200)
  markRead(@Req() req: Request, @Body(new ZodValidationPipe(MarkReadBody)) body: z.infer<typeof MarkReadBody>): Promise<{ unreadCount: number }> {
    return this.notifications.markRead(tenantContextOf(req), body);
  }

  @Get('notification-preferences')
  @StaffApi()
  preferences(@Req() req: Request): Promise<ResolvedPreferences> {
    return this.notifications.preferences(tenantContextOf(req));
  }

  @Put('notification-preferences')
  @StaffApi()
  savePreferences(@Req() req: Request, @Body(new ZodValidationPipe(PreferencesBody)) body: z.infer<typeof PreferencesBody>): Promise<ResolvedPreferences> {
    return this.notifications.savePreferences(tenantContextOf(req), body);
  }
}
