import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { unauthenticated, validationFailed } from '../platform-kernel/http/app-error.js';

import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
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

export interface MeUpdate {
  name?: string;
  avatarAttachmentId?: null;
  availability?: Availability;
  timeDisplay?: { timezone?: string; hour12?: boolean };
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
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Own profile (FR-013, FR-015): name, avatar (clearing only until attachments), availability, time display. */
  async update(ctx: TenantContext, input: MeUpdate): Promise<MeDto> {
    const userId = actorId(ctx);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new MeRepository(ctx);
      const current = await repo.user(tx, userId);
      if (current === undefined) throw unauthenticated();
      const timeDisplay =
        input.timeDisplay === undefined ? undefined : { ...(current.time_display as object), ...input.timeDisplay };
      await repo.update(tx, userId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.avatarAttachmentId === undefined ? {} : { avatar_attachment_id: input.avatarAttachmentId }),
        ...(input.availability === undefined ? {} : { availability: input.availability }),
        ...(timeDisplay === undefined ? {} : { time_display: timeDisplay }),
      });
    });
    return this.me(ctx);
  }

  /** Changes the password after checking the current one; ends every other session. */
  async changePassword(ctx: TenantContext, sessionId: string, currentPassword: string, newPassword: string): Promise<void> {
    const userId = actorId(ctx);
    const newHash = await this.passwords.hash(newPassword);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new MeRepository(ctx);
      const hash = await repo.passwordHash(tx, userId);
      if (!(await this.passwords.verify(hash, currentPassword))) {
        throw validationFailed([{ path: 'currentPassword', issue: 'incorrect' }]);
      }
      await repo.update(tx, userId, { password_hash: newHash });
      await this.sessions.revokeOthersForUser(tx, userId, sessionId);
      await this.audit.record(tx, { action: 'user.password_changed', resourceType: 'user', resourceId: userId });
    });
  }

  /** For the context's user actor; 401 if that user no longer exists. */
  async me(ctx: TenantContext): Promise<MeDto> {
    const userId = actorId(ctx);
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

function actorId(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new Error('MeService needs a user actor');
  return ctx.actor.id;
}

class MeRepository extends TenantRepository {
  user(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users')
      .select(['id', 'email', 'name', 'kind', 'availability', 'time_display'])
      .where('id', '=', userId)
      .executeTakeFirst();
  }

  async passwordHash(tx: TenantTransaction, userId: string): Promise<string | null> {
    const row = await this.selectFrom(tx, 'users').select('password_hash').where('id', '=', userId).executeTakeFirst();
    return row?.password_hash ?? null;
  }

  async update(
    tx: TenantTransaction,
    userId: string,
    values: {
      name?: string;
      avatar_attachment_id?: null;
      availability?: Availability;
      time_display?: JsonValue;
      password_hash?: string;
    },
  ): Promise<void> {
    if (Object.keys(values).length === 0) return;
    await this.updateTable(tx, 'users').set(values).where('id', '=', userId).execute();
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
