import { Injectable } from '@nestjs/common';

import { decide, PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { toMessageDto, type MessageDto } from '../messaging/message-dto.js';
import { MessagesRepository, type MessageRow } from '../messaging/messages.repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { ticketStream } from './ticket-events.js';
import { TicketHistoryService, type FieldChange } from './ticket-history.service.js';
import { TicketsRepository } from './tickets.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Moving a customer message to another of the same customer's tickets (contracts/tickets.yaml
 * `/tickets/{id}/messages/{messageId}/move`, FR-042). Needs `ticket.move_message` (edit on the
 * group, FR-023) on both the ticket the message is on and the target; a target belonging to a
 * different customer is 409 `DIFFERENT_CUSTOMER`. Records `moved_from_ticket_id`, emits
 * `message.moved` to both tickets' `ticket:{id}` streams, and writes history on both.
 */

const SUPPORT = 'support' as const;
type Viewer = EffectiveAccess | typeof SUPPORT;

function canView(access: Viewer, groupId: string | null): boolean {
  return access === SUPPORT || decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
}

/** Throws 404 when the ticket is invisible and 403 when the caller may not move messages on it. */
function requireMove(access: Viewer, groupId: string | null): void {
  if (access === SUPPORT) throw permissionDenied();
  const decision = decide(access, 'ticket.move_message', { type: 'ticket', groupId });
  if (decision === 'not_found') throw notFound('ticket');
  if (decision === 'deny') throw permissionDenied();
}

@Injectable()
export class MessageMoveService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly outbox: OutboxService,
    private readonly history: TicketHistoryService,
  ) {}

  async move(ctx: TenantContext, ticketId: string, messageId: string, targetTicketId: string): Promise<MessageDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const tickets = new TicketsRepository(ctx);
      const source = await tickets.find(tx, ticketId);
      if (source === undefined || !canView(access, source.group_id)) throw notFound('ticket');
      requireMove(access, source.group_id);

      if (targetTicketId === ticketId) throw conflict('SAME_TICKET', 'The message is already on this ticket');

      const target = await tickets.find(tx, targetTicketId);
      if (target === undefined || !canView(access, target.group_id)) throw notFound('ticket');
      requireMove(access, target.group_id);

      if (source.customer_id !== target.customer_id) {
        throw conflict('DIFFERENT_CUSTOMER', 'The target ticket belongs to a different customer');
      }

      const messages = new MessagesRepository(ctx);
      const message = await messages.find(tx, messageId);
      if (message === undefined || message.ticket_id !== source.id) throw notFound('message');
      if (message.author_kind !== 'customer') {
        throw conflict('MESSAGE_NOT_MOVABLE', 'Only customer messages can be moved');
      }

      const moved = await messages.move(tx, message.id, target.id);
      const dto = toMessageDto(moved, await this.refs(ctx, tx, [moved]));

      const eventId = await this.outbox.append(tx, {
        type: 'message.moved',
        payload: dto,
        streams: [ticketStream(source.id), ticketStream(target.id)],
      });

      const changes: FieldChange[] = [
        { field: 'message_moved', old: { messageId: message.id, ticketId: source.id }, new: { messageId: message.id, ticketId: target.id } },
      ];
      await this.history.record(tx, source.id, changes, { eventId });
      await this.history.record(tx, target.id, changes, { eventId });

      return dto;
    });
  }

  private async refs(ctx: TenantContext, tx: TenantTransaction, rows: readonly MessageRow[]) {
    const repo = new MessagesRepository(ctx);
    const [authors, attachments] = await Promise.all([
      repo.authors(tx, rows.flatMap((row) => [row.author_id, ...row.mentions])),
      repo.attachmentsFor(tx, rows.map((row) => row.id)),
    ]);
    return { authors, attachments };
  }

  /** Operators under a support-access grant are read-only (FR-001a): writes are always denied. */
  private async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    if (ctx.actor.kind !== 'user') throw new Error('Message moves need a user actor');
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}
