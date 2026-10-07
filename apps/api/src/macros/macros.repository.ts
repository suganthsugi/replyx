import { sql } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { MacroActions, MacroVisibility } from '../platform-kernel/db/tables/macros.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** A macro row (data-model.md "macros"), owned by the Macros module. */
export interface MacroRow {
  id: string;
  name: string;
  body: string;
  actions: MacroActions;
  visibility: MacroVisibility;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
  createdBy: string | null;
}

/** The stored shape of a macro's editable fields (`POST /macros`, `PUT /macros/{id}`). */
export interface MacroValues {
  name: string;
  body: string;
  actions: MacroActions;
  visibility: MacroVisibility;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
}

const MACRO_COLUMNS = [
  'macros.id',
  'macros.name',
  'macros.body',
  'macros.actions',
  'macros.visibility',
  'macros.shared_role_ids',
  'macros.shared_group_ids',
  'macros.created_by',
] as const;

interface RawMacroRow {
  id: string;
  name: string;
  body: string;
  actions: MacroActions;
  visibility: MacroVisibility;
  shared_role_ids: string[];
  shared_group_ids: string[];
  created_by: string | null;
}

function toRow(row: RawMacroRow): MacroRow {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    actions: row.actions,
    visibility: row.visibility,
    sharedRoleIds: row.shared_role_ids,
    sharedGroupIds: row.shared_group_ids,
    createdBy: row.created_by,
  };
}

export class MacrosRepository extends TenantRepository {
  /** Every macro, by name; the service narrows to what the caller may see. */
  async listAll(tx: TenantTransaction): Promise<MacroRow[]> {
    const rows = await this.selectFrom(tx, 'macros')
      .select(MACRO_COLUMNS)
      .orderBy(sql`lower(macros.name)`)
      .orderBy('macros.id')
      .execute();
    return rows.map(toRow);
  }

  async byId(tx: TenantTransaction, id: string): Promise<MacroRow | undefined> {
    const row = await this.selectFrom(tx, 'macros').select(MACRO_COLUMNS).where('macros.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  async insert(tx: TenantTransaction, values: MacroValues, createdBy: string): Promise<string> {
    const row = await this.insertInto(tx, 'macros', {
      name: values.name,
      body: values.body,
      // jsonb column: `pg` needs an already-encoded JSON string.
      actions: JSON.stringify(values.actions),
      visibility: values.visibility,
      shared_role_ids: values.sharedRoleIds,
      shared_group_ids: values.sharedGroupIds,
      created_by: createdBy,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** `created_by` is not touched: an editor with `macro.edit` doesn't take a colleague's macro. */
  async update(tx: TenantTransaction, id: string, values: MacroValues): Promise<void> {
    await this.updateTable(tx, 'macros')
      .set({
        name: values.name,
        body: values.body,
        actions: JSON.stringify(values.actions),
        visibility: values.visibility,
        shared_role_ids: values.sharedRoleIds,
        shared_group_ids: values.sharedGroupIds,
        updated_at: sql<Date>`now()`,
      })
      .where('macros.id', '=', id)
      .execute();
  }

  async delete(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'macros').where('macros.id', '=', id).execute();
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

  /** The ids among `ids` that are tags of this tenant (a macro keeps ids of tags deleted later). */
  async existingTagIds(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'tags').select('tags.id').where('tags.id', 'in', [...ids]).execute();
    return new Set(rows.map((row) => row.id));
  }
}
