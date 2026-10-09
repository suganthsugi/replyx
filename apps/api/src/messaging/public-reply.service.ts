import { Injectable } from '@nestjs/common';

import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TenantSettingsRepository } from '../tenancy/tenant-settings.js';
import { transition } from '../tickets/state-machine.js';
import { groupStream, summaryOf, ticketStream } from '../tickets/ticket-events.js';
import { TicketHistoryService, historyValue, type FieldChange } from '../tickets/ticket-history.service.js';
import { TicketsRepository, type TicketPatch, type TicketRow } from '../tickets/tickets.repository.js';

import { stateChanges, timersOf } from './customer-message-router.js';
import { customerEvents, toConversationMessage } from './customer-projection.js';
import { MessagesRepository, type MessageRow } from './messages.repository.js';

import type { MessageDto } from './message-dto.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * What happens after a public support message is stored, shared by the staff reply path
 * (`StaffMessagesService`) and the assistant writer (`AssistantMessageWriter`, spec 002 FR-029):
 *
 * - An **answer** (`countsAsReply: true`) moves `new` to `open` on the first reply, sets
 *   `first_agent_reply_at` (once) and `last_agent_reply_at`, moves `waiting_on` to `customer`,
 *   appends `message.created` (ticket stream + the customer's conversation as a projection) and
 *   `ticket.updated`, records history, marks the customer's messages read and sets the friendly
 *   status to `answered`.
 * - A **holding** message (`countsAsReply: false`, the assistant's hand-off notice) only reaches
 *   the ticket and the customer's conversation: it answers nothing, so no timers, `waiting_on`,
 *   receipts or status change.
 *
 * Everything runs in the caller's transaction (persist before publish).
 */
@Injectable()
export class PublicReplyService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly history: TicketHistoryService,
  ) {}

  async refs(ctx: TenantContext, tx: TenantTransaction, rows: readonly MessageRow[]) {
    const repo = new MessagesRepository(ctx);
    const [authors, attachments] = await Promise.all([
      repo.authors(tx, rows.flatMap((row) => [row.author_id, ...row.mentions])),
      repo.attachmentsFor(tx, rows.map((row) => row.id)),
    ]);
    return { authors, attachments };
  }

  async publish(
    ctx: TenantContext,
    tx: TenantTransaction,
    before: TicketRow,
    message: MessageRow,
    dto: MessageDto,
    now: Date,
    options: { countsAsReply: boolean } = { countsAsReply: true },
  ): Promise<void> {
    if (!options.countsAsReply) {
      const projected = toConversationMessage(message, before.customer_id, await this.refs(ctx, tx, [message]));
      await this.outbox.append(tx, {
        type: 'message.created',
        payload: dto,
        customerPayload: customerEvents.message(projected),
        streams: [ticketStream(before.id), `conversation:${before.customer_id}`],
      });
      return;
    }

    const settings = await new TenantSettingsRepository(ctx).conversation(tx);
    const moved = transition(timersOf(before), { cause: 'agent_reply', now, gracePeriodHours: settings.gracePeriodHours });
    const patch: TicketPatch = {
      ...moved.changes,
      ...(moved.stateChanged ? { state: moved.state } : {}),
      last_agent_reply_at: now,
      waiting_on: 'customer',
      ...(before.first_agent_reply_at === null ? { first_agent_reply_at: now } : {}),
    };
    const ticket = await new TicketsRepository(ctx).update(tx, before.id, patch);

    const customerId = ticket.customer_id;
    const projected = toConversationMessage(message, customerId, await this.refs(ctx, tx, [message]));
    await this.outbox.append(tx, {
      type: 'message.created',
      payload: dto,
      customerPayload: customerEvents.message(projected),
      streams: [ticketStream(ticket.id), `conversation:${customerId}`],
    });

    const changes: FieldChange[] = [
      ...stateChanges(before, moved),
      ...(before.waiting_on === 'customer' ? [] : [{ field: 'waiting_on', old: before.waiting_on, new: 'customer' }]),
    ];
    const eventId = await this.outbox.append(tx, {
      type: 'ticket.updated',
      payload: {
        ticket: await summaryOf(ctx, tx, ticket),
        changes: [...changes, { field: 'last_agent_reply_at', old: historyValue(before.last_agent_reply_at), new: now.toISOString() }],
      },
      streams: [ticketStream(ticket.id), groupStream(ticket.group_id)],
    });
    await this.history.record(tx, ticket.id, changes, { eventId });

    // Replying means support has read what the customer wrote.
    const read = await new MessagesRepository(ctx).markCustomerMessages(tx, ticket.id, 'read_at', now);
    await this.announceReceipts(tx, ticket.id, customerId, read, 'read');
    await this.outbox.append(tx, {
      type: 'conversation.status_changed',
      payload: { customerId, status: 'answered' },
      customerPayload: customerEvents.status('answered'),
      streams: [`conversation:${customerId}`],
    });
  }

  async announceReceipts(tx: TenantTransaction, ticketId: string, customerId: string, messageIds: readonly string[], delivery: 'delivered' | 'read') {
    for (const messageId of messageIds) {
      await this.outbox.append(tx, {
        type: 'message.delivery_updated',
        payload: { ticketId, messageId, delivery },
        customerPayload: customerEvents.delivery(messageId, delivery),
        streams: [`conversation:${customerId}`],
      });
    }
  }
}
