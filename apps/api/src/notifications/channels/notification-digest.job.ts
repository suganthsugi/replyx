import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { Clock } from '../../platform-kernel/clock.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { REDIS } from '../../platform-kernel/redis/redis.module.js';
import { TenantSettingsRepository } from '../../tenancy/tenant-settings.js';
import { NotificationPreferencesRepository, wants } from '../notification-preferences.js';

import { DIGEST_JOB, type AlertChannel, type DigestJobData } from './channel-scheduler.js';
import { EmailChannel, type EmailRecipient } from './email.channel.js';
import { PushChannel } from './push.channel.js';

import type { ChannelMessage } from './channel-message.js';
import type { Job } from 'bullmq';

/**
 * Sends one scheduled push or email notification (channel-scheduler.ts), in the worker.
 *
 * At send time it checks again that the tenant is active, the recipient is an active staff user
 * and still wants this event on this channel (they may have turned the master switch off during
 * the 2-minute window). A burst becomes one message: "… (3 messages)". The recipient's pending
 * deliveries on the channel are then marked sent (or skipped).
 */

/** Where a click goes: the desk resolves `?ticket=` to the ticket in the first view. */
export function ticketPath(ticketId: string | null): string {
  return ticketId === null ? '/desk/notifications' : `/desk/inbox?ticket=${encodeURIComponent(ticketId)}`;
}

export function digestTitle(title: string, count: number): string {
  return count > 1 ? `${title} (${count} messages)` : title;
}

@Injectable()
export class NotificationDigestJob extends JobProcessor<DigestJobData> {
  readonly queue = 'notifications' as const;
  readonly jobName = DIGEST_JOB;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly push: PushChannel,
    private readonly email: EmailChannel,
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async process(data: DigestJobData, job: Job<DigestJobData>): Promise<void> {
    // Taken first: anything arriving from now on starts the next digest.
    const taken = data.countKey === null ? null : await this.redis.getdel(data.countKey);
    const count = Math.max(1, Number(taken ?? 1) || 1);
    const ctx = TenantContext.create({ tenantId: data.tenantId, actor: { kind: 'system' }, requestId: `notify-${uuidv7()}` });

    const recipient = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const found = await new DigestRepository(ctx).recipient(tx, data.recipientId);
      if (found === undefined) return undefined;
      const preferences = (await new NotificationPreferencesRepository(ctx).forUsers(tx, [data.recipientId])).get(data.recipientId);
      if (preferences === undefined || !wants(preferences, data.eventType, data.channel)) return undefined;
      const settings = await new TenantSettingsRepository(ctx).conversation(tx);
      return { ...found, workspaceName: settings.workspaceName };
    });
    if (recipient === undefined) {
      await this.markDeliveries(ctx, data.recipientId, data.channel, 'skipped');
      return;
    }

    const message: ChannelMessage = {
      title: digestTitle(data.title, count),
      body: data.summary,
      url: ticketPath(data.ticketId),
      tag: data.tag,
    };
    if (data.channel === 'push') {
      await this.push.send(ctx, data.recipientId, message);
    } else {
      const to: EmailRecipient = { email: recipient.email, tenantSlug: recipient.slug, workspaceName: recipient.workspaceName };
      await this.email.send(data.tenantId, to, message, `notify.${job.id ?? `${data.recipientId}.${data.tag}`}`);
    }
    await this.markDeliveries(ctx, data.recipientId, data.channel, 'sent');
  }

  private async markDeliveries(ctx: TenantContext, recipientId: string, channel: AlertChannel, status: 'sent' | 'skipped'): Promise<void> {
    const now = this.clock.now();
    await this.unitOfWork.withTenant(ctx, (tx) => new DigestRepository(ctx).markPending(tx, recipientId, channel, status, now));
  }
}

class DigestRepository extends TenantRepository {
  /** The recipient when the tenant is active and they are an active staff user. */
  async recipient(tx: TenantTransaction, userId: string): Promise<{ email: string; slug: string } | undefined> {
    const user = await this.selectFrom(tx, 'users')
      .select(['users.email'])
      .where('users.id', '=', userId)
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'staff')
      .executeTakeFirst();
    if (user === undefined) return undefined;
    // `tenants` is global and readable by the app role.
    const tenant = await tx.selectFrom('tenants').select(['slug', 'status']).where('id', '=', this.ctx.tenantId).executeTakeFirst();
    if (tenant?.status !== 'active') return undefined;
    return { email: user.email, slug: tenant.slug };
  }

  async markPending(tx: TenantTransaction, recipientId: string, channel: AlertChannel, status: 'sent' | 'skipped', now: Date): Promise<void> {
    await this.updateTable(tx, 'notification_deliveries')
      .set({ status, sent_at: status === 'sent' ? now : null })
      .where('notification_deliveries.recipient_id', '=', recipientId)
      .where('notification_deliveries.channel', '=', channel)
      .where('notification_deliveries.status', '=', 'pending')
      .execute();
  }
}
