import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { ConditionGroup } from './condition-schema.js';
import type { ViewAccessRow } from './view-visibility.js';
import type { ViewVisibility } from '../platform-kernel/db/tables/tags-views.js';
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

  /** Whether the user created a view others can see (`views.owner_id` cascades on user delete). */
  async ownsSharedView(tx: TenantTransaction, userId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'views')
      .select('views.id')
      .where('views.owner_id', '=', userId)
      .where('views.visibility', '<>', 'personal')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async byId(tx: TenantTransaction, id: string): Promise<ViewRow | undefined> {
    const row = await this.selectFrom(tx, 'views').select(VIEW_COLUMNS).where('views.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }
}

/**
 * The ticket count for a view's compiled filter (research D13: "computed with `COUNT(*)` using
 * the same query"). `ViewCountsService` caches the results.
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

/** The stored shape of a view's editable fields (`POST /views`, `PUT /views/{id}`). */
export interface ViewValues {
  name: string;
  description: string | null;
  ownerId: string | null;
  visibility: ViewVisibility;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
  conditions: ConditionGroup;
  sort: { field: string; direction: 'asc' | 'desc' }[];
  columns: string[];
}

/** Writes for `POST /views`, `PUT /views/{id}`, `PUT /views/order` and `DELETE /views/{id}`. */
export class ViewWritesRepository extends TenantRepository {
  /** After the last view: position belongs to the view, so it is one ordering for the tenant. */
  async insert(tx: TenantTransaction, values: ViewValues): Promise<string> {
    const last = await this.selectFrom(tx, 'views')
      .select(sql<number | null>`max(views.position)`.as('last'))
      .executeTakeFirstOrThrow();
    const row = await this.insertInto(tx, 'views', {
      name: values.name,
      description: values.description,
      system_key: null,
      owner_id: values.ownerId,
      visibility: values.visibility,
      shared_role_ids: values.sharedRoleIds,
      shared_group_ids: values.sharedGroupIds,
      // jsonb columns: `pg` needs an already-encoded JSON string (default-views.contributor.ts).
      conditions: JSON.stringify(values.conditions),
      sort: JSON.stringify(values.sort),
      columns: values.columns,
      position: (last.last ?? -1) + 1,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Position, hidden and `system_key` are not touched: they are arranging, not editing. */
  async update(tx: TenantTransaction, id: string, values: ViewValues): Promise<void> {
    await this.updateTable(tx, 'views')
      .set({
        name: values.name,
        description: values.description,
        owner_id: values.ownerId,
        visibility: values.visibility,
        shared_role_ids: values.sharedRoleIds,
        shared_group_ids: values.sharedGroupIds,
        conditions: JSON.stringify(values.conditions),
        sort: JSON.stringify(values.sort),
        columns: values.columns,
        updated_at: sql<Date>`now()`,
      })
      .where('views.id', '=', id)
      .execute();
  }

  /** The ids among `ids` that are roles of this tenant. */
  async existingRoleIds(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'roles').select('roles.id').where('roles.id', 'in', [...ids]).execute();
    return new Set(rows.map((row) => row.id));
  }

  /** The ids among `ids` that are groups of this tenant. */
  async existingGroupIds(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'groups').select('groups.id').where('groups.id', 'in', [...ids]).execute();
    return new Set(rows.map((row) => row.id));
  }

  /** Active staff: who might see a shared view (narrowed further by `canSeeView`). */
  async activeStaffIds(tx: TenantTransaction): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'users')
      .select('users.id')
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'staff')
      .execute();
    return rows.map((row) => row.id);
  }

  async setOrder(tx: TenantTransaction, id: string, position: number, hidden: boolean): Promise<void> {
    await this.updateTable(tx, 'views').set({ position, hidden }).where('views.id', '=', id).execute();
  }

  async delete(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'views').where('views.id', '=', id).execute();
  }
}
