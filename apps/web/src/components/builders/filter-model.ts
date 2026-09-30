import type { Condition, ConditionExpression, ConditionField, ConditionGroup, ConditionOperator } from '../../api/generated/model';

/**
 * The pure model behind `FilterBuilder`: which fields and operators the view condition tree
 * accepts, the value shapes each needs, and immutable helpers to edit the tree by path. The
 * whitelists and limits mirror `apps/api/src/views/condition-schema.ts` (the API stays the
 * source of truth and re-validates everything).
 */

/** Limits from the API (`condition-schema.ts`): the root group is depth 1. */
export const MAX_NESTING_DEPTH = 3;
export const MAX_GROUP_ITEMS = 20;
export const MAX_TOTAL_CONDITIONS = 20;

export const NOW_LITERAL = 'now';
export const UNGROUPED = 'ungrouped';
export const ME = 'me';
export const UNASSIGNED = 'unassigned';

export interface LookupOption {
  id: string;
  name: string;
}

/**
 * Everything the value pickers list. The caller supplies the lists (the builder never fetches).
 * `customers` is searched server-side, so it is typically the last result of `onCustomerSearch`;
 * include the customers a view being edited already names, or they show as "Unknown customer".
 */
export interface FilterLookups {
  groups: readonly LookupOption[];
  users: readonly LookupOption[];
  tags: readonly LookupOption[];
  customers?: readonly LookupOption[];
  /** Called as the user types in a customer value picker. */
  onCustomerSearch?: (query: string) => void;
  /** `loading` disables nothing but shows progress in the pickers. Default `ready`. */
  status?: 'ready' | 'loading' | 'error';
  /** Shown with a "Try again" action when `status` is `error`. */
  onRetry?: () => void;
}

export const FIELD_ORDER: readonly ConditionField[] = [
  'state',
  'priority',
  'group',
  'owner',
  'tags',
  'waiting_on',
  'customer',
  'created_at',
  'updated_at',
  'last_customer_message_at',
  'pending_until',
  'sla_status',
];

/** Customers are found by searching, so the Customer field is offered only when the caller wires `onCustomerSearch` (or a condition already uses it). */
export function availableFields(lookups: Pick<FilterLookups, 'onCustomerSearch'>, current?: ConditionField): ConditionField[] {
  return FIELD_ORDER.filter((field) => field !== 'customer' || field === current || lookups.onCustomerSearch !== undefined);
}

export const FIELD_LABELS: Record<ConditionField, string> = {
  state: 'State',
  priority: 'Priority',
  group: 'Group',
  owner: 'Owner',
  customer: 'Customer',
  tags: 'Tags',
  waiting_on: 'Waiting on',
  created_at: 'Created',
  updated_at: 'Updated',
  last_customer_message_at: 'Last customer message',
  pending_until: 'Pending until',
  sla_status: 'SLA status',
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'has any of',
  before: 'is before',
  after: 'is after',
  within_last: 'is within the last',
};

/** Every operator the API accepts per field (`FIELD_OPERATORS`). */
const API_OPERATORS: Record<ConditionField, readonly ConditionOperator[]> = {
  state: ['is', 'is_not'],
  priority: ['is', 'is_not'],
  group: ['is', 'is_not'],
  owner: ['is', 'is_not'],
  customer: ['is', 'is_not'],
  tags: ['is', 'is_not', 'contains'],
  waiting_on: ['is', 'is_not'],
  created_at: ['before', 'after', 'within_last'],
  updated_at: ['before', 'after', 'within_last'],
  last_customer_message_at: ['before', 'after', 'within_last'],
  pending_until: ['before', 'after', 'within_last'],
  sla_status: ['is', 'is_not', 'contains', 'before', 'after', 'within_last'],
};

/** The operators offered first for a field (a subset of the API's, in the order people reach for them). */
const OFFERED_OPERATORS: Record<ConditionField, readonly ConditionOperator[]> = {
  state: ['is', 'is_not'],
  priority: ['is', 'is_not'],
  group: ['is', 'is_not'],
  owner: ['is', 'is_not'],
  customer: ['is', 'is_not'],
  tags: ['contains', 'is_not'],
  waiting_on: ['is', 'is_not'],
  created_at: ['within_last', 'before', 'after'],
  updated_at: ['within_last', 'before', 'after'],
  last_customer_message_at: ['within_last', 'before', 'after'],
  pending_until: ['within_last', 'before', 'after'],
  sla_status: ['is', 'is_not'],
};

export const DATE_FIELDS: readonly ConditionField[] = ['created_at', 'updated_at', 'last_customer_message_at', 'pending_until'];

export function isDateField(field: ConditionField): boolean {
  return DATE_FIELDS.includes(field);
}

/** Operators to list for `field`; `current` is kept in the list so an existing view still shows it. */
export function operatorsFor(field: ConditionField, current?: ConditionOperator): ConditionOperator[] {
  const offered = [...OFFERED_OPERATORS[field]];
  if (current !== undefined && !offered.includes(current) && API_OPERATORS[field].includes(current)) offered.push(current);
  return offered;
}

export function defaultOperator(field: ConditionField): ConditionOperator {
  return OFFERED_OPERATORS[field][0] ?? 'is';
}

export const DEFAULT_DURATION = 'P7D';

export function defaultValue(field: ConditionField, operator: ConditionOperator): unknown {
  if (isDateField(field)) return operator === 'within_last' ? DEFAULT_DURATION : NOW_LITERAL;
  if (field === 'sla_status') return '';
  return [];
}

export function newCondition(field: ConditionField): Condition {
  const operator = defaultOperator(field);
  return { field, operator, value: defaultValue(field, operator) };
}

/** Changing the operator of a date condition changes the value's shape, so it is reset. */
export function withOperator(condition: Condition, operator: ConditionOperator): Condition {
  if (!isDateField(condition.field)) return { ...condition, operator };
  const wasDuration = condition.operator === 'within_last';
  const isDuration = operator === 'within_last';
  return wasDuration === isDuration ? { ...condition, operator } : { ...condition, operator, value: defaultValue(condition.field, operator) };
}

// -------------------------------------------------------------------------------------------
// Relative durations: the stored value is an ISO 8601 duration (`PT30M`, `PT2H`, `P3D`, `P1W`).
// -------------------------------------------------------------------------------------------

export type DurationUnit = 'minutes' | 'hours' | 'days' | 'weeks';
export const DURATION_UNITS: readonly { value: DurationUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
];

export function formatDuration(amount: number, unit: DurationUnit): string {
  switch (unit) {
    case 'minutes':
      return `PT${amount}M`;
    case 'hours':
      return `PT${amount}H`;
    case 'days':
      return `P${amount}D`;
    case 'weeks':
      return `P${amount}W`;
  }
}

const DURATION_PATTERN = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

/** `amount` is 0 when the duration is zero or the user has cleared it; `null` when unparseable. */
export function parseDuration(value: unknown): { amount: number; unit: DurationUnit } | null {
  if (typeof value !== 'string') return null;
  const match = DURATION_PATTERN.exec(value);
  if (match === null || value === 'P' || value.endsWith('T')) return null;
  const [weeks, days, hours, minutes] = [match[1], match[2], match[3], match[4]].map((part) => (part === undefined ? 0 : Number(part)));
  const total = (weeks ?? 0) * 10080 + (days ?? 0) * 1440 + (hours ?? 0) * 60 + (minutes ?? 0);
  if (total === 0) {
    const unit: DurationUnit = value.includes('W') ? 'weeks' : value.includes('D') ? 'days' : value.includes('H') ? 'hours' : 'minutes';
    return { amount: 0, unit };
  }
  if (total % 10080 === 0) return { amount: total / 10080, unit: 'weeks' };
  if (total % 1440 === 0) return { amount: total / 1440, unit: 'days' };
  if (total % 60 === 0) return { amount: total / 60, unit: 'hours' };
  return { amount: total, unit: 'minutes' };
}

/** `datetime-local`'s value format in the browser's local time; `''` when there is nothing to show. */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || iso === NOW_LITERAL) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(local: string): string {
  if (local === '') return '';
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

// -------------------------------------------------------------------------------------------
// Values and completeness
// -------------------------------------------------------------------------------------------

export function valueList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === 'string' && item !== '');
}

export function isConditionComplete(condition: Condition): boolean {
  const { field, operator, value } = condition;
  if (isDateField(field)) {
    if (operator === 'within_last') {
      const parsed = parseDuration(value);
      return parsed !== null && parsed.amount > 0;
    }
    return value === NOW_LITERAL || (typeof value === 'string' && value !== '' && !Number.isNaN(new Date(value).getTime()));
  }
  return valueList(value).length > 0;
}

export function isGroup(node: ConditionExpression): node is ConditionGroup {
  return 'op' in node;
}

/** True when every condition has a value and no group is empty: what the preview and Save need. */
export function isTreeComplete(node: ConditionExpression): boolean {
  if (isGroup(node)) return node.items.length > 0 && node.items.every(isTreeComplete);
  return isConditionComplete(node);
}

export function countConditions(node: ConditionExpression): number {
  return isGroup(node) ? node.items.reduce((sum, item) => sum + countConditions(item), 0) : 1;
}

/** A plain-language summary of a condition, for announcements ("State is not Closed"). */
export function describeCondition(condition: Condition): string {
  return `${FIELD_LABELS[condition.field]} ${OPERATOR_LABELS[condition.operator]}`;
}

/** The first field not yet used anywhere in the tree, so a new row starts somewhere new. */
export function nextUnusedField(root: ConditionGroup, fields: readonly ConditionField[] = FIELD_ORDER): ConditionField {
  const used = new Set<ConditionField>();
  const visit = (node: ConditionExpression) => (isGroup(node) ? node.items.forEach(visit) : used.add(node.field));
  visit(root);
  return fields.find((field) => !used.has(field)) ?? 'state';
}

/** The pre-filled tree of a new view: "State is not Closed". */
export function defaultConditions(): ConditionGroup {
  return { op: 'and', items: [{ field: 'state', operator: 'is_not', value: ['closed'] }] };
}

// -------------------------------------------------------------------------------------------
// Immutable path edits. A path is the list of item indexes from the root group.
// -------------------------------------------------------------------------------------------

export type NodePath = readonly number[];

export function nodeAt(root: ConditionGroup, path: NodePath): ConditionExpression | undefined {
  let node: ConditionExpression = root;
  for (const index of path) {
    if (!isGroup(node)) return undefined;
    const next: ConditionExpression | undefined = node.items[index];
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

export function replaceAt(root: ConditionGroup, path: NodePath, replacement: ConditionExpression): ConditionGroup {
  const [head, ...rest] = path;
  if (head === undefined) return isGroup(replacement) ? replacement : root;
  return { ...root, items: root.items.map((item, index) => (index !== head ? item : rest.length === 0 ? replacement : isGroup(item) ? replaceAt(item, rest, replacement) : item)) };
}

export function removeAt(root: ConditionGroup, path: NodePath): ConditionGroup {
  const [head, ...rest] = path;
  if (head === undefined) return root;
  if (rest.length === 0) return { ...root, items: root.items.filter((_, index) => index !== head) };
  return { ...root, items: root.items.map((item, index) => (index === head && isGroup(item) ? removeAt(item, rest) : item)) };
}

export function pathKey(path: NodePath): string {
  return ['r', ...path].join('-');
}

/** The API `details` path of a node: `conditions.items.1.items.0`. */
export function errorPath(prefix: string, path: NodePath): string {
  return path.reduce((acc, index) => `${acc}.items.${index}`, prefix);
}
