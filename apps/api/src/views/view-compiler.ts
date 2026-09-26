import { Injectable } from '@nestjs/common';
import { sql, type Expression, type SqlBool } from 'kysely';
import { Duration } from 'luxon';

import { PolicyService } from '../authorization/policy.service.js';
import { validationFailed, type ErrorDetail } from '../platform-kernel/http/app-error.js';
import { toDetails } from '../platform-kernel/http/validation.pipe.js';

import {
  ConditionExpressionSchema,
  FIELD_OPERATORS,
  MAX_NESTING_DEPTH,
  MAX_TOTAL_CONDITIONS,
  NOW_LITERAL,
  isConditionGroup,
  valueSchemaFor,
  type Condition,
  type ConditionExpression,
  type ConditionOperator,
} from './condition-schema.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Turns a view's stored (or proposed) condition tree into the ticket filter for one viewer, at one
 * moment (research D13, data-model.md "views"). The final query is always:
 *
 *   tenant filter (RLS + `TenantRepository.selectFrom`) AND `ticketAccessFilter(viewer, 'view')`
 *   AND the compiled expression
 *
 * `validateConditions` is the single place client-supplied conditions (view create/update) are
 * checked; `compileConditions` assumes an already-validated tree (a stored view is trusted, but
 * still re-validated on write, never on every read).
 */

// -------------------------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------------------------

/**
 * Parses and validates untrusted input (contracts/tickets.yaml `ViewInput.conditions`) into a
 * `ConditionExpression`: JSON Schema shape, then the semantic pass (field/operator pairing, value
 * shape, "maximum nesting depth 3, maximum 20 conditions"). Throws `AppError` (400
 * `VALIDATION_FAILED`) on any failure.
 */
export function validateConditions(input: unknown): ConditionExpression {
  const parsed = ConditionExpressionSchema.safeParse(input);
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error.issues, input));
  }
  const tree = parsed.data;
  walk(tree, 'conditions', 1, { total: 0 });
  return tree;
}

interface WalkState {
  total: number;
}

function walk(node: ConditionExpression, path: string, depth: number, state: WalkState): void {
  if (isConditionGroup(node)) {
    if (depth > MAX_NESTING_DEPTH) {
      throw validationFailed([{ path, issue: 'invalid' }]);
    }
    node.items.forEach((item, index) => walk(item, `${path}.items.${index}`, depth + 1, state));
    return;
  }
  state.total += 1;
  if (state.total > MAX_TOTAL_CONDITIONS) {
    throw validationFailed([{ path, issue: 'too_many' }]);
  }
  validateLeaf(node, path);
}

function validateLeaf(node: Condition, path: string): void {
  const allowed = FIELD_OPERATORS[node.field];
  if (!allowed.includes(node.operator)) {
    throw validationFailed([{ path: `${path}.operator`, issue: 'invalid_value' }]);
  }
  const schema = valueSchemaFor(node.field, node.operator);
  const result = schema.safeParse(node.value);
  if (!result.success) {
    const details: ErrorDetail[] = toDetails(result.error.issues, node.value).map((detail) => ({
      path: detail.path.length === 0 ? `${path}.value` : `${path}.value.${detail.path}`,
      issue: detail.issue,
    }));
    throw validationFailed(details);
  }
}

// -------------------------------------------------------------------------------------------
// Compilation
// -------------------------------------------------------------------------------------------

export interface CompileParams {
  /** Resolves `owner is me` (data-model.md "Condition expression"): the signed-in viewer's id. */
  viewerId: string;
  /** Resolves `within_last`: query-time "now" (platform-kernel/clock.ts `Clock.now()`). */
  now: Date;
}

/**
 * Compiles an already-validated tree to a parameterized Kysely expression over an aliased
 * `tickets` table. Corrupt stored data (a value `validateConditions` would have rejected) throws a
 * plain `Error`, not `AppError`: that is a server bug, not a client mistake.
 */
export function compileConditions(tree: ConditionExpression, params: CompileParams): Expression<SqlBool> {
  return compileNode(tree, params);
}

function compileNode(node: ConditionExpression, params: CompileParams): Expression<SqlBool> {
  if (isConditionGroup(node)) {
    const parts = node.items.map((item) => compileNode(item, params));
    const joiner = node.op === 'and' ? sql` AND ` : sql` OR `;
    return sql<SqlBool>`(${sql.join(parts, joiner)})`;
  }
  return compileLeaf(node, params);
}

function compileLeaf(node: Condition, params: CompileParams): Expression<SqlBool> {
  switch (node.field) {
    case 'state':
      return enumFilter('tickets.state', node.operator, node.value);
    case 'priority':
      return enumFilter('tickets.priority', node.operator, node.value);
    case 'waiting_on':
      return enumFilter('tickets.waiting_on', node.operator, node.value);
    case 'customer':
      return idFilter('tickets.customer_id', node.operator, node.value);
    case 'group':
      return groupFilter(node.operator, node.value);
    case 'owner':
      return ownerFilter(node.operator, node.value, params.viewerId);
    case 'tags':
      return tagsFilter(node.operator, node.value);
    case 'created_at':
      return dateFilter('tickets.created_at', node.operator, node.value, params.now);
    case 'updated_at':
      return dateFilter('tickets.updated_at', node.operator, node.value, params.now);
    case 'last_customer_message_at':
      return dateFilter('tickets.last_customer_message_at', node.operator, node.value, params.now);
    case 'pending_until':
      return dateFilter('tickets.pending_until', node.operator, node.value, params.now);
    case 'sla_status':
      // Accepted but matches nothing until US12 gives tickets an `sla_status` (data-model.md "views").
      return sql<SqlBool>`false`;
  }
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function toStringArray(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (typeof item !== 'string') throw new Error(`Expected a string condition value, got ${typeof item}`);
    return item;
  });
}

/** `column IN (values)`, or its negation; `values` come from an enum whitelist (text columns). */
function enumFilter(column: string, operator: ConditionOperator, value: unknown): Expression<SqlBool> {
  const values = toStringArray(value);
  const membership = sql<SqlBool>`${sql.ref(column)} = ANY(${sql.val(values)}::text[])`;
  return operator === 'is_not' ? sql<SqlBool>`NOT (${membership})` : membership;
}

/** `column IN (values)`, or its negation; `values` are uuids (customer/tag ids). */
function idFilter(column: string, operator: ConditionOperator, value: unknown): Expression<SqlBool> {
  const values = toStringArray(value);
  const membership = sql<SqlBool>`${sql.ref(column)} = ANY(${sql.val(values)}::uuid[])`;
  return operator === 'is_not' ? sql<SqlBool>`NOT (${membership})` : membership;
}

/** `group is [ids..., 'ungrouped']`: membership over specific group ids plus "no group". */
function groupFilter(operator: ConditionOperator, value: unknown): Expression<SqlBool> {
  const raw = toStringArray(value);
  const ids = raw.filter((item) => item !== 'ungrouped');
  const includesUngrouped = raw.includes('ungrouped');
  const membership = membershipExpression('tickets.group_id', ids, includesUngrouped);
  return operator === 'is_not' ? sql<SqlBool>`NOT (${membership})` : membership;
}

/** `owner is [ids..., 'me', 'unassigned']`: `me` resolves to the viewer at query time. */
function ownerFilter(operator: ConditionOperator, value: unknown, viewerId: string): Expression<SqlBool> {
  const raw = toStringArray(value);
  const ids = new Set(raw.filter((item) => item !== 'me' && item !== 'unassigned'));
  if (raw.includes('me')) ids.add(viewerId);
  const includesUnassigned = raw.includes('unassigned');
  const membership = membershipExpression('tickets.owner_id', [...ids], includesUnassigned);
  return operator === 'is_not' ? sql<SqlBool>`NOT (${membership})` : membership;
}

/** `column = ANY(ids) [OR column IS NULL]`; `false` when nothing is asked for. */
function membershipExpression(column: string, ids: readonly string[], includesNull: boolean): Expression<SqlBool> {
  const ref = sql.ref(column);
  const parts: Expression<SqlBool>[] = [];
  if (ids.length > 0) parts.push(sql<SqlBool>`${ref} = ANY(${sql.val(ids)}::uuid[])`);
  if (includesNull) parts.push(sql<SqlBool>`${ref} IS NULL`);
  if (parts.length === 0) return sql<SqlBool>`false`;
  return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
}

/**
 * `EXISTS` over `ticket_tags` for the outer `tickets` row (`tenant_id` matched explicitly:
 * tenant-scoping rule 5). `is` and `contains` both mean "has any of these tags"; `is_not` negates.
 */
function tagsFilter(operator: ConditionOperator, value: unknown): Expression<SqlBool> {
  const ids = toStringArray(value);
  const exists = sql<SqlBool>`EXISTS (
    SELECT 1 FROM ticket_tags
    WHERE ticket_tags.tenant_id = tickets.tenant_id
      AND ticket_tags.ticket_id = tickets.id
      AND ticket_tags.tag_id = ANY(${sql.val(ids)}::uuid[])
  )`;
  return operator === 'is_not' ? sql<SqlBool>`NOT (${exists})` : exists;
}

function dateFilter(column: string, operator: ConditionOperator, value: unknown, now: Date): Expression<SqlBool> {
  const ref = sql.ref(column);
  if (operator === 'within_last') {
    const duration = Duration.fromISO(String(value));
    if (!duration.isValid) throw new Error(`Invalid within_last duration: ${String(value)}`);
    const threshold = new Date(now.getTime() - duration.as('milliseconds'));
    return sql<SqlBool>`${ref} >= ${sql.val(threshold)}`;
  }
  // `before`/`after` accept an absolute timestamp or the relative literal "now" (resolved here,
  // at query time, from `params.now` — never from `Date.now()` directly: platform-kernel/clock.ts).
  const timestamp = value === NOW_LITERAL ? now : new Date(String(value));
  if (Number.isNaN(timestamp.getTime())) throw new Error(`Invalid date value: ${String(value)}`);
  return operator === 'before' ? sql<SqlBool>`${ref} < ${sql.val(timestamp)}` : sql<SqlBool>`${ref} > ${sql.val(timestamp)}`;
}

// -------------------------------------------------------------------------------------------
// Full filter (view read/list paths)
// -------------------------------------------------------------------------------------------

/** The signed-in user actor's id; only user actors view tickets (policy.service.ts "actorUserId"). */
function viewerIdOf(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') {
    throw new Error(`Views are compiled for user actors, not ${ctx.actor.kind}`);
  }
  return ctx.actor.id;
}

@Injectable()
export class ViewCompiler {
  constructor(private readonly policyService: PolicyService) {}

  /** Parses and validates a view's conditions (view create/update). */
  validate(input: unknown): ConditionExpression {
    return validateConditions(input);
  }

  /**
   * The ticket filter for `tree` as seen by `ctx`'s actor right now: `ticketAccessFilter(ctx,
   * 'view')` AND the compiled tree (research D13). Combine with a tenant-scoped `tickets` query
   * (`TenantRepository.selectFrom` already adds the tenant filter); this does not repeat it.
   */
  async filterFor(ctx: TenantContext, tree: ConditionExpression, now: Date): Promise<Expression<SqlBool>> {
    const viewerId = viewerIdOf(ctx);
    const access = await this.policyService.ticketAccessFilter(ctx, 'view');
    const compiled = compileConditions(tree, { viewerId, now });
    return sql<SqlBool>`(${access} AND ${compiled})`;
  }
}

export type { Condition, ConditionExpression, ConditionField, ConditionGroup, ConditionOperator } from './condition-schema.js';
