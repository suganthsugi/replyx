import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';
import { REDIS } from '../../platform-kernel/redis/redis.module.js';

import type { NotificationEventType } from '../../platform-kernel/db/tables/notifications.js';

/**
 * Schedules push and email notifications (research D20, FR-082). The notifications consumer calls
 * this for each recipient who wants the channel; the digest job (notification-digest.job.ts)
 * sends.
 *
 * - **No duplicates**: each (recipient, domain event, channel) is claimed in
 *   `notification_deliveries` first, so a redelivered event schedules nothing.
 * - **Bursts**: a notification with a group key (customer messages on one ticket) adds to a Redis
 *   counter for (recipient, channel, group key). The first one schedules a digest job 2 minutes
 *   later; the job takes the counter and sends one message saying how many arrived. One that
 *   comes after the job took the counter starts the next digest.
 * - Without a group key the job runs straight away.
 *
 * The job is queued from inside the consumer's transaction (like the offline reply email). If that
 * transaction then fails, the retry finds the counter already started and schedules no second job,
 * so the worst case is a count one too high.
 */

export const DIGEST_JOB = 'notification_digest';
export const DIGEST_WINDOW_MS = 2 * 60_000;

export type AlertChannel = 'push' | 'email';

export interface DigestJobData {
  tenantId: string;
  recipientId: string;
  channel: AlertChannel;
  eventType: NotificationEventType;
  ticketId: string | null;
  title: string;
  summary: string | null;
  /** The burst counter to take, or `null` for a single notification. */
  countKey: string | null;
  /** Replaces an older browser notification with the same tag. */
  tag: string;
}

export interface ScheduledNotification {
  eventType: NotificationEventType;
  ticketId: string | null;
  title: string;
  summary: string | null;
  groupKey: string | null;
}

export function digestCountKey(tenantId: string, recipientId: string, channel: AlertChannel, groupKey: string): string {
  return `notify:digest:${tenantId}:${recipientId}:${channel}:${groupKey}`;
}

/** BullMQ refuses custom job ids that contain `:`. */
function jobIdPart(value: string): string {
  return value.replace(/:/g, '_');
}

@Injectable()
export class ChannelScheduler {
  constructor(
    private readonly queues: QueueRegistry,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async schedule(tx: TenantTransaction, recipientId: string, eventId: string, channel: AlertChannel, notification: ScheduledNotification): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('ChannelScheduler.schedule must run inside withTenant');
    if (!(await new DeliveryClaims(ctx).claim(tx, recipientId, eventId, channel))) return;

    const base = {
      tenantId: ctx.tenantId,
      recipientId,
      channel,
      eventType: notification.eventType,
      ticketId: notification.ticketId,
      title: notification.title,
      summary: notification.summary,
    };
    const queue = this.queues.get('notifications');

    if (notification.groupKey === null) {
      const data: DigestJobData = { ...base, countKey: null, tag: eventId };
      await queue.add(DIGEST_JOB, data, { jobId: `notify.${channel}.${ctx.tenantId}.${recipientId}.${eventId}` });
      return;
    }

    const countKey = digestCountKey(ctx.tenantId, recipientId, channel, notification.groupKey);
    const count = await this.redis.incr(countKey);
    if (count !== 1) return;
    // A safety net only: the job takes the counter after the window.
    await this.redis.pexpire(countKey, DIGEST_WINDOW_MS * 5);
    const data: DigestJobData = { ...base, countKey, tag: notification.groupKey };
    await queue.add(DIGEST_JOB, data, {
      delay: DIGEST_WINDOW_MS,
      jobId: `notify.${channel}.${ctx.tenantId}.${recipientId}.${jobIdPart(notification.groupKey)}.${eventId}`,
    });
  }
}

class DeliveryClaims extends TenantRepository {
  /** False when this recipient already has this event on this channel (a redelivery). */
  async claim(tx: TenantTransaction, recipientId: string, eventId: string, channel: AlertChannel): Promise<boolean> {
    const claimed = await this.insertInto(tx, 'notification_deliveries', {
      recipient_id: recipientId,
      event_id: eventId,
      channel,
      status: 'pending',
      sent_at: null,
    })
      .onConflict((oc) => oc.doNothing())
      .returning('event_id')
      .executeTakeFirst();
    return claimed !== undefined;
  }
}
