import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { toNotificationDto, type NotificationDto, type NotificationRow } from './notification-dto.js';
import { NotificationPreferencesRepository, type PartialEvents, type ResolvedPreferences } from './notification-preferences.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The caller's own notification center and preferences (contracts/operations.yaml
 * `/notifications*`, `/notification-preferences`, FR-078, FR-080, FR-083, T164). Everything is
 * scoped to the signed-in staff user: another user's notification ids are simply not theirs, so
 * marking them read changes nothing.
 *
 * Newest first by id (UUIDv7, so creation order). Marking read announces `notification.read` with
 * the new unread count on the user's stream, so every open session updates (FR-083).
 */

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
