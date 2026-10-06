import { isConditionGroup, type ConditionExpression } from '../views/condition-schema.js';

import type { TicketPriority } from '../platform-kernel/db/tables/tickets.js';

/**
 * Which SLA policy applies to a ticket (research D15, FR-084). Pure: no database, clock or Nest.
 *
 * Policies are taken in ascending `position` (ties by id); the first whose conditions match wins.
 * `conditions` is the shared condition tree (contracts/common.yaml `ConditionGroup`):
 *
 * - `{}` or a group without items matches every ticket ("an empty group matches all").
 * - `priority` and `group` are the supported fields, with `is` / `is_not`; the value is one value
 *   or a list (any of). `group` also accepts the literal `ungrouped`, which matches a ticket that
 *   has no group. A policy that names a group never matches an ungrouped ticket unless it lists
 *   `ungrouped`.
 * - Any other field or operator can't be evaluated here, so that leaf counts as NOT matching
 *   (`is_not` included): an unfinished policy never catches tickets it was not meant for.
 */

export interface SlaSubject {
  priority: TicketPriority;
  /** `null` = Ungrouped. */
  groupId: string | null;
}

export interface PolicyRecord {
  id: string;
  position: number;
  conditions: unknown;
}

function valuesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function leafMatches(field: string, operator: string, value: unknown, subject: SlaSubject): boolean {
  if (operator !== 'is' && operator !== 'is_not') return false;
  const values = valuesOf(value);
  let isIn: boolean;
  if (field === 'priority') isIn = values.includes(subject.priority);
  else if (field === 'group') isIn = subject.groupId === null ? values.includes('ungrouped') : values.includes(subject.groupId);
  else return false;
  return operator === 'is' ? isIn : !isIn;
}

function nodeMatches(node: unknown, subject: SlaSubject): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const expression = node as ConditionExpression;
  if (isConditionGroup(expression)) {
    const items = Array.isArray(expression.items) ? expression.items : [];
    if (items.length === 0) return true;
    return expression.op === 'or' ? items.some((item) => nodeMatches(item, subject)) : items.every((item) => nodeMatches(item, subject));
  }
  return leafMatches(String(expression.field), String(expression.operator), expression.value, subject);
}

/** True when a policy's stored conditions match the ticket (`{}` matches all). */
export function conditionsMatch(conditions: unknown, subject: SlaSubject): boolean {
  if (typeof conditions !== 'object' || conditions === null || Object.keys(conditions).length === 0) return true;
  return nodeMatches(conditions, subject);
}

/** The first matching policy by position, or `undefined` when none applies. */
export function firstMatchingPolicy<T extends PolicyRecord>(policies: readonly T[], subject: SlaSubject): T | undefined {
  const ordered = [...policies].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ordered.find((policy) => conditionsMatch(policy.conditions, subject));
}
