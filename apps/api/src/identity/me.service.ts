import { Injectable } from '@nestjs/common';

import { PolicyService } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { unauthenticated } from '../platform-kernel/http/app-error.js';

import type { Availability, UserKind } from '../platform-kernel/db/tables/identity.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The `Me` response (contracts/identity.yaml): the signed-in user with their roles, effective
 * permissions and group access (the policy service's union, research D6) and the tenant's
 * `accessVersion`, which clients compare with `access.changed` events to know when to refetch.
 */

export interface GroupAccessDto {
  /** `null` = Ungrouped. */
  groupId: string | null;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface MeDto {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  kind: UserKind;
  availability: Availability;
  roles: { id: string; name: string }[];
  permissions: string[];
  groupAccess: GroupAccessDto[];
  accessVersion: number;
}

@Injectable()
export class MeService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
  ) {}

  /** For the context's user actor; 401 if that user no longer exists. */
  async me(ctx: TenantContext): Promise<MeDto> {
    if (ctx.actor.kind !== 'user') throw new Error('MeService needs a user actor');
    const userId = ctx.actor.id;
    const { user, roles } = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new MeRepository(ctx);
      return { user: await repo.user(tx, userId), roles: await repo.roles(tx, userId) };
    });
    if (user === undefined) throw unauthenticated();
    const access = await this.policy.effectiveAccess(ctx, userId);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      // Attachments (and avatar URLs) arrive with the attachments module.
      avatarUrl: null,
      kind: user.kind,
      availability: user.availability,
      roles,
      permissions: [...access.permissions].sort(),
      groupAccess: [...access.groups].map(([groupId, flags]) => ({ groupId, ...flags })),
      accessVersion: Number(access.accessVersion),
    };
  }
}

class MeRepository extends TenantRepository {
  user(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users')
      .select(['id', 'email', 'name', 'kind', 'availability'])
      .where('id', '=', userId)
      .executeTakeFirst();
  }

  roles(tx: TenantTransaction, userId: string): Promise<{ id: string; name: string }[]> {
    return this.selectFrom(tx, 'user_roles')
      .innerJoin('roles', (join) =>
        join.onRef('roles.tenant_id', '=', 'user_roles.tenant_id').onRef('roles.id', '=', 'user_roles.role_id'),
      )
      .select(['roles.id', 'roles.name'])
      .where('user_roles.user_id', '=', userId)
      .orderBy('roles.name')
      .execute();
  }
}
