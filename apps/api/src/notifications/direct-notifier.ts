import { Injectable } from '@nestjs/common';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { toNotificationDto, type NotificationRow } from './notification-dto.js';
import { NotificationPreferencesRepository, wants } from './notification-preferences.js';

import type { NotificationEventType } from '../platform-kernel/db/tables/notifications.js';

export interface DirectNotification {
  eventType: NotificationEventType;
  title: string;
  summary?: string | null;
  /** The domain event this notification is for; one delivery per (recipient, event). */
  eventId: string;
}

/**
 * In-app notifications that are not about a ticket (spec 002 `ai.paused`), written in the caller's
 * transaction instead of by the ticket-centric notifications consumer. Recipients are chosen by the
 * caller; in-app preferences, the per-event delivery claim and the `notification.created`
 * announcement work as in notifications.consumer.ts.
 */
@Injectable()
export class DirectNotifier {
  constructor(
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async notify(tx: TenantTransaction, recipientIds: readonly string[], notification: DirectNotification): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('DirectNotifier.notify must run inside withTenant');
    const preferences = await new NotificationPreferencesRepository(ctx).forUsers(tx, recipientIds);
    const repo = new DirectNotificationsRepository(ctx);
    for (const recipientId of recipientIds) {
      const resolved = preferences.get(recipientId);
      if (resolved === undefined || !wants(resolved, notification.eventType, 'in_app')) continue;
      if (!(await repo.claimDelivery(tx, recipientId, notification.eventId, this.clock.now()))) continue;
      const row = await repo.insert(tx, recipientId, notification);
      await this.outbox.append(tx, { type: 'notification.created', payload: toNotificationDto(row), streams: [`user:${recipientId}`] });
    }
  }
}

class DirectNotificationsRepository extends TenantRepository {
  async claimDelivery(tx: TenantTransaction, recipientId: string, eventId: string, now: Date): Promise<boolean> {
    const claimed = await this.insertInto(tx, 'notification_deliveries', {
      recipient_id: recipientId,
      event_id: eventId,
      channel: 'in_app',
      status: 'sent',
      sent_at: now,
    })
      .onConflict((oc) => oc.doNothing())
      .returning('event_id')
      .executeTakeFirst();
    return claimed !== undefined;
  }

  insert(tx: TenantTransaction, recipientId: string, notification: DirectNotification): Promise<NotificationRow> {
    return this.insertInto(tx, 'notifications', {
      recipient_id: recipientId,
      event_type: notification.eventType,
      ticket_id: null,
      group_key: null,
      title: notification.title,
      summary: notification.summary ?? null,
      event_id: notification.eventId,
    })
      .returning(['id', 'event_type', 'title', 'summary', 'ticket_id', 'count', 'read_at', 'created_at'])
      .executeTakeFirstOrThrow();
  }
}
