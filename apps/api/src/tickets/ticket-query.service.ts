import { Injectable } from '@nestjs/common';
import { sql, type Expression, type SqlBool } from 'kysely';
import { z } from 'zod';

import { PolicyService } from '../authorization/policy.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';
import { TagsService } from '../tags/tags.service.js';
import { ViewCompiler, type ConditionExpression } from '../views/view-compiler.js';
import { ViewVisibilityRepository, type ViewAccessRow } from '../views/view-visibility.js';

import { TicketRefsRepository, toTicketSummary, type TicketSummaryDto } from './ticket-dto.js';
import { TicketsRepository, type TicketRow } from './tickets.repository.js';

import type { TicketPriority, TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * `GET /tickets` (contracts/tickets.yaml, T135): tickets visible to the caller, by a saved view
 * or an ad-hoc filter. `PolicyService.ticketAccessFilter(ctx, 'view')` is always applied, on top
 * of whichever filter the request asks for; the two combine, they are not alternatives.
 *
 * A `viewId` compiles to a condition (`ViewCompiler.filterFor`, which already includes the access
 * filter — applying it again here is harmless) after checking the caller may see that view
 * (`ViewVisibilityRepository`, `views/view-visibility.ts`); an unknown or invisible view is 404
 * `VIEW_NOT_FOUND`, the same as any other invisible resource (constitution I).
 */

type SortKey = 'updated_at' | 'created_at' | 'priority' | 'last_customer_message_at';
export type TicketSort = SortKey | `-${SortKey}`;

interface SortSpec {
  key: SortKey;
  direction: 'asc' | 'desc';
  expr: Expression<Date | number>;
}

const PRIORITY_RANK: Readonly<Record<TicketPriority, number>> = { low: 0, normal: 1, high: 2, urgent: 3 };
const PRIORITY_RANK_SQL = sql<number>`CASE tickets.priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1 WHEN 'high' THEN 2 WHEN 'urgent' THEN 3 END`;

function sortSpecOf(sort: TicketSort | undefined): SortSpec {
  const desc = sort !== undefined && sort.startsWith('-');
  const key: SortKey = sort === undefined ? 'updated_at' : desc ? (sort.slice(1) as SortKey) : (sort as SortKey);
  const direction: 'asc' | 'desc' = sort === undefined ? 'desc' : desc ? 'desc' : 'asc';
  const expr = key === 'priority' ? PRIORITY_RANK_SQL : sql.ref<Date>(`tickets.${key}`);
  return { key, direction, expr };
}

/**
 * The row's value for `spec.key`, in the same shape the keyset comparison and cursor use. `null`
 * (only possible for a nullable sort key, e.g. `last_customer_message_at`) is kept as `null`
 * rather than coerced to a sentinel date: the repository orders nulls last in both directions and
 * needs to tell "no value" apart from any real timestamp to stay NULL-aware across pages.
 */
function valueOf(row: TicketRow, spec: SortSpec): string | number | null {
  if (spec.key === 'priority') return PRIORITY_RANK[row.priority];
  const value = row[spec.key];
  return value === null ? null : value.toISOString();
}

/** Parsed `after.value` back to what the column (or rank) compares against. */
function afterValueOf(spec: SortSpec, value: string | number | null): Date | number | null {
  if (value === null) return null;
  return spec.key === 'priority' ? Number(value) : new Date(String(value));
}

export interface TicketListQuery {
  limit: number;
  cursor?: string;
  viewId?: string;
  state?: readonly TicketState[];
  priority?: readonly TicketPriority[];
  /** `'ungrouped'` or a group id. */
  groupId?: string;
  /** `'me'`, `'unassigned'` or a user id. */
  ownerId?: string;
  customerId?: string;
  /** Filters on `tickets.number`; the access filter still applies (an invisible ticket is an empty page). */
  number?: number;
  sort?: TicketSort;
}

function actorUserId(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new Error('Ticket lists are compiled for user actors');
  return ctx.actor.id;
}

const CursorPosition = z.object({ value: z.union([z.string(), z.number(), z.null()]), id: z.uuid() }).strict();

@Injectable()
export class TicketQueryService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly viewCompiler: ViewCompiler,
    private readonly tags: TagsService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext, query: TicketListQuery): Promise<Page<TicketSummaryDto>> {
    const viewerId = actorUserId(ctx);
    const spec = sortSpecOf(query.sort);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, CursorPosition);

    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const access = await this.policy.ticketAccessFilter(ctx, 'view');
      const extra = query.viewId === undefined ? undefined : await this.viewFilter(ctx, tx, viewerId, query.viewId);

      const groupId = query.groupId === undefined ? undefined : query.groupId === 'ungrouped' ? null : query.groupId;
      const ownerId =
        query.ownerId === undefined ? undefined : query.ownerId === 'me' ? viewerId : query.ownerId === 'unassigned' ? null : query.ownerId;

      const rows = await new TicketsRepository(ctx).list(tx, {
        access,
        extra,
        state: query.state,
        priority: query.priority,
        groupId,
        ownerId,
        customerId: query.customerId,
        number: query.number,
        sortExpr: spec.expr,
        direction: spec.direction,
        after: after === undefined ? undefined : { value: afterValueOf(spec, after.value), id: after.id },
        limit: query.limit,
      });

      const [refs, tagsByTicket] = await Promise.all([
        new TicketRefsRepository(ctx).load(tx, rows),
        this.tags.tagsByTicketIds(tx, rows.map((row) => row.id)),
      ]);
      return toPage(
        rows,
        query.limit,
        (row) => ({ value: valueOf(row, spec), id: row.id }),
        (row) => toTicketSummary(row, refs, tagsByTicket.get(row.id) ?? []),
      );
    });
  }

  /** The compiled condition for a view the caller may see; an unknown or invisible one is 404. */
  private async viewFilter(ctx: TenantContext, tx: TenantTransaction, viewerId: string, viewId: string): Promise<Expression<SqlBool>> {
    const view = await new ViewRowRepository(ctx).byId(tx, viewId);
    if (view === undefined) throw notFound('view');
    const access = await this.policy.effectiveAccess(ctx, viewerId);
    const visible = await new ViewVisibilityRepository(ctx).canSee(tx, view, viewerId, access);
    if (!visible) throw notFound('view');
    return this.viewCompiler.filterFor(ctx, view.conditions, this.clock.now());
  }
}

interface ViewRow extends ViewAccessRow {
  conditions: ConditionExpression;
}

class ViewRowRepository extends TenantRepository {
  async byId(tx: TenantTransaction, id: string): Promise<ViewRow | undefined> {
    const row = await this.selectFrom(tx, 'views')
      .select(['views.visibility', 'views.owner_id', 'views.shared_role_ids', 'views.shared_group_ids', 'views.conditions'])
      .where('views.id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      visibility: row.visibility,
      ownerId: row.owner_id,
      sharedRoleIds: row.shared_role_ids,
      sharedGroupIds: row.shared_group_ids,
      conditions: row.conditions as unknown as ConditionExpression,
    };
  }
}
