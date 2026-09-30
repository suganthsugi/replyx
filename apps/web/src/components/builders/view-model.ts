import { defaultConditions } from './filter-model';

import type { ConditionGroup, View, ViewInput, ViewInputColumnsItem, ViewInputSortItem, ViewInputVisibility } from '../../api/generated/model';

/**
 * The pure model behind `ViewBuilder`: the sort and column vocabularies (mirroring
 * `apps/api/src/views/view-input.ts`), the form state, and conversions to and from the API shapes.
 */

export const SORT_FIELDS: readonly { value: ViewInputSortItem['field']; label: string }[] = [
  { value: 'updated_at', label: 'Last updated' },
  { value: 'created_at', label: 'Created' },
  { value: 'priority', label: 'Priority' },
  { value: 'last_customer_message_at', label: 'Last customer message' },
  { value: 'sla_due_at', label: 'SLA due' },
  { value: 'number', label: 'Ticket number' },
];

export const COLUMN_OPTIONS: readonly { value: ViewInputColumnsItem; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'title', label: 'Title' },
  { value: 'customer', label: 'Customer' },
  { value: 'state', label: 'State' },
  { value: 'priority', label: 'Priority' },
  { value: 'group', label: 'Group' },
  { value: 'owner', label: 'Owner' },
  { value: 'tags', label: 'Tags' },
  { value: 'waiting_on', label: 'Waiting on' },
  { value: 'sla', label: 'SLA' },
  { value: 'updated_at', label: 'Updated' },
  { value: 'created_at', label: 'Created' },
  { value: 'last_customer_message_at', label: 'Last customer message' },
];

export const MAX_SORT_ITEMS = 3;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 300;

export const DEFAULT_COLUMNS: readonly ViewInputColumnsItem[] = ['number', 'title', 'customer', 'state', 'priority', 'group', 'owner', 'updated_at'];
export const DEFAULT_SORT: readonly ViewInputSortItem[] = [{ field: 'updated_at', direction: 'desc' }];

export const sortLabel = (field: string): string => SORT_FIELDS.find((option) => option.value === field)?.label ?? field;
export const columnLabel = (column: string): string => COLUMN_OPTIONS.find((option) => option.value === column)?.label ?? column;

export interface ViewFormState {
  name: string;
  description: string;
  visibility: ViewInputVisibility;
  roleIds: string[];
  groupIds: string[];
  conditions: ConditionGroup;
  sort: ViewInputSortItem[];
  columns: ViewInputColumnsItem[];
}

export function initialFormState(initial: View | undefined): ViewFormState {
  if (initial === undefined) {
    return {
      name: '',
      description: '',
      visibility: 'personal',
      roleIds: [],
      groupIds: [],
      conditions: defaultConditions(),
      sort: [...DEFAULT_SORT],
      columns: [...DEFAULT_COLUMNS],
    };
  }
  const sortFields = new Set<string>(SORT_FIELDS.map((option) => option.value));
  const columnValues = new Set<string>(COLUMN_OPTIONS.map((option) => option.value));
  return {
    name: initial.name,
    description: initial.description ?? '',
    visibility: initial.visibility,
    roleIds: [...initial.sharedRoleIds],
    groupIds: [...initial.sharedGroupIds],
    conditions: initial.conditions,
    sort: initial.sort.filter((item): item is ViewInputSortItem => sortFields.has(item.field)),
    columns: initial.columns.filter((column): column is ViewInputColumnsItem => columnValues.has(column)),
  };
}

export function toViewInput(state: ViewFormState): ViewInput {
  const description = state.description.trim();
  return {
    name: state.name.trim(),
    ...(description === '' ? {} : { description }),
    visibility: state.visibility,
    ...(state.visibility === 'roles' ? { sharedRoleIds: state.roleIds } : {}),
    ...(state.visibility === 'groups' ? { sharedGroupIds: state.groupIds } : {}),
    conditions: state.conditions,
    sort: state.sort,
    columns: state.columns,
  };
}
