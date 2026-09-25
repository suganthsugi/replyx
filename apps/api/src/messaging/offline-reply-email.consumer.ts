import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Redis } from 'ioredis';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { tenantUrl } from '../platform-kernel/http/public-url.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';
import { MailQueue } from '../platform-kernel/mail/mail.service.js';
import { PresenceService } from '../platform-kernel/realtime/presence.service.js';
import { REDIS } from '../platform-kernel/redis/redis.module.js';
import { TenantSettingsRepository } from '../tenancy/tenant-settings.js';

import type { DomainEventType } from '../platform-kernel/outbox/event-types.js';

/**
 * Tells a customer who isn't in the chat that support replied (FR-055, spec US1 scenario 7).
 *
 * On `message.created` for a **public staff reply** only (internal notes never notify
 * customers), and only when the tenant's `offline_customer_notification` is `email`, the
 * customer's `emailOnReply` is on and none of their sockets is connected: one email with a link
 * back to the chat. A burst of replies sends one email per customer per 2 minutes (a Redis
 * marker, so a job that already completed still counts). The email names the agent but never
 * quotes the reply or mentions tickets.
 *
 * The email job is queued from inside the consumer's transaction; if that transaction then
 * fails, the retry finds the 2-minute marker and doesn't queue a second one.
 */

export const REPLY_EMAIL_WINDOW_MS = 2 * 60_000;

type Handled = Extract<DomainEventType, 'message.created'>;

export function replyEmailMarker(tenantId: string, customerId: string): string {
  return `mail:reply:${tenantId}:${customerId}`;
}

@Injectable()
export class OfflineReplyEmailConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'offline-reply-email';
  readonly queue = 'notifications' as const;
  readonly eventTypes: readonly Handled[] = ['message.created'];
  private readonly logger = new Logger('OfflineReplyEmailConsumer');

  constructor(
    unitOfWork: UnitOfWork,
    private readonly presence: PresenceService,
    private readonly mail: MailQueue,
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const message = event.payload;
    if (message.visibility !== 'public' || message.authorKind !== 'staff') return;
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('OfflineReplyEmailConsumer.handle must run inside withTenant');

    const settings = await new TenantSettingsRepository(ctx).conversation(tx);
    if (settings.offlineCustomerNotification !== 'email') return;
    const recipient = await new ReplyRecipientRepository(ctx).forTicket(tx, message.ticketId);
    if (recipient?.status !== 'active' || recipient.kind !== 'customer' || recipient.email_on_reply === false) return;
    if (await this.presence.isConnected(ctx.tenantId, recipient.id)) return;

    const marker = await this.redis.set(replyEmailMarker(ctx.tenantId, recipient.id), '1', 'PX', REPLY_EMAIL_WINDOW_MS, 'NX');
    if (marker !== 'OK') return;

    const agent = message.author?.name ?? 'Support';
    await this.mail.enqueue(
      {
        tenantId: ctx.tenantId,
        to: recipient.email,
        template: 'support-reply',
        workspaceName: settings.workspaceName,
        vars: { agentName: agent, chatUrl: tenantUrl(recipient.slug, '/') },
      },
      { dedupeKey: `reply.${ctx.tenantId}.${recipient.id}.${Math.floor(this.clock.nowMs() / REPLY_EMAIL_WINDOW_MS)}` },
    );
    this.logger.log(`Queued an offline reply email (event ${event.id})`);
  }
}

class ReplyRecipientRepository extends TenantRepository {
  async forTicket(tx: TenantTransaction, ticketId: string) {
    const row = await this.selectFrom(tx, 'tickets')
      .innerJoin('users', (join) => join.onRef('users.tenant_id', '=', 'tickets.tenant_id').onRef('users.id', '=', 'tickets.customer_id'))
      .leftJoin('customer_profiles', (join) =>
        join.onRef('customer_profiles.tenant_id', '=', 'users.tenant_id').onRef('customer_profiles.user_id', '=', 'users.id'),
      )
      .select(['users.id', 'users.email', 'users.status', 'users.kind', 'customer_profiles.email_on_reply'])
      .where('tickets.id', '=', ticketId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    // `tenants` is global and readable by the app role.
    const tenant = await tx.selectFrom('tenants').select('slug').where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
    return { ...row, slug: tenant.slug };
  }
}

/** Messaging consumers (worker process only). */
@Module({ providers: [PresenceService, OfflineReplyEmailConsumer] })
export class MessagingJobsModule {}
