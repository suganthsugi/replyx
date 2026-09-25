import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

import type { SystemRoleKey } from '../platform-kernel/db/tables/authorization.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Roles (FR-016–FR-024, contracts/access.yaml). Listing only for now: the user administration
 * invite dialog needs it (US3). Creating, editing and deleting roles arrive with US4 (T091).
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

@Injectable()
export class RolesService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

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
}

class RolesRepository extends TenantRepository {
  roles(tx: TenantTransaction) {
    return this.selectFrom(tx, 'roles').select(['id', 'name', 'description', 'system_key']).orderBy('name').execute();
  }

  permissions(tx: TenantTransaction) {
    return this.selectFrom(tx, 'role_permissions').select(['role_id', 'permission_key']).execute();
  }

  groupAccess(tx: TenantTransaction) {
    return this.selectFrom(tx, 'role_group_access')
      .select(['role_id', 'group_id', 'can_view', 'can_create', 'can_edit', 'can_delete'])
      .execute();
  }

  userCounts(tx: TenantTransaction) {
    return this.selectFrom(tx, 'user_roles')
      .select((eb) => ['role_id', eb.fn.countAll<string>().as('count')])
      .groupBy('role_id')
      .execute();
  }
}
