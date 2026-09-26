import { Duration } from 'luxon';
import { z } from 'zod';

import type { TicketPriority, TicketState, WaitingOn } from '../platform-kernel/db/tables/tickets.js';

/**
 * The view condition tree (data-model.md "views" § "Condition expression",
 * contracts/common.yaml `ConditionGroup` / `Condition` / `ConditionExpression`). Groups (`and` /
 * `or`) of leaf conditions over a whitelist of fields and operators (FR-075). Relative values
 * (`me`, `unassigned`, `ungrouped`, `now` for `before`/`after`, an ISO 8601 duration for
 * `within_last`) are resolved at query time by `view-compiler.ts`, never stored resolved.
 *
 * `ConditionExpressionSchema` mirrors the OpenAPI JSON Schema structurally (whitelisted fields and
 * operators, `additionalProperties: false`, up to 20 items per group); `view-compiler.ts` layers a
 * semantic pass on top (field/operator pairing, value shape, nesting depth, total condition
 * count) because those rules don't reduce to a single JSON Schema.
 */

export const CONDITION_FIELDS = [
  'state',
  'priority',
  'group',
  'owner',
  'customer',
  'tags',
  'waiting_on',
  'created_at',
  'updated_at',
  'last_customer_message_at',
  'pending_until',
  // Accepted so views compile, but matches nothing until US12 adds SLA (data-model.md "views").
  'sla_status',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPERATORS = ['is', 'is_not', 'contains', 'before', 'after', 'within_last'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface Condition {
  field: ConditionField;
  operator: ConditionOperator;
  value: unknown;
}

export interface ConditionGroup {
  op: 'and' | 'or';
  items: ConditionExpression[];
}

export type ConditionExpression = ConditionGroup | Condition;

export function isConditionGroup(node: ConditionExpression): node is ConditionGroup {
  return 'op' in node;
}

/** data-model.md "Condition expression": "maximum nesting depth 3, maximum 20 conditions". */
export const MAX_GROUP_ITEMS = 20;
export const MAX_NESTING_DEPTH = 3;
export const MAX_TOTAL_CONDITIONS = 20;

const ConditionSchema = z
  .object({
    field: z.enum(CONDITION_FIELDS),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.unknown(),
  })
  .strict();

/** Declared ahead of `ConditionExpressionSchema` so the mutual recursion below resolves. */
const ConditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(['and', 'or']),
      items: z.array(ConditionExpressionSchema).min(1).max(MAX_GROUP_ITEMS),
    })
    .strict(),
);

export const ConditionExpressionSchema: z.ZodType<ConditionExpression> = z.lazy(() =>
  z.union([ConditionGroupSchema, ConditionSchema]),
);

// -------------------------------------------------------------------------------------------
// Per-field operator and value whitelists (semantic pass; the JSON Schema only whitelists the
// field/operator vocabulary as a whole, not which operator applies to which field).
// -------------------------------------------------------------------------------------------

const TICKET_STATES = ['new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed'] as const satisfies readonly TicketState[];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const satisfies readonly TicketPriority[];
const WAITING_ON = ['support', 'customer'] as const satisfies readonly WaitingOn[];

function arrayable<T extends z.ZodType>(item: T) {
  return z.union([item, z.array(item).min(1)]);
}

const IsoDurationValue = z.string().refine((value) => Duration.fromISO(value).isValid, 'invalid_duration');

/** `before`/`after` accept an absolute timestamp or the relative literal `"now"`. */
export const NOW_LITERAL = 'now';
const DateValue = z.union([z.literal(NOW_LITERAL), z.iso.datetime()]);

export const FIELD_OPERATORS: Readonly<Record<ConditionField, readonly ConditionOperator[]>> = {
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

/** Value schema for a validated field/operator pair; call only after checking `FIELD_OPERATORS`. */
export function valueSchemaFor(field: ConditionField, operator: ConditionOperator): z.ZodType {
  switch (field) {
    case 'state':
      return arrayable(z.enum(TICKET_STATES));
    case 'priority':
      return arrayable(z.enum(TICKET_PRIORITIES));
    case 'waiting_on':
      return arrayable(z.enum(WAITING_ON));
    case 'group':
      return arrayable(z.union([z.uuid(), z.literal('ungrouped')]));
    case 'owner':
      return arrayable(z.union([z.uuid(), z.literal('me'), z.literal('unassigned')]));
    case 'customer':
    case 'tags':
      return arrayable(z.uuid());
    case 'created_at':
    case 'updated_at':
    case 'last_customer_message_at':
    case 'pending_until':
      return operator === 'within_last' ? IsoDurationValue : DateValue;
    case 'sla_status':
      // Not yet a real field (US12): accept a permissive shape, since it matches nothing anyway.
      return arrayable(z.string());
  }
}
