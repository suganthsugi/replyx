import { decide, type EffectiveAccess } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { TicketRow } from './tickets.repository.js';
import type { PermissionKey } from '../authorization/registry/module-permissions.js';
import type { TicketLinkKind, TicketOrigin, TicketPriority, TicketState, WaitingOn } from '../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** Staff ticket DTOs (contracts/tickets.yaml `TicketSummary`, `Ticket`). Never sent to customers. */

export interface RefDto {
  id: string;
  name: string;
}

export interface PersonRefDto extends RefDto {
  avatarUrl: string | null;
}

export interface TicketSummaryDto {
  id: string;
  number: number;
  title: string;
  state: TicketState;
  priority: TicketPriority;
  waitingOn: WaitingOn;
  group: RefDto | null;
  owner: PersonRefDto | null;
  customer: PersonRefDto;
  tags: RefDto[];
  sla: { status: 'none' };
  lastCustomerMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AllowedAction = 'reply' | 'note' | 'edit' | 'change_group' | 'assign' | 'delete' | 'merge' | 'split' | 'move_message';

export interface TicketLinkDto {
  id: string;
  kind: TicketLinkKind;
  direction: 'outgoing' | 'incoming';
  ticket: { id: string; number: number; title: string; state: TicketState } | null;
  removedReason: 'retention' | 'not_visible' | null;
}

export interface TicketDto extends TicketSummaryDto {
  pendingUntil: string | null;
  autoCloseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  lastAgentReplyAt: string | null;
  origin: TicketOrigin;
  mergedInto: string | null;
  links: TicketLinkDto[];
  csat: null;
  allowedActions: AllowedAction[];
}

export interface TicketRefs {
  groups: ReadonlyMap<string, RefDto>;
  people: ReadonlyMap<string, RefDto>;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

function person(refs: TicketRefs, id: string): PersonRefDto {
  // An erased or deleted person still shows up as a reference.
  return { id, name: refs.people.get(id)?.name ?? 'Unknown', avatarUrl: null };
}

export function toTicketSummary(row: TicketRow, refs: TicketRefs): TicketSummaryDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state,
    priority: row.priority,
    waitingOn: row.waiting_on,
    group: row.group_id === null ? null : (refs.groups.get(row.group_id) ?? { id: row.group_id, name: 'Unknown' }),
    owner: row.owner_id === null ? null : person(refs, row.owner_id),
    customer: person(refs, row.customer_id),
    // Tags (US6) and SLA (US12) join the summary with their modules.
    tags: [],
    sla: { status: 'none' },
    lastCustomerMessageAt: iso(row.last_customer_message_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const ACTION_KEYS: readonly [AllowedAction, PermissionKey][] = [
  ['reply', 'ticket.edit'],
  ['note', 'ticket.edit'],
  ['edit', 'ticket.edit'],
  ['change_group', 'ticket.edit'],
  ['assign', 'ticket.edit'],
  ['delete', 'ticket.delete'],
  ['merge', 'ticket.merge'],
  ['split', 'ticket.split'],
  ['move_message', 'ticket.move_message'],
];

/** What the caller may do on the ticket now (drives the UI; the server re-checks). */
export function allowedActions(access: EffectiveAccess, groupId: string | null): AllowedAction[] {
  return ACTION_KEYS.filter(([, key]) => decide(access, key, { type: 'ticket', groupId }) === 'allow').map(([action]) => action);
}

export function toTicketDto(row: TicketRow, refs: TicketRefs, links: TicketLinkDto[], actions: AllowedAction[]): TicketDto {
  return {
    ...toTicketSummary(row, refs),
    pendingUntil: iso(row.pending_until),
    autoCloseAt: iso(row.auto_close_at),
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
    lastAgentReplyAt: iso(row.last_agent_reply_at),
    origin: row.origin,
    mergedInto: row.merged_into_id,
    links,
    csat: null,
    allowedActions: actions,
  };
}

/** Names for the groups and people a set of tickets refers to. */
export class TicketRefsRepository extends TenantRepository {
  async load(tx: TenantTransaction, rows: readonly TicketRow[]): Promise<TicketRefs> {
    const groupIds = [...new Set(rows.flatMap((row) => (row.group_id === null ? [] : [row.group_id])))];
    const personIds = [...new Set(rows.flatMap((row) => [row.customer_id, ...(row.owner_id === null ? [] : [row.owner_id])]))];
    const [groups, people] = await Promise.all([
      groupIds.length === 0
        ? Promise.resolve([])
        : this.selectFrom(tx, 'groups').select(['groups.id', 'groups.name']).where('groups.id', 'in', groupIds).execute(),
      personIds.length === 0
        ? Promise.resolve([])
        : this.selectFrom(tx, 'users').select(['users.id', 'users.name']).where('users.id', 'in', personIds).execute(),
    ]);
    return { groups: new Map(groups.map((row) => [row.id, row])), people: new Map(people.map((row) => [row.id, row])) };
  }

  /**
   * A ticket's links in both directions. Linked tickets the caller can't see are shown without
   * their details (`not_visible`); purged ones are tombstones (`retention`).
   */
  async links(tx: TenantTransaction, ticketId: string, canSee: (groupId: string | null) => boolean): Promise<TicketLinkDto[]> {
    const rows = await this.selectFrom(tx, 'ticket_links')
      .select(['ticket_links.id', 'ticket_links.kind', 'ticket_links.from_ticket_id', 'ticket_links.to_ticket_id', 'ticket_links.removed_reason'])
      .where((eb) => eb.or([eb('ticket_links.from_ticket_id', '=', ticketId), eb('ticket_links.to_ticket_id', '=', ticketId)]))
      .orderBy('ticket_links.created_at')
      .orderBy('ticket_links.id')
      .execute();
    const otherIds = rows.flatMap((row) => {
      const other = row.from_ticket_id === ticketId ? row.to_ticket_id : row.from_ticket_id;
      return other === null ? [] : [other];
    });
    const others =
      otherIds.length === 0
        ? []
        : await this.selectFrom(tx, 'tickets')
            .select(['tickets.id', 'tickets.number', 'tickets.title', 'tickets.state', 'tickets.group_id'])
            .where('tickets.id', 'in', otherIds)
            .execute();
    const byId = new Map(others.map((row) => [row.id, row]));
    return rows.map((row) => {
      const outgoing = row.from_ticket_id === ticketId;
      const otherId = outgoing ? row.to_ticket_id : row.from_ticket_id;
      const other = otherId === null ? undefined : byId.get(otherId);
      const visible = other !== undefined && canSee(other.group_id);
      return {
        id: row.id,
        kind: row.kind,
        direction: outgoing ? 'outgoing' : 'incoming',
        ticket: visible ? { id: other.id, number: Number(other.number), title: other.title, state: other.state } : null,
        removedReason: row.removed_reason ?? (visible ? null : 'not_visible'),
      };
    });
  }
}
