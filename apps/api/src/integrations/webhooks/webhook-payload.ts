import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { MessageDto } from '../../messaging/message-dto.js';
import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { WebhookEvent } from '../../platform-kernel/db/tables/integrations.js';
import type { TicketPriority, TicketState } from '../../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import type { DomainEvent } from '../../platform-kernel/jobs/idempotent-handler.js';
import type { DomainEventPayload, TicketClosedBy } from '../../platform-kernel/outbox/event-types.js';

/**
 * Webhook bodies (contracts/webhook-events.md "Body"). Built once, when the event is consumed, and
 * stored on the delivery row, so every attempt sends the same bytes. The ticket is read as it is
 * then; `message.created` carries public messages only (internal notes never leave the
 * workspace), and attachments are listed without files or links.
 */

interface PersonRef {
  id: string;
  name: string;
  email: string;
}

export interface WebhookTicket {
  id: string;
  number: number;
  title: string;
  state: TicketState;
  priority: TicketPriority;
  group: { id: string; name: string } | null;
  owner: PersonRef | null;
  customer: PersonRef;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WebhookBody {
  id: string;
  type: WebhookEvent;
  occurredAt: string;
  tenant: { slug: string };
  data: Record<string, unknown>;
}

export class WebhookPayloadRepository extends TenantRepository {
  async tenantSlug(tx: TenantTransaction): Promise<string> {
    const row = await tx.selectFrom('tenants').select('slug').where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
    return row.slug;
  }

  async ticket(tx: TenantTransaction, ticketId: string): Promise<WebhookTicket | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .innerJoin('users as customer', (join) => join.onRef('customer.tenant_id', '=', 'tickets.tenant_id').onRef('customer.id', '=', 'tickets.customer_id'))
      .leftJoin('users as owner', (join) => join.onRef('owner.tenant_id', '=', 'tickets.tenant_id').onRef('owner.id', '=', 'tickets.owner_id'))
      .leftJoin('groups', (join) => join.onRef('groups.tenant_id', '=', 'tickets.tenant_id').onRef('groups.id', '=', 'tickets.group_id'))
      .select([
        'tickets.id',
        'tickets.number',
        'tickets.title',
        'tickets.state',
        'tickets.priority',
        'tickets.created_at',
        'tickets.updated_at',
        'groups.id as group_id',
        'groups.name as group_name',
        'owner.id as owner_id',
        'owner.name as owner_name',
        'owner.email as owner_email',
        'customer.id as customer_id',
        'customer.name as customer_name',
        'customer.email as customer_email',
      ])
      .where('tickets.id', '=', ticketId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const tags = await this.selectFrom(tx, 'ticket_tags')
      .innerJoin('tags', (join) => join.onRef('tags.tenant_id', '=', 'ticket_tags.tenant_id').onRef('tags.id', '=', 'ticket_tags.tag_id'))
      .select('tags.name')
      .where('ticket_tags.ticket_id', '=', ticketId)
      .orderBy('tags.name')
      .execute();
    return {
      id: row.id,
      number: Number(row.number),
      title: row.title,
      state: row.state,
      priority: row.priority,
      group: row.group_id === null || row.group_name === null ? null : { id: row.group_id, name: row.group_name },
      owner: row.owner_id === null ? null : { id: row.owner_id, name: row.owner_name ?? '', email: row.owner_email ?? '' },
      customer: { id: row.customer_id, name: row.customer_name, email: row.customer_email },
      tags: tags.map((tag) => tag.name),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async person(tx: TenantTransaction, userId: string | null): Promise<PersonRef | null> {
    if (userId === null) return null;
    const row = await this.selectFrom(tx, 'users').select(['users.id', 'users.name', 'users.email']).where('users.id', '=', userId).executeTakeFirst();
    return row ?? null;
  }
}

/** Events from before `by` existed: the system closed it on a timer, anyone else is an agent. */
function closedBy(event: DomainEvent<'ticket.closed'>): TicketClosedBy {
  return event.payload.by ?? (event.actor.kind === 'system' ? 'auto_close' : 'agent');
}

function messageData(message: MessageDto): JsonValue {
  return {
    id: message.id,
    authorKind: message.authorKind,
    author: message.author === null ? null : { id: message.author.id, name: message.author.name },
    body: message.body,
    attachments: message.attachments.map((file) => ({ id: file.id, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes })),
    createdAt: message.createdAt,
  };
}

/**
 * The `data` of one event, or `undefined` when nothing is sent: an internal note, or a ticket that
 * no longer exists.
 */
export async function webhookData(repo: WebhookPayloadRepository, tx: TenantTransaction, event: DomainEvent<WebhookEvent>): Promise<Record<string, unknown> | undefined> {
  switch (event.type) {
    case 'message.created': {
      const message = event.payload as MessageDto;
      if (message.visibility !== 'public') return undefined;
      return { ticketId: message.ticketId, message: messageData(message) };
    }
    case 'ticket.created': {
      const ticket = await repo.ticket(tx, (event.payload as DomainEventPayload<'ticket.created'>).ticket.id);
      return ticket === undefined ? undefined : { ticket };
    }
    case 'ticket.updated': {
      const payload = event.payload as DomainEventPayload<'ticket.updated'>;
      const ticket = await repo.ticket(tx, payload.ticket.id);
      return ticket === undefined ? undefined : { ticket, changes: payload.changes };
    }
    case 'ticket.assigned': {
      const payload = event.payload as DomainEventPayload<'ticket.assigned'>;
      const ticket = await repo.ticket(tx, payload.ticketId);
      if (ticket === undefined) return undefined;
      return { ticket, previousOwner: await repo.person(tx, payload.previousOwnerId), owner: await repo.person(tx, payload.ownerId) };
    }
    case 'ticket.closed': {
      const closed = event as DomainEvent<'ticket.closed'>;
      const ticket = await repo.ticket(tx, closed.payload.ticketId);
      return ticket === undefined ? undefined : { ticket, closedBy: closedBy(closed) };
    }
  }
}

export function webhookBody(event: DomainEvent<WebhookEvent>, slug: string, data: Record<string, unknown>): WebhookBody {
  return { id: event.id, type: event.type, occurredAt: event.occurredAt.toISOString(), tenant: { slug }, data };
}
