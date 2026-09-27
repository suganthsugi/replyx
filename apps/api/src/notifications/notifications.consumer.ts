import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { toNotificationDto, type NotificationRow } from './notification-dto.js';
import { RecipientResolver, type NotificationTarget } from './recipient-resolver.js';

import type { MessageDto } from '../messaging/message-dto.js';
import type { NotificationEventType } from '../platform-kernel/db/tables/notifications.js';
import type { TicketPriority, TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { DomainEventPayload, DomainEventType } from '../platform-kernel/outbox/event-types.js';

/**
 * Turns domain events into in-app notifications (research D20, FR-078 to FR-083, T163).
 *
 * | Domain event | Notification |
 * |---|---|
 * | `ticket.created` | `ticket.ungrouped_created` (Ungrouped) or `ticket.arrived_in_group` |
 * | `ticket.updated` with a new group | `ticket.arrived_in_group` |
 * | `ticket.updated` with a new priority, `ticket.state_changed` | `ticket.my_ticket_changed` |
 * | `ticket.reopened` by the customer's message | `ticket.my_ticket_changed` (a staff reopen is a `ticket.state_changed`) |
 * | `ticket.assigned` to someone | `ticket.assigned_to_me` |
 * | `message.created`, public, from the customer | `message.customer_on_my_ticket`, or `message.customer_on_unassigned` once support has replied |
 * | `message.created` from staff with mentions | `mention` (replies and internal notes) |
 * | `ticket.reminder_reached` | `ticket.reminder_reached` |
 *
 * Until support first replies, an unassigned ticket's customer messages add nothing: the "new
 * ticket" notification already stands for them. Customer messages on the same ticket share the
 * group key `ticket:{id}:customer_messages`: within 2 minutes they grow the recipient's unread
 * entry (`count`, `notification.updated`) instead of adding entries (FR-082). An advisory lock on
 * (recipient, group key) keeps two concurrent messages from both opening an entry.
 *
 * Recipients come from `RecipientResolver`. Each (recipient, domain event, channel) is claimed
 * in `notification_deliveries` first, so a redelivered event never notifies twice. Entries are
 * announced on the recipient's `user` stream in the same transaction.
 */

type Handled = Extract<
  DomainEventType,
  'ticket.created' | 'ticket.updated' | 'ticket.state_changed' | 'ticket.reopened' | 'ticket.assigned' | 'message.created' | 'ticket.reminder_reached'
>;

export const GROUPING_WINDOW_MS = 2 * 60_000;
const EXCERPT_LENGTH = 140;

interface TicketFacts {
  id: string;
  number: number;
  title: string;
  state: TicketState;
  priority: TicketPriority;
  groupId: string | null;
  groupName: string | null;
  ownerId: string | null;
  customerId: string;
  customerName: string;
  firstAgentReplyAt: Date | null;
}

export interface PlannedNotification {
  target: NotificationTarget;
  title: string;
  summary: string | null;
  groupKey: string | null;
}

const STATE_LABELS: Readonly<Record<TicketState, string>> = {
  new: 'New',
  open: 'Open',
  pending_reminder: 'Pending (reminder)',
  pending_close: 'Pending (close)',
  resolved: 'Resolved',
  closed: 'Closed',
};

const PRIORITY_LABELS: Readonly<Record<TicketPriority, string>> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH - 1)}…`;
}

function actorUserIdOf(event: DomainEvent): string | null {
  return event.actor.kind === 'user' ? event.actor.id : null;
}

/** The notifications one event means, before recipients (exported for tests). */
export function planNotifications(event: DomainEvent<Handled>, ticket: TicketFacts): PlannedNotification[] {
  const actorUserId = actorUserIdOf(event);
  const ref = `#${ticket.number}`;
  const on = (eventType: NotificationEventType, title: string, summary: string | null, extra: Partial<NotificationTarget> = {}, groupKey: string | null = null) => ({
    target: { eventType, ticket: { groupId: ticket.groupId, ownerId: ticket.ownerId }, actorUserId, ...extra },
    title,
    summary,
    groupKey,
  });

  switch (event.type) {
    case 'ticket.created':
      return ticket.groupId === null
        ? [on('ticket.ungrouped_created', `New ticket ${ref} needs triage`, ticket.title)]
        : [on('ticket.arrived_in_group', `New ticket ${ref} in ${ticket.groupName ?? 'a group'}`, ticket.title)];

    case 'ticket.updated': {
      const { changes } = event.payload as DomainEventPayload<'ticket.updated'>;
      const planned: PlannedNotification[] = [];
      const groupChange = changes.find((change) => change.field === 'group_id');
      if (groupChange !== undefined && groupChange.new !== null && ticket.groupId !== null) {
        planned.push(on('ticket.arrived_in_group', `${ref} moved to ${ticket.groupName ?? 'a group'}`, ticket.title));
      }
      // Assigned in the same change: `ticket.assigned_to_me` already tells the new owner.
      if (changes.some((change) => change.field === 'priority') && !changes.some((change) => change.field === 'owner_id')) {
        planned.push(on('ticket.my_ticket_changed', `${ref} priority is now ${PRIORITY_LABELS[ticket.priority]}`, ticket.title));
      }
      return planned;
    }

    case 'ticket.state_changed': {
      const { to } = event.payload as DomainEventPayload<'ticket.state_changed'>;
      return [on('ticket.my_ticket_changed', `${ref} is now ${STATE_LABELS[to]}`, ticket.title)];
    }

    case 'ticket.reopened':
      // A staff reopen already produced `ticket.state_changed`.
      if (actorUserId !== ticket.customerId) return [];
      return [on('ticket.my_ticket_changed', `${ticket.customerName} reopened ${ref}`, ticket.title)];

    case 'ticket.assigned': {
      const { ownerId } = event.payload as DomainEventPayload<'ticket.assigned'>;
      if (ownerId === null) return [];
      return [
        {
          target: { eventType: 'ticket.assigned_to_me', ticket: { groupId: ticket.groupId, ownerId }, actorUserId },
          title: `${ref} was assigned to you`,
          summary: ticket.title,
          groupKey: null,
        },
      ];
    }

    case 'message.created': {
      const message = event.payload as MessageDto;
      if (message.authorKind === 'customer') {
        if (message.visibility !== 'public') return [];
        const title = `${ticket.customerName} wrote on ${ref}`;
        const groupKey = `ticket:${ticket.id}:customer_messages`;
        if (ticket.ownerId !== null) return [on('message.customer_on_my_ticket', title, excerpt(message.body), {}, groupKey)];
        if (ticket.firstAgentReplyAt === null) return [];
        return [on('message.customer_on_unassigned', title, excerpt(message.body), {}, groupKey)];
      }
      if (message.authorKind !== 'staff' || message.mentions.length === 0) return [];
      const author = message.author?.name ?? 'Someone';
      const where = message.visibility === 'internal' ? 'in a note on' : 'on';
      return [on('mention', `${author} mentioned you ${where} ${ref}`, excerpt(message.body), { mentionedUserIds: message.mentions.map((user) => user.id) })];
    }

    case 'ticket.reminder_reached':
      return [on('ticket.reminder_reached', `Reminder reached on ${ref}`, ticket.title)];
  }
}

function ticketIdOf(event: DomainEvent<Handled>): string {
  switch (event.type) {
    case 'ticket.created':
    case 'ticket.updated':
      return (event.payload as DomainEventPayload<'ticket.created'>).ticket.id;
    case 'message.created':
      return (event.payload as MessageDto).ticketId;
    case 'ticket.state_changed':
    case 'ticket.reopened':
    case 'ticket.assigned':
    case 'ticket.reminder_reached':
      return (event.payload as { ticketId: string }).ticketId;
  }
}

@Injectable()
export class NotificationsConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'notifications';
  readonly queue = 'notifications' as const;
  readonly eventTypes: readonly Handled[] = [
    'ticket.created',
    'ticket.updated',
    'ticket.state_changed',
    'ticket.reopened',
    'ticket.assigned',
    'message.created',
    'ticket.reminder_reached',
  ];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly resolver: RecipientResolver,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('NotificationsConsumer.handle must run inside withTenant');
    const repo = new NotificationsWriteRepository(ctx);
    // Deleted meanwhile: there is nothing left to be notified about.
    const ticket = await repo.ticket(tx, ticketIdOf(event));
    if (ticket === undefined) return;

    for (const planned of planNotifications(event, ticket)) {
      const recipients = await this.resolver.resolve(ctx, tx, planned.target, 'in_app');
      for (const recipientId of recipients) {
        await this.deliver(tx, repo, event.id, recipientId, ticket.id, planned);
      }
    }
  }

  private async deliver(
    tx: TenantTransaction,
    repo: NotificationsWriteRepository,
    eventId: string,
    recipientId: string,
    ticketId: string,
    planned: PlannedNotification,
  ): Promise<void> {
    const now = this.clock.now();
    if (!(await repo.claimDelivery(tx, recipientId, eventId, now))) return;
    const stream = `user:${recipientId}` as const;

    if (planned.groupKey !== null) {
      await repo.lockGroup(tx, recipientId, planned.groupKey);
      const since = new Date(now.getTime() - GROUPING_WINDOW_MS);
      const open = await repo.openEntry(tx, recipientId, planned.groupKey, since);
      if (open !== undefined) {
        const count = await repo.grow(tx, open, planned.summary);
        await this.outbox.append(tx, { type: 'notification.updated', payload: { id: open, count }, streams: [stream] });
        return;
      }
    }

    const row = await repo.insert(tx, {
      recipient_id: recipientId,
      event_type: planned.target.eventType,
      ticket_id: ticketId,
      group_key: planned.groupKey,
      title: planned.title,
      summary: planned.summary,
      event_id: eventId,
    });
    await this.outbox.append(tx, { type: 'notification.created', payload: toNotificationDto(row), streams: [stream] });
  }
}

class NotificationsWriteRepository extends TenantRepository {
  async ticket(tx: TenantTransaction, ticketId: string): Promise<TicketFacts | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .innerJoin('users as customer', (join) => join.onRef('customer.tenant_id', '=', 'tickets.tenant_id').onRef('customer.id', '=', 'tickets.customer_id'))
      .leftJoin('groups', (join) => join.onRef('groups.tenant_id', '=', 'tickets.tenant_id').onRef('groups.id', '=', 'tickets.group_id'))
      .select([
        'tickets.id',
        'tickets.number',
        'tickets.title',
        'tickets.state',
        'tickets.priority',
        'tickets.group_id',
        'groups.name as group_name',
        'tickets.owner_id',
        'tickets.customer_id',
        'customer.name as customer_name',
        'tickets.first_agent_reply_at',
      ])
      .where('tickets.id', '=', ticketId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      number: Number(row.number),
      title: row.title,
      state: row.state,
      priority: row.priority,
      groupId: row.group_id,
      groupName: row.group_name,
      ownerId: row.owner_id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      firstAgentReplyAt: row.first_agent_reply_at,
    };
  }

  /** False when this recipient already got this event in-app (a redelivery). */
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

  /** Serializes grouping for one recipient and key until the transaction ends. */
  async lockGroup(tx: TenantTransaction, recipientId: string, groupKey: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`notifications:${this.ctx.tenantId}:${recipientId}:${groupKey}`}, 0))`.execute(tx);
  }

  async openEntry(tx: TenantTransaction, recipientId: string, groupKey: string, since: Date): Promise<string | undefined> {
    const row = await this.selectFrom(tx, 'notifications')
      .select('notifications.id')
      .where('notifications.recipient_id', '=', recipientId)
      .where('notifications.group_key', '=', groupKey)
      .where('notifications.read_at', 'is', null)
      .where('notifications.created_at', '>=', since)
      .orderBy('notifications.created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  }

  async grow(tx: TenantTransaction, id: string, summary: string | null): Promise<number> {
    const row = await this.updateTable(tx, 'notifications')
      .set((eb) => ({ count: eb('count', '+', 1), summary }))
      .where('notifications.id', '=', id)
      .returning('count')
      .executeTakeFirstOrThrow();
    return row.count;
  }

  async insert(
    tx: TenantTransaction,
    values: { recipient_id: string; event_type: NotificationEventType; ticket_id: string; group_key: string | null; title: string; summary: string | null; event_id: string },
  ): Promise<NotificationRow> {
    return this.insertInto(tx, 'notifications', values)
      .returning(['id', 'event_type', 'title', 'summary', 'ticket_id', 'count', 'read_at', 'created_at'])
      .executeTakeFirstOrThrow();
  }
}
