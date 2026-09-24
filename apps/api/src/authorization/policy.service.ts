import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { REDIS } from '../platform-kernel/redis/redis.module.js';

import type { PermissionKey } from './registry/module-permissions.js';

/**
 * The only place that decides staff access (research D6, constitution II, FR-021–FR-023).
 *
 * Effective access is the union over a user's roles of their registry permissions and, per
 * group (and the built-in Ungrouped entry, `null`), of the view/create/edit/delete flags. Only
 * active staff users have any. Admin gets nothing special here: its access comes from its
 * role rows, which the registry and group creation keep complete.
 *
 * Ticket actions need both the registry key and the group flag: `ticket.view|create|edit|delete`
 * map to the flag of the same name, and `ticket.merge|split|bulk_update|move_message` need edit
 * (FR-023). A ticket the user cannot view is `not_found`, never `deny` (constitution I).
 *
 * Effective access is cached in Redis under `access:{tenantId}:{accessVersion}:{userId}`; any
 * access change bumps `tenants.access_version` (access-version.ts), so old entries stop matching.
 */

export type GroupAction = 'view' | 'create' | 'edit' | 'delete';

export type GroupFlags = Readonly<Record<GroupAction, boolean>>;

export interface EffectiveAccess {
  readonly userId: string;
  readonly accessVersion: string;
  readonly permissions: ReadonlySet<string>;
  /** Group id → flags; `null` is Ungrouped. Groups without any flag are absent. */
  readonly groups: ReadonlyMap<string | null, GroupFlags>;
}

export type Decision = 'allow' | 'deny' | 'not_found';

/** A resource whose visibility depends on group access. Other resources need only the key. */
export interface TicketResource {
  type: 'ticket';
  groupId: string | null;
}

export type PolicyResource = TicketResource;

const TICKET_ACTION_FLAGS: Readonly<Record<string, GroupAction>> = {
  'ticket.view': 'view',
  'ticket.create': 'create',
  'ticket.edit': 'edit',
  'ticket.delete': 'delete',
  'ticket.merge': 'edit',
  'ticket.split': 'edit',
  'ticket.bulk_update': 'edit',
  'ticket.move_message': 'edit',
};

const GROUP_ACTION_KEYS: Readonly<Record<GroupAction, PermissionKey>> = {
  view: 'ticket.view',
  create: 'ticket.create',
  edit: 'ticket.edit',
  delete: 'ticket.delete',
};

export const ACCESS_CACHE_TTL_S = 15 * 60;

export function accessCacheKey(tenantId: string, accessVersion: string, userId: string): string {
  return `access:${tenantId}:${accessVersion}:${userId}`;
}

export function emptyAccess(userId: string, accessVersion: string): EffectiveAccess {
  return { userId, accessVersion, permissions: new Set(), groups: new Map() };
}

/** Pure decision over loaded access; see the class comment for the rules. */
export function decide(access: EffectiveAccess, key: PermissionKey, resource?: PolicyResource): Decision {
  if (resource?.type === 'ticket') {
    const flags = access.groups.get(resource.groupId);
    if (!access.permissions.has('ticket.view') || flags?.view !== true) return 'not_found';
    const flag = TICKET_ACTION_FLAGS[key];
    if (flag === undefined) {
      throw new Error(`${key} is not a ticket action`);
    }
    return access.permissions.has(key) && flags[flag] ? 'allow' : 'deny';
  }
  return access.permissions.has(key) ? 'allow' : 'deny';
}

/**
 * Groups (and Ungrouped) where `action` is allowed on tickets, or none without the matching
 * `ticket.*` permission. The same grants back `ticketAccessFilter`, so lists and single reads agree.
 */
export function grantedGroups(access: EffectiveAccess, action: GroupAction): { groupIds: string[]; ungrouped: boolean } {
  if (!access.permissions.has(GROUP_ACTION_KEYS[action])) return { groupIds: [], ungrouped: false };
  const groupIds: string[] = [];
  let ungrouped = false;
  for (const [groupId, flags] of access.groups) {
    if (!flags[action]) continue;
    if (groupId === null) ungrouped = true;
    else groupIds.push(groupId);
  }
  return { groupIds: groupIds.sort(), ungrouped };
}

/** `column IN (granted) OR (Ungrouped granted AND column IS NULL)`; `false` when nothing is. */
export function groupFilter(grants: { groupIds: string[]; ungrouped: boolean }, column: string): Expression<SqlBool> {
  const ref = sql.ref(column);
  const parts = [];
  if (grants.groupIds.length > 0) {
    parts.push(sql<SqlBool>`${ref} = ANY(${sql.val(grants.groupIds)}::uuid[])`);
  }
  if (grants.ungrouped) parts.push(sql<SqlBool>`${ref} IS NULL`);
  if (parts.length === 0) return sql<SqlBool>`false`;
  return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
}

interface CachedAccess {
  permissions: string[];
  groups: [string | null, GroupFlags][];
}

export interface EligibleOwner {
  id: string;
  name: string;
}

@Injectable()
export class PolicyService {
  private readonly logger = new Logger('PolicyService');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The union of `userId`'s roles, from cache or the database. */
  effectiveAccess(ctx: TenantContext, userId: string): Promise<EffectiveAccess> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new AccessRepository(ctx);
      const accessVersion = await repo.accessVersion(tx);
      const key = accessCacheKey(ctx.tenantId, accessVersion, userId);
      const cached = await this.readCache(key);
      if (cached !== undefined) {
        return { userId, accessVersion, permissions: new Set(cached.permissions), groups: new Map(cached.groups) };
      }
      const access = await repo.load(tx, userId, accessVersion);
      await this.writeCache(key, access);
      return access;
    });
  }

  /** Decides for the context's user actor. Only user actors are checked by the policy. */
  async can(ctx: TenantContext, key: PermissionKey, resource?: PolicyResource): Promise<Decision> {
    return decide(await this.effectiveAccess(ctx, actorUserId(ctx)), key, resource);
  }

  /**
   * A filter for queries over tickets: `WHERE <filter>` limits rows to groups where the actor may
   * perform `action`. `column` is the ticket group column as referenced in the query.
   */
  async ticketAccessFilter(
    ctx: TenantContext,
    action: GroupAction,
    column = 'tickets.group_id',
  ): Promise<Expression<SqlBool>> {
    const access = await this.effectiveAccess(ctx, actorUserId(ctx));
    return groupFilter(grantedGroups(access, action), column);
  }

  /** Active staff with edit on the group (`null` = Ungrouped), by name (data-model "owner eligibility"). */
  eligibleOwners(ctx: TenantContext, groupId: string | null): Promise<EligibleOwner[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => new AccessRepository(ctx).eligibleOwners(tx, groupId));
  }

  private async readCache(key: string): Promise<CachedAccess | undefined> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as CachedAccess);
    } catch {
      return undefined;
    }
  }

  private async writeCache(key: string, access: EffectiveAccess): Promise<void> {
    const value: CachedAccess = { permissions: [...access.permissions], groups: [...access.groups] };
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ACCESS_CACHE_TTL_S);
    } catch (error) {
      this.logger.warn(`Access cache write failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

function actorUserId(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') {
    throw new Error(`The policy service decides for user actors, not ${ctx.actor.kind}`);
  }
  return ctx.actor.id;
}

/** Reads grants for the policy service; exported for tests. */
export class AccessRepository extends TenantRepository {
  async accessVersion(tx: TenantTransaction): Promise<string> {
    // `tenants` is global (no RLS); the app role may read it. Read in the same transaction as
    // the grants so the version and the grants match.
    const row = await tx
      .selectFrom('tenants')
      .select('access_version')
      .where('id', '=', this.ctx.tenantId)
      .executeTakeFirstOrThrow();
    return String(row.access_version);
  }

  async load(tx: TenantTransaction, userId: string, accessVersion: string): Promise<EffectiveAccess> {
    const user = await this.selectFrom(tx, 'users')
      .select(['status', 'kind'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (user?.status !== 'active' || user.kind !== 'staff') return emptyAccess(userId, accessVersion);

    const permissions = await this.selectFrom(tx, 'user_roles')
      .innerJoin('role_permissions', (join) =>
        join
          .onRef('role_permissions.tenant_id', '=', 'user_roles.tenant_id')
          .onRef('role_permissions.role_id', '=', 'user_roles.role_id'),
      )
      .select('role_permissions.permission_key')
      .distinct()
      .where('user_roles.user_id', '=', userId)
      .execute();

    const groups = await this.selectFrom(tx, 'user_roles')
      .innerJoin('role_group_access', (join) =>
        join
          .onRef('role_group_access.tenant_id', '=', 'user_roles.tenant_id')
          .onRef('role_group_access.role_id', '=', 'user_roles.role_id'),
      )
      .select((eb) => [
        'role_group_access.group_id',
        eb.fn<boolean>('bool_or', ['role_group_access.can_view']).as('view'),
        eb.fn<boolean>('bool_or', ['role_group_access.can_create']).as('create'),
        eb.fn<boolean>('bool_or', ['role_group_access.can_edit']).as('edit'),
        eb.fn<boolean>('bool_or', ['role_group_access.can_delete']).as('delete'),
      ])
      .where('user_roles.user_id', '=', userId)
      .groupBy('role_group_access.group_id')
      .execute();

    return {
      userId,
      accessVersion,
      permissions: new Set(permissions.map((row) => row.permission_key)),
      groups: new Map(
        groups
          .filter((row) => row.view || row.create || row.edit || row.delete)
          .map((row) => [row.group_id, { view: row.view, create: row.create, edit: row.edit, delete: row.delete }]),
      ),
    };
  }

  eligibleOwners(tx: TenantTransaction, groupId: string | null): Promise<EligibleOwner[]> {
    return this.selectFrom(tx, 'users')
      .select(['users.id', 'users.name'])
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'staff')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('user_roles')
            .innerJoin('role_group_access', (join) =>
              join
                .onRef('role_group_access.tenant_id', '=', 'user_roles.tenant_id')
                .onRef('role_group_access.role_id', '=', 'user_roles.role_id'),
            )
            .select(sql`1`.as('one'))
            .whereRef('user_roles.tenant_id', '=', 'users.tenant_id')
            .whereRef('user_roles.user_id', '=', 'users.id')
            .where('role_group_access.can_edit', '=', true)
            .where('role_group_access.group_id', groupId === null ? 'is' : '=', groupId),
        ),
      )
      .orderBy('users.name')
      .orderBy('users.id')
      .execute();
  }
}
