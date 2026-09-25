import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, conflict, notFound, validationFailed, type ErrorDetail } from '../platform-kernel/http/app-error.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { bumpAccessVersion } from './access-version.js';
import { PermissionRegistry } from './registry/registry.service.js';

import type { SystemRoleKey } from '../platform-kernel/db/tables/authorization.js';
import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Roles and the permission registry (FR-016–FR-024, contracts/access.yaml). Listing was pulled
 * forward for the invite dialog (US3, T061); this adds the registry endpoint and create/edit/
 * delete (US4, T091).
 *
 * - Names are 1–60 chars, unique per tenant case-insensitively (DB index `roles_tenant_name`);
 *   the unique violation is surfaced as 409 `ROLE_NAME_TAKEN`.
 * - System roles (`system_key` not null) can never be deleted or renamed. Deletion is always 409
 *   `SYSTEM_ROLE`; a rename attempt in `PUT` is rejected the same way before the DB trigger would
 *   raise a `check_violation` (0004_authorization.ts `roles_protect_system`).
 * - A non-system role held by any `user_roles` row can't be deleted (409 `ROLE_IN_USE`).
 * - `PUT` replaces permissions and group access to exactly the given sets. Admin's current grants
 *   can never be reduced (400 `ADMIN_ACCESS_FIXED`).
 * - Every create/edit/delete bumps the tenant's access version in the same transaction. Edits also
 *   append `role.updated` (groups that lost `can_edit`, `null` = Ungrouped) for the tickets module
 *   to unassign owners (FR-026, T142), and audit `role.*`, `permission.changed` and
 *   `group_access.changed` as appropriate.
 */

export interface GroupAccessEntryDto {
  groupId: string | null;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface RoleDto {
  id: string;
  name: string;
  description?: string;
  system: SystemRoleKey | null;
  permissions: string[];
  groupAccess: GroupAccessEntryDto[];
  userCount: number;
}

export interface RoleInput {
  name: string;
  description?: string;
  permissions: string[];
  groupAccess: GroupAccessEntryDto[];
}

export interface PermissionDto {
  key: string;
  resource: string;
  action: string;
  module: string;
  description: string;
  /** True for `ticket.*`: the action also needs group access (FR-023). */
  groupScoped: boolean;
}

interface GroupAccessRow {
  group_id: string | null;
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

@Injectable()
export class RolesService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly registry: PermissionRegistry,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  list(ctx: TenantContext): Promise<RoleDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new RolesRepository(ctx);
      const roles = await repo.roles(tx);
      const permissions = await repo.permissions(tx);
      const access = await repo.groupAccess(tx);
      const counts = await repo.userCounts(tx);
      return roles.map((role) => ({
        id: role.id,
        name: role.name,
        ...(role.description === null ? {} : { description: role.description }),
        system: role.system_key,
        permissions: permissions
          .filter((p) => p.role_id === role.id)
          .map((p) => p.permission_key)
          .sort(),
        groupAccess: access
          .filter((a) => a.role_id === role.id)
          .map((a) => ({ groupId: a.group_id, view: a.can_view, create: a.can_create, edit: a.can_edit, delete: a.can_delete })),
        userCount: Number(counts.find((c) => c.role_id === role.id)?.count ?? 0),
      }));
    });
  }

  get(ctx: TenantContext, roleId: string): Promise<RoleDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => this.load(ctx, tx, roleId));
  }

  /** The permission registry (FR-017, FR-018), sorted by module then key. */
  permissions(): PermissionDto[] {
    return this.registry
      .all()
      .map((definition) => ({ ...definition, groupScoped: definition.resource === 'ticket' }))
      .sort((a, b) => a.module.localeCompare(b.module) || a.key.localeCompare(b.key));
  }

  async create(ctx: TenantContext, input: RoleInput): Promise<RoleDto> {
    this.assertGroupAccessShape(input.groupAccess);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RolesRepository(ctx);
      this.assertPermissionsKnown(input.permissions);
      await this.assertGroupsExist(tx, repo, input.groupAccess);

      let roleId: string;
      try {
        roleId = await repo.insertRole(tx, { name: input.name, description: input.description ?? null, system_key: null });
      } catch (error) {
        if (isUniqueViolation(error, 'roles_tenant_name')) throw conflict('ROLE_NAME_TAKEN', 'A role with this name already exists');
        throw error;
      }
      await repo.setPermissions(tx, roleId, input.permissions);
      await repo.setGroupAccess(tx, roleId, input.groupAccess);

      await bumpAccessVersion(tx, ctx.tenantId, 'role.created', this.outbox);
      await this.audit.record(tx, {
        action: 'role.created',
        resourceType: 'role',
        resourceId: roleId,
        details: { name: input.name, permissions: input.permissions },
      });
      return this.load(ctx, tx, roleId);
    });
  }

  async update(ctx: TenantContext, roleId: string, input: RoleInput): Promise<RoleDto> {
    this.assertGroupAccessShape(input.groupAccess);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RolesRepository(ctx);
      const role = await repo.byId(tx, roleId);
      if (role === undefined) throw notFound('role');
      if (role.system_key !== null && input.name !== role.name) {
        throw conflict('SYSTEM_ROLE', 'System roles cannot be renamed');
      }

      this.assertPermissionsKnown(input.permissions);
      await this.assertGroupsExist(tx, repo, input.groupAccess);

      const currentPermissions = new Set((await repo.permissionsOf(tx, roleId)).map((p) => p.permission_key));
      const currentAccess = await repo.groupAccessOf(tx, roleId);
      const currentAccessByGroup = new Map(currentAccess.map((a): [string | null, GroupAccessRow] => [a.group_id, a]));
      const nextPermissions = new Set(input.permissions);
      const nextAccessByGroup = new Map(input.groupAccess.map((a): [string | null, GroupAccessEntryDto] => [a.groupId, a]));

      if (role.system_key === 'admin') {
        this.assertAdminAccessNotReduced(currentPermissions, nextPermissions, currentAccessByGroup, nextAccessByGroup);
      }

      try {
        await repo.updateRole(tx, roleId, { name: input.name, description: input.description ?? null });
      } catch (error) {
        if (isUniqueViolation(error, 'roles_tenant_name')) throw conflict('ROLE_NAME_TAKEN', 'A role with this name already exists');
        throw error;
      }
      await repo.setPermissions(tx, roleId, input.permissions);
      await repo.setGroupAccess(tx, roleId, input.groupAccess);

      const groupIds = new Set([...currentAccessByGroup.keys(), ...nextAccessByGroup.keys()]);
      const groupsLostEdit: (string | null)[] = [];
      let accessChanged = false;
      for (const groupId of groupIds) {
        const current = currentAccessByGroup.get(groupId);
        const next = nextAccessByGroup.get(groupId);
        if (
          (current?.can_view ?? false) !== (next?.view ?? false) ||
          (current?.can_create ?? false) !== (next?.create ?? false) ||
          (current?.can_edit ?? false) !== (next?.edit ?? false) ||
          (current?.can_delete ?? false) !== (next?.delete ?? false)
        ) {
          accessChanged = true;
        }
        if ((current?.can_edit ?? false) && !(next?.edit ?? false)) groupsLostEdit.push(groupId);
      }
      const permissionsChanged = !setsEqual(currentPermissions, nextPermissions);

      await bumpAccessVersion(tx, ctx.tenantId, 'role.updated', this.outbox);
      await this.outbox.append(tx, { type: 'role.updated', payload: { roleId, groupsLostEdit }, streams: ['tenant'] });

      await this.audit.record(tx, { action: 'role.updated', resourceType: 'role', resourceId: roleId, details: { name: input.name } });
      if (permissionsChanged) {
        await this.audit.record(tx, {
          action: 'permission.changed',
          resourceType: 'role',
          resourceId: roleId,
          details: { permissions: input.permissions },
        });
      }
      if (accessChanged) {
        await this.audit.record(tx, {
          action: 'group_access.changed',
          resourceType: 'role',
          resourceId: roleId,
          details: {
            groupAccess: input.groupAccess.map(
              (a): Record<string, JsonValue> => ({ groupId: a.groupId, view: a.view, create: a.create, edit: a.edit, delete: a.delete }),
            ),
            groupsLostEdit,
          },
        });
      }

      return this.load(ctx, tx, roleId);
    });
  }

  async delete(ctx: TenantContext, roleId: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RolesRepository(ctx);
      const role = await repo.byId(tx, roleId);
      if (role === undefined) throw notFound('role');
      if (role.system_key !== null) throw conflict('SYSTEM_ROLE', 'System roles cannot be deleted');
      if ((await repo.userCount(tx, roleId)) > 0) {
        throw conflict('ROLE_IN_USE', 'This role is held by at least one user');
      }
      await repo.delete(tx, roleId);
      await bumpAccessVersion(tx, ctx.tenantId, 'role.deleted', this.outbox);
      await this.audit.record(tx, { action: 'role.deleted', resourceType: 'role', resourceId: roleId });
    });
  }

  private async load(ctx: TenantContext, tx: TenantTransaction, roleId: string): Promise<RoleDto> {
    const repo = new RolesRepository(ctx);
    const role = await repo.byId(tx, roleId);
    if (role === undefined) throw notFound('role');
    const permissions = await repo.permissionsOf(tx, roleId);
    const access = await repo.groupAccessOf(tx, roleId);
    const userCount = await repo.userCount(tx, roleId);
    return {
      id: role.id,
      name: role.name,
      ...(role.description === null ? {} : { description: role.description }),
      system: role.system_key,
      permissions: permissions.map((p) => p.permission_key).sort(),
      groupAccess: access.map((a) => ({ groupId: a.group_id, view: a.can_view, create: a.can_create, edit: a.can_edit, delete: a.can_delete })),
      userCount,
    };
  }

  /** No two entries for the same group (or Ungrouped). */
  private assertGroupAccessShape(entries: readonly GroupAccessEntryDto[]): void {
    const seen = new Set<string>();
    const details: ErrorDetail[] = [];
    entries.forEach((entry, index) => {
      const key = entry.groupId ?? '__ungrouped__';
      if (seen.has(key)) details.push({ path: `groupAccess.${index}.groupId`, issue: 'invalid_value' });
      seen.add(key);
    });
    if (details.length > 0) throw validationFailed(details);
  }

  private assertPermissionsKnown(keys: readonly string[]): void {
    const details: ErrorDetail[] = [];
    keys.forEach((key, index) => {
      if (!this.registry.has(key)) details.push({ path: `permissions.${index}`, issue: 'invalid_value' });
    });
    if (details.length > 0) throw validationFailed(details);
  }

  private async assertGroupsExist(tx: TenantTransaction, repo: RolesRepository, entries: readonly GroupAccessEntryDto[]): Promise<void> {
    const ids = [...new Set(entries.map((e) => e.groupId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return;
    const existing = await repo.existingGroupIds(tx, ids);
    const details: ErrorDetail[] = [];
    entries.forEach((entry, index) => {
      if (entry.groupId !== null && !existing.has(entry.groupId)) {
        details.push({ path: `groupAccess.${index}.groupId`, issue: 'invalid_value' });
      }
    });
    if (details.length > 0) throw validationFailed(details);
  }

  /** FR-019: Admin's registered permissions and group-access flags can only ever grow. */
  private assertAdminAccessNotReduced(
    currentPermissions: ReadonlySet<string>,
    nextPermissions: ReadonlySet<string>,
    currentAccessByGroup: ReadonlyMap<string | null, GroupAccessRow>,
    nextAccessByGroup: ReadonlyMap<string | null, GroupAccessEntryDto>,
  ): void {
    for (const key of currentPermissions) {
      if (!nextPermissions.has(key)) throw adminAccessFixed();
    }
    for (const [groupId, current] of currentAccessByGroup) {
      const next = nextAccessByGroup.get(groupId);
      if (
        next === undefined ||
        (current.can_view && !next.view) ||
        (current.can_create && !next.create) ||
        (current.can_edit && !next.edit) ||
        (current.can_delete && !next.delete)
      ) {
        throw adminAccessFixed();
      }
    }
  }
}

function adminAccessFixed(): AppError {
  return new AppError('ADMIN_ACCESS_FIXED', 400, "The Admin role's access cannot be reduced");
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const { code, constraint: name } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && name === constraint;
}

class RolesRepository extends TenantRepository {
  roles(tx: TenantTransaction) {
    return this.selectFrom(tx, 'roles').select(['id', 'name', 'description', 'system_key']).orderBy('name').execute();
  }

  byId(tx: TenantTransaction, roleId: string) {
    return this.selectFrom(tx, 'roles').select(['id', 'name', 'description', 'system_key']).where('id', '=', roleId).executeTakeFirst();
  }

  permissions(tx: TenantTransaction) {
    return this.selectFrom(tx, 'role_permissions').select(['role_id', 'permission_key']).execute();
  }

  permissionsOf(tx: TenantTransaction, roleId: string) {
    return this.selectFrom(tx, 'role_permissions').select('permission_key').where('role_id', '=', roleId).execute();
  }

  groupAccess(tx: TenantTransaction) {
    return this.selectFrom(tx, 'role_group_access')
      .select(['role_id', 'group_id', 'can_view', 'can_create', 'can_edit', 'can_delete'])
      .execute();
  }

  groupAccessOf(tx: TenantTransaction, roleId: string): Promise<GroupAccessRow[]> {
    return this.selectFrom(tx, 'role_group_access')
      .select(['group_id', 'can_view', 'can_create', 'can_edit', 'can_delete'])
      .where('role_id', '=', roleId)
      .execute();
  }

  userCounts(tx: TenantTransaction) {
    return this.selectFrom(tx, 'user_roles')
      .select((eb) => ['role_id', eb.fn.countAll<string>().as('count')])
      .groupBy('role_id')
      .execute();
  }

  async userCount(tx: TenantTransaction, roleId: string): Promise<number> {
    const row = await this.selectFrom(tx, 'user_roles')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('role_id', '=', roleId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async insertRole(tx: TenantTransaction, row: { name: string; description: string | null; system_key: null }): Promise<string> {
    const inserted = await this.insertInto(tx, 'roles', row).returning('id').executeTakeFirstOrThrow();
    return inserted.id;
  }

  async updateRole(tx: TenantTransaction, roleId: string, values: { name: string; description: string | null }): Promise<void> {
    await this.updateTable(tx, 'roles').set(values).where('id', '=', roleId).execute();
  }

  async setPermissions(tx: TenantTransaction, roleId: string, keys: readonly string[]): Promise<void> {
    await this.deleteFrom(tx, 'role_permissions').where('role_id', '=', roleId).execute();
    const unique = [...new Set(keys)];
    if (unique.length > 0) {
      await this.insertInto(tx, 'role_permissions', unique.map((permission_key) => ({ role_id: roleId, permission_key }))).execute();
    }
  }

  async setGroupAccess(tx: TenantTransaction, roleId: string, entries: readonly GroupAccessEntryDto[]): Promise<void> {
    await this.deleteFrom(tx, 'role_group_access').where('role_id', '=', roleId).execute();
    if (entries.length > 0) {
      await this.insertInto(
        tx,
        'role_group_access',
        entries.map((e) => ({
          role_id: roleId,
          group_id: e.groupId,
          can_view: e.view,
          can_create: e.create,
          can_edit: e.edit,
          can_delete: e.delete,
        })),
      ).execute();
    }
  }

  async delete(tx: TenantTransaction, roleId: string): Promise<void> {
    await this.deleteFrom(tx, 'roles').where('id', '=', roleId).execute();
  }

  async existingGroupIds(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'groups').select('id').where('id', 'in', ids).execute();
    return new Set(rows.map((row) => row.id));
  }
}
