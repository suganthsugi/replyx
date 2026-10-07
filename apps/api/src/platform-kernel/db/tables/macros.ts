import type { ColumnType, Generated, GeneratedTimestamp } from './column-types.js';
import type { TicketPriority, TicketState } from './tickets.js';

/** Migration 0016_macros (data-model.md "macros"). */

export type MacroVisibility = 'all_staff' | 'roles' | 'groups';

/** The field changes a macro makes besides its reply (contracts/tickets.yaml `MacroInput.actions`). */
export interface MacroActions {
  state?: TicketState;
  /** Required with a pending `state`: the pending date is this many hours from when it is applied. */
  pendingInHours?: number;
  priority?: TicketPriority;
  addTagIds?: string[];
  assignToMe?: boolean;
}

export interface MacrosTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  body: string;
  /** Read as an object; written as a JSON string (the pg driver does not serialize objects for jsonb). */
  actions: ColumnType<MacroActions, string | undefined, string>;
  visibility: Generated<MacroVisibility>;
  shared_role_ids: Generated<string[]>;
  shared_group_ids: Generated<string[]>;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface MacroTables {
  macros: MacrosTable;
}
