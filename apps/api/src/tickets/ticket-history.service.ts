import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { HistoryActorKind } from '../platform-kernel/db/tables/tickets.js';

/**
 * Ticket history (FR-037, data-model.md "ticket_history"): one append-only row per changed field,
 * with the actor from the transaction's context and the id of the outbox event that announced
 * the change. Written in the same transaction as the change.
 */

export interface FieldChange {
  /** snake_case field name, e.g. `state`, `group_id`, `owner_id`. */
  field: string;
  old: JsonValue;
  new: JsonValue;
}

export interface HistoryOptions {
  eventId?: string;
  /** Routing rules act for the system but are shown as routing (FR-061). */
  actorKind?: HistoryActorKind;
}

/** A Date becomes its ISO string; everything else is stored as given. */
export function historyValue(value: Date | JsonValue | undefined): JsonValue {
  if (value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

@Injectable()
export class TicketHistoryService {
  async record(tx: TenantTransaction, ticketId: string, changes: readonly FieldChange[], options: HistoryOptions = {}): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('TicketHistoryService.record must run inside withTenant');
    const rows = changes.filter((change) => JSON.stringify(change.old) !== JSON.stringify(change.new));
    if (rows.length === 0) return;
    await new TicketHistoryRepository(ctx).insert(tx, ticketId, rows, options);
  }
}

class TicketHistoryRepository extends TenantRepository {
  async insert(tx: TenantTransaction, ticketId: string, changes: readonly FieldChange[], options: HistoryOptions): Promise<void> {
    const { actor } = this.ctx;
    await this.insertInto(
      tx,
      'ticket_history',
      changes.map((change) => ({
        ticket_id: ticketId,
        actor_id: actor.kind === 'system' ? null : actor.id,
        actor_kind: options.actorKind ?? actor.kind,
        field: change.field,
        old_value: JSON.stringify(change.old),
        new_value: JSON.stringify(change.new),
        event_id: options.eventId ?? null,
      })),
    ).execute();
  }
}
