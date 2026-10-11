import { Injectable } from '@nestjs/common';

import { Clock } from '../platform-kernel/clock.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { TicketsRepository } from '../tickets/tickets.repository.js';

import { toMessageDto, type MessageDto } from './message-dto.js';
import { MessagesRepository } from './messages.repository.js';
import { PublicReplyService } from './public-reply.service.js';

/**
 * Writes an automation rule's auto-reply to the customer (US17, FR-088): a public message with
 * `author_kind = 'automation'` and no author row, shown to the customer as from "Support".
 *
 * It is a holding message (`PublicReplyService.publish` with `countsAsReply: false`): it reaches the
 * ticket and the customer's conversation but answers nothing, so SLA timers, `waiting_on` and the
 * friendly status stay as they were — an automatic message is not a response from a person.
 * Retries are idempotent on `(ticketId, clientMessageId)`.
 */

const MAX_BODY_LENGTH = 10_000;

@Injectable()
export class AutomationMessageWriter {
  constructor(
    private readonly replies: PublicReplyService,
    private readonly clock: Clock,
  ) {}

  async write(tx: TenantTransaction, input: { ticketId: string; body: string; clientMessageId: string }): Promise<MessageDto> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AutomationMessageWriter.write must run inside withTenant');
    const body = input.body.trim().slice(0, MAX_BODY_LENGTH);
    if (body.length === 0) throw new Error('An auto-reply needs a body');

    const ticket = await new TicketsRepository(ctx).lock(tx, input.ticketId);
    if (ticket === undefined) throw notFound('ticket');
    const messages = new MessagesRepository(ctx);
    const existing = await messages.findAutomationByClientMessageId(tx, ticket.id, input.clientMessageId);
    if (existing !== undefined) return toMessageDto(existing, await this.replies.refs(ctx, tx, [existing]));

    const now = this.clock.now();
    const message = await messages.insert(tx, {
      id: uuidv7(),
      ticket_id: ticket.id,
      author_id: null,
      author_kind: 'automation',
      visibility: 'public',
      body,
      client_message_id: input.clientMessageId,
      created_at: now,
      updated_at: now,
    });
    const dto = toMessageDto(message, await this.replies.refs(ctx, tx, [message]));
    await this.replies.publish(ctx, tx, ticket, message, dto, now, { countsAsReply: false });
    return dto;
  }
}
