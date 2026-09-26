import { Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';

import { decide, PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';

import { TicketsRepository } from './tickets.repository.js';

import type { Database } from '../platform-kernel/db/database.js';
import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { HistoryActorKind } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * `GET /tickets/{id}/history` (contracts/tickets.yaml, data-model.md "ticket_history"): the
 * ticket's change log, newest first. Needs `ticket.view` on the ticket's group; an invisible or
 * unknown ticket is 404 like a missing one.
 */

const HISTORY_COLUMNS = [
  'ticket_history.id',
  'ticket_history.actor_id',
  'ticket_history.actor_kind',
  'ticket_history.field',
  'ticket_history.old_value',
  'ticket_history.new_value',
  'ticket_history.created_at',
] as const;

type HistoryRow = Selectable<Pick<Database['ticket_history'], 'id' | 'actor_id' | 'actor_kind' | 'field' | 'old_value' | 'new_value' | 'created_at'>>;

export interface HistoryActorDto {
  kind: 'user' | 'system' | 'automation' | 'routing';
  user?: { id: string; name: string };
  ruleName?: string;
}

export interface HistoryEntryDto {
  id: string;
  field: string;
  oldValue: JsonValue;
  newValue: JsonValue;
  occurredAt: string;
  actor: HistoryActorDto;
}

const Position = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();

const SUPPORT = 'support' as const;
type Viewer = EffectiveAccess | typeof SUPPORT;

function canView(access: Viewer, groupId: string | null): boolean {
  return access === SUPPORT || decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
}

/** Operator support-access history rows never occur today (writes are read-only), but a stray one falls back to `system`. */
function actorKindOf(row: HistoryActorKind): HistoryActorDto['kind'] {
  return row === 'operator' ? 'system' : row;
}

function toHistoryEntryDto(row: HistoryRow, names: ReadonlyMap<string, string>): HistoryEntryDto {
  const kind = actorKindOf(row.actor_kind);
  return {
    id: row.id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    occurredAt: row.created_at.toISOString(),
    actor: kind === 'user' && row.actor_id !== null ? { kind, user: { id: row.actor_id, name: names.get(row.actor_id) ?? 'Unknown' } } : { kind },
  };
}

@Injectable()
export class TicketHistoryQueryService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
  ) {}

  async list(ctx: TenantContext, ticketId: string, query: { limit: number; cursor?: string }): Promise<Page<HistoryEntryDto>> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, Position);
    const access = await this.access(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
      if (ticket === undefined || !canView(access, ticket.group_id)) throw notFound('ticket');

      const repo = new TicketHistoryReadRepository(ctx);
      const rows = await repo.list(
        tx,
        ticketId,
        query.limit + 1,
        after === undefined ? undefined : { createdAt: new Date(after.createdAt), id: after.id },
      );
      const userIds = rows.flatMap((row) => (row.actor_kind === 'user' && row.actor_id !== null ? [row.actor_id] : []));
      const names = await repo.actorNames(tx, userIds);
      return toPage(rows, query.limit, (row) => ({ createdAt: row.created_at.toISOString(), id: row.id }), (row) => toHistoryEntryDto(row, names));
    });
  }

  /** Operators under a support-access grant read every ticket (read-only, FR-001a). */
  private async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    if (ctx.actor.kind !== 'user') throw new Error('Ticket history needs a user actor');
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}

class TicketHistoryReadRepository extends TenantRepository {
  list(tx: TenantTransaction, ticketId: string, limit: number, after?: { createdAt: Date; id: string }): Promise<HistoryRow[]> {
    let query = this.selectFrom(tx, 'ticket_history').select(HISTORY_COLUMNS).where('ticket_history.ticket_id', '=', ticketId);
    if (after !== undefined) {
      query = query.where(sql<boolean>`(ticket_history.created_at, ticket_history.id) < (${after.createdAt}, ${after.id}::uuid)`);
    }
    return query.orderBy('ticket_history.created_at', 'desc').orderBy('ticket_history.id', 'desc').limit(limit).execute();
  }

  async actorNames(tx: TenantTransaction, userIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'users').select(['users.id', 'users.name']).where('users.id', 'in', unique).execute();
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
