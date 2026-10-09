import { Injectable } from '@nestjs/common';

import { Clock } from '../platform-kernel/clock.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { TicketsRepository } from '../tickets/tickets.repository.js';

import { toMessageDto, type MessageDto } from './message-dto.js';
import { MessagesRepository } from './messages.repository.js';
import { PublicReplyService } from './public-reply.service.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Writes the AI assistant's public messages (spec 002 FR-012, FR-029, research R14). Exported by
 * `MessagingModule` for the AI turn job's write phase (T021), which calls `write` inside its own
 * `withTenant` transaction so the message, the ticket update and the outbox events commit
 * together with the job's `ai_turns` row.
 *
 * It goes through the same reply path as a staff public reply (`PublicReplyService`):
 *
 * - `kind: 'answer'` counts as a reply. It sets `first_agent_reply_at` (once) and
 *   `last_agent_reply_at`, moves `waiting_on` to `customer` and `new` to `open`, so the SLA first
 *   response and next response clocks stop exactly as for an agent.
 * - `kind: 'handoff'` is the fixed hand-off notice. It is stored with `metadata.handoff = true`
 *   and reaches the ticket and the customer, but changes no timers or `waiting_on`, so it never
 *   meets an SLA target.
 *
 * The message has no author row (`author_id` is null, `author_kind = 'assistant'`). Retries are
 * idempotent on `(ticketId, clientMessageId)`: the second call returns the first message and
 * emits nothing. Callers should still guard the turn itself (`ai_turns`), and are responsible for
 * the stop rules (staff replied, taken over); the writer does not check them. It only writes to
 * the ticket it is given, inside the transaction's tenant.
 */

export interface AssistantMessageInput {
  ticketId: string;
  body: string;
  /** Idempotency key for this message, 1 to 100 chars, e.g. `ai-turn:{turnId}` or `ai-handoff:{turnId}`. */
  clientMessageId: string;
  kind: 'answer' | 'handoff';
}

/** `ticket_messages_body_length` allows 1 to 10000 characters. */
const MAX_BODY_LENGTH = 10_000;

function requireScope(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('AssistantMessageWriter.write must run inside withTenant');
  return ctx;
}

@Injectable()
export class AssistantMessageWriter {
  constructor(
    private readonly replies: PublicReplyService,
    private readonly clock: Clock,
  ) {}

  async write(tx: TenantTransaction, input: AssistantMessageInput): Promise<MessageDto> {
    const ctx = requireScope(tx);
    const body = input.body.trim().slice(0, MAX_BODY_LENGTH);
    if (body.length === 0) throw new Error('An assistant message needs a body');
    if (input.clientMessageId.length < 1 || input.clientMessageId.length > 100) throw new Error('clientMessageId must be 1 to 100 characters');

    // Locking also serializes two writers on one ticket, so the idempotency check below is safe.
    const ticket = await new TicketsRepository(ctx).lock(tx, input.ticketId);
    if (ticket === undefined) throw notFound('ticket');

    const messages = new MessagesRepository(ctx);
    const existing = await messages.findAssistantByClientMessageId(tx, ticket.id, input.clientMessageId);
    if (existing !== undefined) return toMessageDto(existing, await this.replies.refs(ctx, tx, [existing]));

    const now = this.clock.now();
    const message = await messages.insert(tx, {
      id: uuidv7(),
      ticket_id: ticket.id,
      author_id: null,
      author_kind: 'assistant',
      visibility: 'public',
      body,
      client_message_id: input.clientMessageId,
      metadata: input.kind === 'handoff' ? JSON.stringify({ handoff: true }) : undefined,
      created_at: now,
      updated_at: now,
    });
    const dto = toMessageDto(message, await this.replies.refs(ctx, tx, [message]));
    await this.replies.publish(ctx, tx, ticket, message, dto, now, { countsAsReply: input.kind === 'answer' });
    return dto;
  }
}
