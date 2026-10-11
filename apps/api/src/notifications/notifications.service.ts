import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { PushSubscriptionsRepository, type PushSubscription } from './channels/push-subscriptions.js';
import { vapidPublicKey } from './channels/push.channel.js';
import { toNotificationDto, type NotificationDto, type NotificationRow } from './notification-dto.js';
import { NotificationPreferencesRepository, type ChannelToggles, type PartialEvents, type ResolvedPreferences } from './notification-preferences.js';

import type { NotificationEventType } from '../platform-kernel/db/tables/notifications.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The caller's own notification center and preferences (contracts/operations.yaml
 * `/notifications*`, `/notification-preferences`, FR-078, FR-080, FR-083, T164). Everything is
 * scoped to the signed-in staff user: another user's notification ids are simply not theirs, so
 * marking them read changes nothing.
 *
 * Newest first by id (UUIDv7, so creation order). Marking read announces `notification.read` with
 * the new unread count on the user's stream, so every open session updates (FR-083).
 *
 * US15 (T243): the caller registers browser push subscriptions here and reads the VAPID public key
 * the browser needs to subscribe. The tenant's defaults (`/notification-defaults`, FR-080) are
 * edited by `tenant_settings.edit` holders and audited as `notification_defaults.changed`.
 */

export type NotificationDefaults = { events: Record<NotificationEventType, ChannelToggles> };

const Cursor = z.object({ id: z.uuid() }).strict();

export interface NotificationListQuery {
  limit: number;
  cursor?: string;
  unread?: boolean;
}

export type NotificationPage = Page<NotificationDto> & { unreadCount: number };

export type MarkRead = { ids: string[] } | { all: true };

function userIdOf(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new Error('Notifications belong to user actors');
  return ctx.actor.id;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  list(ctx: TenantContext, query: NotificationListQuery): Promise<NotificationPage> {
    const userId = userIdOf(ctx);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, Cursor).id;
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new NotificationsRepository(ctx);
      const rows = await repo.list(tx, userId, { limit: query.limit + 1, after, unreadOnly: query.unread === true });
      const page = toPage(rows, query.limit, (row) => ({ id: row.id }), toNotificationDto);
      return { ...page, unreadCount: await repo.unreadCount(tx, userId) };
    });
  }

  markRead(ctx: TenantContext, input: MarkRead): Promise<{ unreadCount: number }> {
    const userId = userIdOf(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new NotificationsRepository(ctx);
      const ids = 'all' in input ? 'all' : [...new Set(input.ids)];
      const marked = await repo.markRead(tx, userId, ids, this.clock.now());
      const unreadCount = await repo.unreadCount(tx, userId);
      if (marked.length > 0) {
        await this.outbox.append(tx, {
          type: 'notification.read',
          payload: { ids: ids === 'all' ? 'all' : marked, unreadCount },
          streams: [`user:${userId}`],
        });
      }
      return { unreadCount };
    });
  }

  preferences(ctx: TenantContext): Promise<ResolvedPreferences> {
    const userId = userIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const resolved = (await new NotificationPreferencesRepository(ctx).forUsers(tx, [userId])).get(userId);
      if (resolved === undefined) throw new Error('Preferences resolve for every requested user');
      return resolved;
    });
  }

  /** Replaces the user's choices: events left out fall back to the tenant defaults again. */
  savePreferences(ctx: TenantContext, input: { enabled: boolean; events: PartialEvents }): Promise<ResolvedPreferences> {
    const userId = userIdOf(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new NotificationPreferencesRepository(ctx);
      await repo.save(tx, userId, input.enabled, input.events);
      const resolved = (await repo.forUsers(tx, [userId])).get(userId);
      if (resolved === undefined) throw new Error('Preferences resolve for every requested user');
      return resolved;
    });
  }

  registerPushSubscription(ctx: TenantContext, subscription: PushSubscription): Promise<void> {
    const userId = userIdOf(ctx);
    return this.unitOfWork.withTenant(ctx, (tx) => new PushSubscriptionsRepository(ctx).add(tx, userId, subscription));
  }

  /** `null` when push is not set up on this server (no VAPID keys). */
  pushPublicKey(): { publicKey: string | null } {
    return { publicKey: vapidPublicKey() };
  }

  defaults(ctx: TenantContext): Promise<NotificationDefaults> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => ({ events: await new NotificationPreferencesRepository(ctx).resolvedTenantDefaults(tx) }));
  }

  /** Events or channels left out keep their current default. */
  saveDefaults(ctx: TenantContext, events: PartialEvents): Promise<NotificationDefaults> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new NotificationPreferencesRepository(ctx);
      const before = await repo.resolvedTenantDefaults(tx);
      const after = { ...before };
      for (const [event, toggles] of Object.entries(events) as [NotificationEventType, Partial<ChannelToggles>][]) {
        after[event] = { ...before[event], ...toggles };
      }
      const changed = Object.fromEntries(
        (Object.keys(after) as NotificationEventType[])
          .filter((event) => JSON.stringify(before[event]) !== JSON.stringify(after[event]))
          .map((event) => [event, { old: { ...before[event] }, new: { ...after[event] } }]),
      );
      if (Object.keys(changed).length > 0) {
        await repo.saveTenantDefaults(tx, after);
        await this.audit.record(tx, { action: 'notification_defaults.changed', resourceType: 'tenant_settings', resourceId: ctx.tenantId, details: changed });
      }
      return { events: after };
    });
  }
}

class NotificationsRepository extends TenantRepository {
  list(tx: TenantTransaction, userId: string, options: { limit: number; after?: string; unreadOnly: boolean }): Promise<NotificationRow[]> {
    let query = this.selectFrom(tx, 'notifications')
      .select(['id', 'event_type', 'title', 'summary', 'ticket_id', 'count', 'read_at', 'created_at'])
      .where('notifications.recipient_id', '=', userId);
    if (options.unreadOnly) query = query.where('notifications.read_at', 'is', null);
    if (options.after !== undefined) query = query.where('notifications.id', '<', options.after);
    return query.orderBy('notifications.id', 'desc').limit(options.limit).execute();
  }

  async unreadCount(tx: TenantTransaction, userId: string): Promise<number> {
    const row = await this.selectFrom(tx, 'notifications')
      .select(sql<string>`count(*)`.as('count'))
      .where('notifications.recipient_id', '=', userId)
      .where('notifications.read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** The ids that were unread and are now read. */
  async markRead(tx: TenantTransaction, userId: string, ids: string[] | 'all', now: Date): Promise<string[]> {
    if (ids !== 'all' && ids.length === 0) return [];
    let query = this.updateTable(tx, 'notifications')
      .set({ read_at: now })
      .where('notifications.recipient_id', '=', userId)
      .where('notifications.read_at', 'is', null);
    if (ids !== 'all') query = query.where('notifications.id', 'in', ids);
    const rows = await query.returning('id').execute();
    return rows.map((row) => row.id);
  }
}
