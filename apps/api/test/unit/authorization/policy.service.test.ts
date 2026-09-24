import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AccessRepository,
  accessCacheKey,
  decide,
  emptyAccess,
  grantedGroups,
  groupFilter,
  PolicyService,
  type EffectiveAccess,
  type GroupFlags,
} from '../../../src/authorization/policy.service.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';
const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const SUPPORT = '0192f3c4-0000-7000-8000-0000000000b1';
const BILLING = '0192f3c4-0000-7000-8000-0000000000b2';

const NONE: GroupFlags = { view: false, create: false, edit: false, delete: false };
const flags = (partial: Partial<GroupFlags>): GroupFlags => ({ ...NONE, ...partial });

function access(permissions: string[], groups: [string | null, GroupFlags][]): EffectiveAccess {
  return { userId: USER, accessVersion: '0', permissions: new Set(permissions), groups: new Map(groups) };
}

/** Two roles merged the way the repository merges them: set union and per-group `bool_or`. */
function union(...roles: { permissions: string[]; groups: [string | null, GroupFlags][] }[]): EffectiveAccess {
  const groups = new Map<string | null, GroupFlags>();
  for (const role of roles) {
    for (const [id, f] of role.groups) {
      const prev = groups.get(id) ?? NONE;
      groups.set(id, {
        view: prev.view || f.view,
        create: prev.create || f.create,
        edit: prev.edit || f.edit,
        delete: prev.delete || f.delete,
      });
    }
  }
  return access([...new Set(roles.flatMap((r) => r.permissions))], [...groups]);
}

describe('decide', () => {
  it('uses the union of several roles (FR-021)', () => {
    const viewer = { permissions: ['ticket.view'], groups: [[SUPPORT, flags({ view: true })]] as [string, GroupFlags][] };
    const editor = { permissions: ['ticket.edit'], groups: [[SUPPORT, flags({ edit: true })]] as [string, GroupFlags][] };
    expect(decide(access(viewer.permissions, viewer.groups), 'ticket.edit', { type: 'ticket', groupId: SUPPORT })).toBe('deny');
    expect(decide(union(viewer, editor), 'ticket.edit', { type: 'ticket', groupId: SUPPORT })).toBe('allow');
  });

  it('returns not_found for tickets the user cannot view, deny for visible ones', () => {
    const a = access(['ticket.view', 'ticket.edit'], [[SUPPORT, flags({ view: true })]]);
    expect(decide(a, 'ticket.edit', { type: 'ticket', groupId: BILLING })).toBe('not_found');
    expect(decide(a, 'ticket.view', { type: 'ticket', groupId: null })).toBe('not_found');
    expect(decide(a, 'ticket.edit', { type: 'ticket', groupId: SUPPORT })).toBe('deny');
    // Group view without the ticket.view permission is still invisible.
    expect(decide(access([], [[SUPPORT, flags({ view: true })]]), 'ticket.view', { type: 'ticket', groupId: SUPPORT })).toBe(
      'not_found',
    );
  });

  it('needs both the registry key and the group flag', () => {
    const a = access(['ticket.view', 'ticket.delete'], [[SUPPORT, flags({ view: true, edit: true })]]);
    expect(decide(a, 'ticket.delete', { type: 'ticket', groupId: SUPPORT })).toBe('deny');
    expect(decide(a, 'ticket.edit', { type: 'ticket', groupId: SUPPORT })).toBe('deny');
  });

  it('requires edit on the group for merge, split, bulk update and move (FR-023)', () => {
    const keys = ['ticket.merge', 'ticket.split', 'ticket.bulk_update', 'ticket.move_message'] as const;
    const viewOnly = access(['ticket.view', ...keys], [[SUPPORT, flags({ view: true })]]);
    const withEdit = access(['ticket.view', ...keys], [[SUPPORT, flags({ view: true, edit: true })]]);
    for (const key of keys) {
      expect(decide(viewOnly, key, { type: 'ticket', groupId: SUPPORT })).toBe('deny');
      expect(decide(withEdit, key, { type: 'ticket', groupId: SUPPORT })).toBe('allow');
    }
  });

  it('handles Ungrouped as its own entry', () => {
    const manager = access(['ticket.view', 'ticket.edit'], [[null, flags({ view: true, edit: true })]]);
    expect(decide(manager, 'ticket.edit', { type: 'ticket', groupId: null })).toBe('allow');
    expect(decide(manager, 'ticket.view', { type: 'ticket', groupId: SUPPORT })).toBe('not_found');
  });

  it('decides non-ticket resources by key only', () => {
    expect(decide(access(['group.create'], []), 'group.create')).toBe('allow');
    expect(decide(access([], []), 'group.create')).toBe('deny');
  });

  it('rejects a non-ticket key for a ticket resource', () => {
    expect(() => decide(access(['ticket.view'], [[SUPPORT, flags({ view: true })]]), 'group.create', { type: 'ticket', groupId: SUPPORT })).toThrow(
      'not a ticket action',
    );
  });
});

describe('ticket access filter', () => {
  // Compiles without a database (Kysely's documented "dummy" dialect).
  const db = new Kysely<object>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const compile = (expr: ReturnType<typeof groupFilter>) => sql`${expr}`.compile(db);

  it('grants the flagged groups plus Ungrouped, only with the matching permission', () => {
    const a = access(['ticket.view'], [
      [BILLING, flags({ view: true })],
      [SUPPORT, flags({ view: true, edit: true })],
      [null, flags({ view: true })],
    ]);
    expect(grantedGroups(a, 'view')).toEqual({ groupIds: [SUPPORT, BILLING].sort(), ungrouped: true });
    expect(grantedGroups(a, 'edit')).toEqual({ groupIds: [], ungrouped: false });
  });

  it('builds IN-list, IS NULL and false expressions', () => {
    const both = compile(groupFilter({ groupIds: [SUPPORT], ungrouped: true }, 'tickets.group_id'));
    expect(both.sql).toBe('("tickets"."group_id" = ANY($1::uuid[]) OR "tickets"."group_id" IS NULL)');
    expect(both.parameters).toEqual([[SUPPORT]]);
    expect(compile(groupFilter({ groupIds: [], ungrouped: true }, 't.group_id')).sql).toBe('("t"."group_id" IS NULL)');
    expect(compile(groupFilter({ groupIds: [], ungrouped: false }, 't.group_id')).sql).toBe('false');
  });
});

describe('PolicyService', () => {
  afterEach(() => vi.restoreAllMocks());

  const ctx = TenantContext.create({ tenantId: TENANT, actor: { kind: 'user', id: USER }, requestId: 'r1' });

  function service(version: { value: string }) {
    const store = new Map<string, string>();
    const redis = {
      get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
    };
    const unitOfWork = { withTenantReadOnly: (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) };
    vi.spyOn(AccessRepository.prototype, 'accessVersion').mockImplementation(() => Promise.resolve(version.value));
    const load = vi
      .spyOn(AccessRepository.prototype, 'load')
      .mockImplementation((_tx, userId, accessVersion) =>
        Promise.resolve({ ...access(['ticket.view'], [[SUPPORT, flags({ view: true })]]), userId, accessVersion }),
      );
    return { policy: new PolicyService(unitOfWork as never, redis as never), load, redis };
  }

  it('caches per access version and misses after a bump', async () => {
    const version = { value: '4' };
    const { policy, load, redis } = service(version);

    await policy.effectiveAccess(ctx, USER);
    const cached = await policy.effectiveAccess(ctx, USER);
    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(accessCacheKey(TENANT, '4', USER), expect.any(String), 'EX', 900);
    expect(cached.groups.get(SUPPORT)).toEqual(flags({ view: true }));
    expect(cached.permissions.has('ticket.view')).toBe(true);

    version.value = '5';
    const fresh = await policy.effectiveAccess(ctx, USER);
    expect(load).toHaveBeenCalledTimes(2);
    expect(fresh.accessVersion).toBe('5');
  });

  it('keys the cache by tenant, version and user', () => {
    expect(accessCacheKey(TENANT, '7', USER)).toBe(`access:${TENANT}:7:${USER}`);
  });

  it('gives Admin only what its role rows grant (no system_key shortcut)', async () => {
    // An admin whose role rows were never synced has no access: the registry grants it, not the name.
    const { policy, load } = service({ value: '0' });
    load.mockResolvedValue(emptyAccess(USER, '0'));
    await expect(policy.can(ctx, 'role.edit')).resolves.toBe('deny');
    await expect(policy.can(ctx, 'ticket.view', { type: 'ticket', groupId: null })).resolves.toBe('not_found');
  });

  it('decides only for user actors', async () => {
    const { policy } = service({ value: '0' });
    const system = TenantContext.create({ tenantId: TENANT, actor: { kind: 'system' }, requestId: 'r2' });
    await expect(policy.can(system, 'ticket.view')).rejects.toThrow('user actors');
  });
});
