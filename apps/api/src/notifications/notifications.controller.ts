import { Body, Controller, Get, HttpCode, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission, StaffApi } from '../authorization/registry/module-permissions.js';
import { NOTIFICATION_EVENT_TYPES } from '../platform-kernel/db/tables/notifications.js';
import { paginationQuery } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { NotificationsService, type NotificationDefaults, type NotificationPage } from './notifications.service.js';

import type { ResolvedPreferences } from './notification-preferences.js';
import type { Request } from 'express';

/**
 * `/notifications`, `/notifications/read` and `/notification-preferences`
 * (contracts/operations.yaml, T164). `@StaffApi()`: every staff user has their own notification
 * center and preferences, with no permission key (route-audit.ts allows these two segments).
 * US15 (T243) adds `POST /notification-preferences/push-subscriptions` and
 * `GET /notification-preferences/push-key`, and the tenant defaults at `/notification-defaults`
 * (`tenant_settings.view` / `tenant_settings.edit`).
 *
 * A push endpoint is a URL the worker posts to, so only `https` URLs on a host name are accepted
 * (no IP literals, no localhost): a staff user can't point the worker at an internal address.
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

const MAX_BASE64URL = 512;
const Base64Url = z.string().min(1).max(MAX_BASE64URL).regex(/^[A-Za-z0-9_-]+=*$/, { message: 'invalid_format' });

function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  // IPv4 literals and bracketed IPv6 literals.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return false;
  return host.includes('.');
}

const PushSubscriptionBody = z
  .object({
    endpoint: z.string().max(2048).refine(isPublicHttpsUrl, { message: 'invalid_format' }),
    keys: z.object({ p256dh: Base64Url, auth: Base64Url }).strict(),
  })
  .strict();

const DefaultsBody = z.object({ events: z.partialRecord(z.enum(NOTIFICATION_EVENT_TYPES), Toggles) }).strict();

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

  @Post('notification-preferences/push-subscriptions')
  @StaffApi()
  @HttpCode(204)
  async registerPushSubscription(@Req() req: Request, @Body(new ZodValidationPipe(PushSubscriptionBody)) body: z.infer<typeof PushSubscriptionBody>): Promise<void> {
    await this.notifications.registerPushSubscription(tenantContextOf(req), body);
  }

  @Get('notification-preferences/push-key')
  @StaffApi()
  pushKey(): { publicKey: string | null } {
    return this.notifications.pushPublicKey();
  }

  @Get('notification-defaults')
  @RequirePermission('tenant_settings.view')
  defaults(@Req() req: Request): Promise<NotificationDefaults> {
    return this.notifications.defaults(tenantContextOf(req));
  }

  @Put('notification-defaults')
  @RequirePermission('tenant_settings.edit')
  saveDefaults(@Req() req: Request, @Body(new ZodValidationPipe(DefaultsBody)) body: z.infer<typeof DefaultsBody>): Promise<NotificationDefaults> {
    return this.notifications.saveDefaults(tenantContextOf(req), body.events);
  }
}
