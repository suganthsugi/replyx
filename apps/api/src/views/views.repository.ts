import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { ConditionGroup } from './condition-schema.js';
import type { ViewAccessRow } from './view-visibility.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** A full view row (data-model.md "views"), owned by the Views module. */
export interface ViewRow extends ViewAccessRow {
  id: string;
  name: string;
  description: string | null;
  systemKey: string | null;
  conditions: ConditionGroup;
  sort: { field: string; direction: 'asc' | 'desc' }[];
  columns: string[];
  position: number;
  hidden: boolean;
}

const VIEW_COLUMNS = [
  'views.id',
  'views.name',
  'views.description',
  'views.system_key',
  'views.owner_id',
  'views.visibility',
  'views.shared_role_ids',
  'views.shared_group_ids',
  'views.conditions',
  'views.sort',
  'views.columns',
  'views.position',
  'views.hidden',
] as const;

interface RawViewRow {
  id: string;
  name: string;
  description: string | null;
  system_key: string | null;
  owner_id: string | null;
  visibility: ViewAccessRow['visibility'];
  shared_role_ids: string[];
  shared_group_ids: string[];
  conditions: unknown;
  sort: unknown;
  columns: string[];
  position: number;
  hidden: boolean;
}

function toRow(row: RawViewRow): ViewRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemKey: row.system_key,
    ownerId: row.owner_id,
    visibility: row.visibility,
    sharedRoleIds: row.shared_role_ids,
    sharedGroupIds: row.shared_group_ids,
    conditions: row.conditions as ConditionGroup,
    sort: row.sort as { field: string; direction: 'asc' | 'desc' }[],
    columns: row.columns,
    position: row.position,
    hidden: row.hidden,
  };
}

export class ViewsRepository extends TenantRepository {
  /** Every view, in display order (contracts/tickets.yaml "Views visible to the caller, in order"). */
  async listAll(tx: TenantTransaction): Promise<ViewRow[]> {
    const rows = await this.selectFrom(tx, 'views').select(VIEW_COLUMNS).orderBy('views.position').orderBy('views.id').execute();
    return rows.map(toRow);
  }

  async byId(tx: TenantTransaction, id: string): Promise<ViewRow | undefined> {
    const row = await this.selectFrom(tx, 'views').select(VIEW_COLUMNS).where('views.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }
}

/**
 * The ticket count for a view's compiled filter (research D13: "computed with `COUNT(*)` using
 * the same query"). Not cached yet — that (and `GET /views/counts`, `views.counts_changed`) is a
 * follow-up; a live count is still correct, just not optimized for repeated reads.
 */
export class TicketCountRepository extends TenantRepository {
  async count(tx: TenantTransaction, filter: Expression<SqlBool>): Promise<number> {
    const row = await this.selectFrom(tx, 'tickets')
      .select(sql<string>`count(*)`.as('count'))
      .where(filter)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
