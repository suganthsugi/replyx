import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql, type Expression, type SqlBool } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { AppError } from '../../../src/platform-kernel/http/app-error.js';
import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  FIELD_OPERATORS,
  MAX_NESTING_DEPTH,
  MAX_TOTAL_CONDITIONS,
} from '../../../src/views/condition-schema.js';
import { ViewCompiler, compileConditions, validateConditions, type Condition, type ConditionExpression } from '../../../src/views/view-compiler.js';

/**
 * Unit tests for `apps/api/src/views/condition-schema.ts` and `view-compiler.ts` (T148). Compiles
 * without a database, the same "dummy" dialect approach as
 * `test/unit/authorization/policy.service.test.ts`.
 */

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';
const VIEWER = '0192f3c4-0000-7000-8000-0000000000a1';
const OTHER_USER = '0192f3c4-0000-7000-8000-0000000000a2';
const GROUP_A = '0192f3c4-0000-7000-8000-0000000000b1';
const GROUP_B = '0192f3c4-0000-7000-8000-0000000000b2';
const CUSTOMER = '0192f3c4-0000-7000-8000-0000000000c1';
const TAG = '0192f3c4-0000-7000-8000-0000000000d1';

const NOW = new Date('2026-01-15T12:00:00.000Z');

const db = new Kysely<object>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

function compileSql(expr: Expression<SqlBool>) {
  return sql`${expr}`.compile(db);
}

function group(items: ConditionExpression[], op: 'and' | 'or' = 'and'): ConditionExpression {
  return { op, items };
}

function compile(tree: ConditionExpression, params: { viewerId?: string; now?: Date } = {}) {
  return compileSql(compileConditions(tree, { viewerId: params.viewerId ?? VIEWER, now: params.now ?? NOW }));
}

describe('condition validation: every field/operator pairing', () => {
  const VALID_VALUE: Record<string, unknown> = {
    state: 'open',
    priority: 'high',
    group: GROUP_A,
    owner: OTHER_USER,
    customer: CUSTOMER,
    tags: TAG,
    waiting_on: 'support',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_customer_message_at: '2026-01-01T00:00:00.000Z',
    pending_until: '2026-01-01T00:00:00.000Z',
    sla_status: 'warning',
  };

  for (const field of CONDITION_FIELDS) {
    for (const operator of FIELD_OPERATORS[field]) {
      it(`accepts ${field} ${operator}`, () => {
        const value = operator === 'within_last' ? 'P1D' : VALID_VALUE[field];
        const tree = group([{ field, operator, value }]);
        expect(validateConditions(tree)).toEqual(tree);
      });
    }
    for (const operator of CONDITION_OPERATORS) {
      if (FIELD_OPERATORS[field].includes(operator)) continue;
      it(`rejects ${field} ${operator} (not a whitelisted pairing)`, () => {
        const tree = group([{ field, operator, value: VALID_VALUE[field] }]);
        expect(() => validateConditions(tree)).toThrow(AppError);
        try {
          validateConditions(tree);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).code).toBe('VALIDATION_FAILED');
          expect((error as AppError).details).toEqual([{ path: 'conditions.items.0.operator', issue: 'invalid_value' }]);
        }
      });
    }
  }

  it('accepts pending_until with before, after and within_last', () => {
    const tree = group([
      { field: 'pending_until', operator: 'before', value: 'now' },
      { field: 'pending_until', operator: 'after', value: '2026-01-01T00:00:00.000Z' },
      { field: 'pending_until', operator: 'within_last', value: 'P2DT3H' },
    ]);
    expect(validateConditions(tree)).toEqual(tree);
  });

  it('accepts the "now" literal for before/after but not for within_last', () => {
    expect(() => validateConditions(group([{ field: 'created_at', operator: 'before', value: 'now' }]))).not.toThrow();
    expect(() => validateConditions(group([{ field: 'created_at', operator: 'after', value: 'now' }]))).not.toThrow();
    expect(() => validateConditions(group([{ field: 'created_at', operator: 'within_last', value: 'now' }]))).toThrow(AppError);
  });

  it('rejects an invalid ISO duration for within_last', () => {
    expect(() => validateConditions(group([{ field: 'created_at', operator: 'within_last', value: 'not-a-duration' }]))).toThrow(
      AppError,
    );
  });

  it('rejects an invalid absolute timestamp for before/after', () => {
    expect(() => validateConditions(group([{ field: 'created_at', operator: 'before', value: 'not-a-date' }]))).toThrow(AppError);
  });

  it('rejects a value shape the field does not accept', () => {
    expect(() => validateConditions(group([{ field: 'state', operator: 'is', value: 'not-a-state' }]))).toThrow(AppError);
    expect(() => validateConditions(group([{ field: 'owner', operator: 'is', value: 'not-a-uuid-or-relative' }]))).toThrow(AppError);
  });

  it('sla_status accepts a permissive string shape even though it is not a real field yet', () => {
    const tree = group([{ field: 'sla_status', operator: 'is', value: ['warning', 'breached'] }]);
    expect(validateConditions(tree)).toEqual(tree);
  });
});

describe('depth and count limits', () => {
  it('accepts nesting exactly at the depth limit (3)', () => {
    // depth 1 (root) -> depth 2 -> depth 3 leaf group is fine.
    const tree = group([group([group([{ field: 'state', operator: 'is', value: 'open' }])])]);
    expect(() => validateConditions(tree)).not.toThrow();
  });

  it(`rejects nesting deeper than ${MAX_NESTING_DEPTH}`, () => {
    // depth 1 -> 2 -> 3 -> 4: one level past the limit.
    const tooDeep = group([group([group([group([{ field: 'state', operator: 'is', value: 'open' }])])])]);
    expect(() => validateConditions(tooDeep)).toThrow(AppError);
    try {
      validateConditions(tooDeep);
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).details).toEqual([{ path: 'conditions.items.0.items.0.items.0', issue: 'invalid' }]);
    }
  });

  it(`accepts exactly ${MAX_TOTAL_CONDITIONS} total conditions spread across nested groups`, () => {
    // Two sibling groups of 10 leaves each (20 total), each within the 20-items-per-group cap.
    const ten = (): Condition[] => Array.from({ length: 10 }, () => ({ field: 'state', operator: 'is', value: 'open' }));
    const tree = group([group(ten()), group(ten())]);
    expect(() => validateConditions(tree)).not.toThrow();
  });

  it(`rejects more than ${MAX_TOTAL_CONDITIONS} total conditions even split across groups`, () => {
    const eleven = (): Condition[] => Array.from({ length: 11 }, () => ({ field: 'state', operator: 'is', value: 'open' }));
    const tree = group([group(eleven()), group(eleven())]);
    expect(() => validateConditions(tree)).toThrow(AppError);
    try {
      validateConditions(tree);
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).details?.[0]?.issue).toBe('too_many');
    }
  });

  it('rejects more than 20 items in a single group at the schema level', () => {
    const tooManyInOneGroup = group(Array.from({ length: 21 }, () => ({ field: 'state', operator: 'is', value: 'open' })));
    expect(() => validateConditions(tooManyInOneGroup)).toThrow(AppError);
  });
});

describe('relative values', () => {
  it('owner "me" resolves to the compiling viewer, ORed with any explicit ids', () => {
    const tree: ConditionExpression = { field: 'owner', operator: 'is', value: 'me' };
    const compiled = compile(tree, { viewerId: OTHER_USER });
    expect(compiled.sql).toBe('("tickets"."owner_id" = ANY($1::uuid[]))');
    expect(compiled.parameters).toEqual([[OTHER_USER]]);
  });

  it('owner "unassigned" compiles to IS NULL', () => {
    const compiled = compile({ field: 'owner', operator: 'is', value: 'unassigned' });
    expect(compiled.sql).toBe('("tickets"."owner_id" IS NULL)');
  });

  it('owner combines an explicit id, "me" and "unassigned" in one OR', () => {
    const compiled = compile({ field: 'owner', operator: 'is', value: [GROUP_A, 'me', 'unassigned'] }, { viewerId: VIEWER });
    expect(compiled.sql).toBe('("tickets"."owner_id" = ANY($1::uuid[]) OR "tickets"."owner_id" IS NULL)');
    // Order-independent: both ids must be present exactly once.
    expect(new Set(compiled.parameters[0] as string[])).toEqual(new Set([GROUP_A, VIEWER]));
  });

  it('group "ungrouped" compiles to IS NULL, negated by is_not', () => {
    expect(compile({ field: 'group', operator: 'is', value: 'ungrouped' }).sql).toBe('("tickets"."group_id" IS NULL)');
    expect(compile({ field: 'group', operator: 'is_not', value: 'ungrouped' }).sql).toBe('NOT (("tickets"."group_id" IS NULL))');
  });

  it('group combines explicit ids with "ungrouped"', () => {
    const compiled = compile({ field: 'group', operator: 'is', value: [GROUP_A, GROUP_B, 'ungrouped'] });
    expect(compiled.sql).toBe('("tickets"."group_id" = ANY($1::uuid[]) OR "tickets"."group_id" IS NULL)');
    expect(compiled.parameters).toEqual([[GROUP_A, GROUP_B]]);
  });

  it('within_last resolves an ISO duration against query-time "now"', () => {
    const compiled = compile({ field: 'created_at', operator: 'within_last', value: 'P1D' }, { now: NOW });
    expect(compiled.sql).toBe('"tickets"."created_at" >= $1');
    expect(compiled.parameters).toEqual([new Date(NOW.getTime() - 24 * 3_600_000)]);
  });

  it('within_last on pending_until resolves against "now" too', () => {
    const compiled = compile({ field: 'pending_until', operator: 'within_last', value: 'PT2H' }, { now: NOW });
    expect(compiled.sql).toBe('"tickets"."pending_until" >= $1');
    expect(compiled.parameters).toEqual([new Date(NOW.getTime() - 2 * 3_600_000)]);
  });

  it('the "now" literal on before/after resolves to query-time now, not a stored value', () => {
    const before = compile({ field: 'pending_until', operator: 'before', value: 'now' }, { now: NOW });
    expect(before.sql).toBe('"tickets"."pending_until" < $1');
    expect(before.parameters).toEqual([NOW]);

    const after = compile({ field: 'created_at', operator: 'after', value: 'now' }, { now: NOW });
    expect(after.sql).toBe('"tickets"."created_at" > $1');
    expect(after.parameters).toEqual([NOW]);
  });

  it('an absolute timestamp on before/after is used as-is', () => {
    const absolute = new Date('2020-05-05T00:00:00.000Z');
    const compiled = compile({ field: 'created_at', operator: 'before', value: absolute.toISOString() }, { now: NOW });
    expect(compiled.parameters).toEqual([absolute]);
  });
});

describe('every field and operator compiles', () => {
  it('state / priority / waiting_on: is and is_not compile to (NOT) membership', () => {
    expect(compile({ field: 'state', operator: 'is', value: ['open', 'new'] }).sql).toBe('"tickets"."state" = ANY($1::text[])');
    expect(compile({ field: 'state', operator: 'is_not', value: 'closed' }).sql).toBe(
      'NOT ("tickets"."state" = ANY($1::text[]))',
    );
    expect(compile({ field: 'priority', operator: 'is', value: 'high' }).sql).toBe('"tickets"."priority" = ANY($1::text[])');
    expect(compile({ field: 'waiting_on', operator: 'is_not', value: 'support' }).sql).toBe(
      'NOT ("tickets"."waiting_on" = ANY($1::text[]))',
    );
  });

  it('customer: is and is_not compile to (NOT) uuid membership', () => {
    expect(compile({ field: 'customer', operator: 'is', value: CUSTOMER }).sql).toBe('"tickets"."customer_id" = ANY($1::uuid[])');
    expect(compile({ field: 'customer', operator: 'is_not', value: CUSTOMER }).sql).toBe(
      'NOT ("tickets"."customer_id" = ANY($1::uuid[]))',
    );
  });

  it('tags: is, is_not and contains all compile to an EXISTS over ticket_tags scoped by tenant', () => {
    for (const operator of ['is', 'is_not', 'contains'] as const) {
      const compiled = compile({ field: 'tags', operator, value: TAG });
      expect(compiled.sql).toContain('EXISTS');
      expect(compiled.sql).toContain('ticket_tags.tenant_id = tickets.tenant_id');
      expect(compiled.sql).toContain('ticket_tags.ticket_id = tickets.id');
      expect(compiled.sql).toContain('ticket_tags.tag_id = ANY($1::uuid[])');
      if (operator === 'is_not') expect(compiled.sql.startsWith('NOT (EXISTS')).toBe(true);
      else expect(compiled.sql.startsWith('EXISTS')).toBe(true);
    }
  });

  it('created_at / updated_at / last_customer_message_at / pending_until: before and after', () => {
    for (const column of ['created_at', 'updated_at', 'last_customer_message_at', 'pending_until'] as const) {
      const before = compile({ field: column, operator: 'before', value: '2026-01-01T00:00:00.000Z' });
      expect(before.sql).toBe(`"tickets"."${column}" < $1`);
      const after = compile({ field: column, operator: 'after', value: '2026-01-01T00:00:00.000Z' });
      expect(after.sql).toBe(`"tickets"."${column}" > $1`);
    }
  });

  it('sla_status matches nothing for every operator (not a real field until US12)', () => {
    for (const operator of FIELD_OPERATORS.sla_status) {
      const compiled = compile({ field: 'sla_status', operator, value: 'warning' });
      expect(compiled.sql).toBe('false');
    }
  });
});

describe('groups combine with AND/OR', () => {
  it('joins group items with the requested operator, parenthesized once at the group level', () => {
    const and = compile(group([
      { field: 'state', operator: 'is', value: 'open' },
      { field: 'priority', operator: 'is', value: 'high' },
    ]));
    expect(and.sql).toBe('("tickets"."state" = ANY($1::text[]) AND "tickets"."priority" = ANY($2::text[]))');

    const or = compile(
      group(
        [
          { field: 'state', operator: 'is', value: 'open' },
          { field: 'priority', operator: 'is', value: 'high' },
        ],
        'or',
      ),
    );
    expect(or.sql).toBe('("tickets"."state" = ANY($1::text[]) OR "tickets"."priority" = ANY($2::text[]))');
  });
});

describe('ViewCompiler.filterFor: the access filter is always ANDed', () => {
  function ctxFor(userId: string) {
    return TenantContext.create({ tenantId: TENANT, actor: { kind: 'user', id: userId }, requestId: 'test-req' });
  }

  it('ANDs the access filter with the compiled tree, regardless of the tree\'s own operator', async () => {
    const ticketAccessFilter = vi.fn().mockResolvedValue(sql<SqlBool>`"tickets"."group_id" = ANY(ARRAY[]::uuid[])`);
    const compiler = new ViewCompiler({ ticketAccessFilter } as never);

    const orTree = group(
      [
        { field: 'state', operator: 'is', value: 'open' },
        { field: 'priority', operator: 'is', value: 'high' },
      ],
      'or',
    );
    const result = await compiler.filterFor(ctxFor(VIEWER), orTree, NOW);
    const compiled = compileSql(result);
    expect(compiled.sql).toBe(
      '("tickets"."group_id" = ANY(ARRAY[]::uuid[]) AND ("tickets"."state" = ANY($1::text[]) OR "tickets"."priority" = ANY($2::text[])))',
    );
    expect(ticketAccessFilter).toHaveBeenCalledWith(ctxFor(VIEWER), 'view');
  });

  it('the access filter is ANDed even for a single, unconditionally-true view tree', async () => {
    const ticketAccessFilter = vi.fn().mockResolvedValue(sql<SqlBool>`false`);
    const compiler = new ViewCompiler({ ticketAccessFilter } as never);
    const result = await compiler.filterFor(ctxFor(VIEWER), { field: 'state', operator: 'is', value: 'open' }, NOW);
    expect(compileSql(result).sql).toBe('(false AND "tickets"."state" = ANY($1::text[]))');
  });

  it('rejects a non-user actor', async () => {
    const compiler = new ViewCompiler({ ticketAccessFilter: vi.fn() } as never);
    const system = TenantContext.create({ tenantId: TENANT, actor: { kind: 'system' }, requestId: 'r' });
    await expect(compiler.filterFor(system, { field: 'state', operator: 'is', value: 'open' }, NOW)).rejects.toThrow('user actors');
  });
});
