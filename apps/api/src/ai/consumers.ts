import { Injectable } from '@nestjs/common';

import { Clock } from '../platform-kernel/clock.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';
import { QueueRegistry } from '../platform-kernel/jobs/queues.js';
import { TicketsRepository } from '../tickets/tickets.repository.js';

import { AiTicketStatus } from './assistant/ai-ticket-status.js';
import { AI_TURN_JOB, TURN_ATTEMPTS, TURN_BACKOFF_MS, TURN_DELAY_MS, turnDeduplicationId, type AiTurnJobData } from './assistant/ai-turn.job.js';
import { AiDraftsRepository, AiTicketStateRepository, AssistantConversationRepository } from './assistant/assistant.repositories.js';
import { ResponderService } from './assistant/responder.js';
import { AiSettingsRepository } from './settings/ai-settings.repository.js';

import type { MessageDto } from '../messaging/message-dto.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { DomainEventType } from '../platform-kernel/outbox/event-types.js';

type Handled = Extract<DomainEventType, 'message.created'>;

/**
 * Turns a public customer message into the `ai-turn` job (specs/002-ai-assist research R6). It
 * enqueues only when the assistant is handling the ticket (`AiTicketStatus`): AI active, mode not
 * Off, ticket not stopped.
 *
 * The job is debounced per ticket: BullMQ deduplication with `ttl` = delay, `extend` and `replace`
 * moves the single pending job to 3 s after the latest message, so three messages in two seconds
 * make one turn. Enqueueing is idempotent for a redelivered event: the same event replaces the
 * pending job with an equal one. The model is never called here: that would hold this
 * transaction open across the provider call.
 */
@Injectable()
export class AiTriggerConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'ai-trigger';
  readonly queue = 'ai' as const;
  readonly eventTypes: readonly Handled[] = ['message.created'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly status: AiTicketStatus,
    private readonly queues: QueueRegistry,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const message = event.payload;
    if (message.authorKind !== 'customer' || message.visibility !== 'public') return;
    if (!(await this.status.isAssistantHandling(tx, message.ticketId))) return;

    const data: AiTurnJobData = { tenantId: event.tenantId, ticketId: message.ticketId };
    await this.queues.get('ai').add(AI_TURN_JOB, data, {
      delay: TURN_DELAY_MS,
      attempts: TURN_ATTEMPTS,
      backoff: { type: 'exponential', delay: TURN_BACKOFF_MS },
      deduplication: { id: turnDeduplicationId(event.tenantId, message.ticketId), ttl: TURN_DELAY_MS, extend: true, replace: true },
    });
  }
}

/**
 * A staff public reply stops the assistant's posting on the ticket (FR-016): it records
 * `agent_replied_at` (and the stop reason, unless the ticket was already handed off or taken
 * over), closes the ticket's open draft (`sent` when the reply carried the draft's id, else
 * `superseded`) and announces the new responder when it changed.
 *
 * Tenants that never set up AI (no `ai_settings` row) are skipped, so they gain no rows.
 */
@Injectable()
export class StaffReplyConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'ai-staff-reply';
  readonly queue = 'ai' as const;
  readonly eventTypes: readonly Handled[] = ['message.created'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly responders: ResponderService,
    private readonly clock: Clock,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const message = event.payload;
    if (message.authorKind !== 'staff' || message.visibility !== 'public') return;
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('StaffReplyConsumer.handle must run inside withTenant');
    if ((await new AiSettingsRepository(ctx).find(tx)) === undefined) return;
    // Deleted meanwhile: nothing to stop.
    if ((await new TicketsRepository(ctx).find(tx, message.ticketId)) === undefined) return;

    const before = await this.responders.current(tx, ctx, message.ticketId);
    const now = this.clock.now();
    await new AiTicketStateRepository(ctx).recordAgentReply(tx, message.ticketId, now);
    await new AiDraftsRepository(ctx).resolveOpen(tx, message.ticketId, {
      aiDraftId: await this.aiDraftIdOf(tx, ctx, message),
      resolvedBy: message.author?.id ?? null,
      now,
    });
    await this.responders.emitIfChanged(tx, ctx, message.ticketId, before);
  }

  /**
   * The draft the reply was composed from: `POST /tickets/{id}/messages` validated `aiDraftId` and
   * stored it in the message metadata (not in the event payload, which is the staff `Message`
   * DTO). A reply without one leaves the open draft `superseded`.
   */
  private async aiDraftIdOf(tx: TenantTransaction, ctx: TenantContext, message: MessageDto): Promise<string | null> {
    const candidate = await new AssistantConversationRepository(ctx).aiDraftIdOf(tx, message.id);
    return candidate !== null && UUID.test(candidate) ? candidate : null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
