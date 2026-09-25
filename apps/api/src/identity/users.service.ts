import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { bumpAccessVersion } from '../authorization/access-version.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, conflict, notFound, validationFailed } from '../platform-kernel/http/app-error.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { InvitationsService, type CreatedInvitation } from './invitations.service.js';
import { SessionService } from './session.service.js';

import type { Availability, UserKind, UserStatus } from '../platform-kernel/db/tables/identity.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * User administration (FR-007–FR-011, contracts/identity.yaml `/users*`). Every route is
 * permission-checked by the guard with a `user.*` key; this service keeps tenant data scoped and
 * audits each change.
 *
 * - Inviting a staff email creates an `invited` user with the roles and emails an invitation;
 *   re-inviting an `invited` user replaces the invitation and roles. Customer-only role sets
 *   create an active customer (they sign in with email links).
 * - Role changes, deactivation, reactivation and deletion bump the tenant's access version.
 * - Deactivation ends every session and emits `user.deactivated` (tickets unassign on it).
 * - Deletion is refused with 409 `USER_HAS_HISTORY` when any registered history check finds
 *   something (tickets modules register checks as they arrive).
 * - Erasure is asynchronous: the user is deactivated now and `user.erasure_requested` drives the
 *   erasure job.
 */

export interface UserDto {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  status: UserStatus;
  locked: boolean;
  roles: { id: string; name: string }[];
  availability: Availability;
  lastSignInAt: string | null;
  createdAt: string;
}

export interface UserFilters {
  kind?: UserKind;
  status?: UserStatus;
  roleId?: string;
  q?: string;
  limit: number;
  cursor?: string;
}

/** Answers whether a user authored anything that must be kept (messages, ticket history). */
export interface UserHistoryCheck {
  hasHistory(tx: TenantTransaction, userId: string): Promise<boolean>;
}

/** Multi-provider token: modules with user-authored records provide a `UserHistoryCheck`. */
export const USER_HISTORY_CHECKS = Symbol('USER_HISTORY_CHECKS');

const Cursor = z.object({ id: z.uuid() }).strict();

@Injectable()
export class UsersService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly sessions: SessionService,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Optional() @Inject(USER_HISTORY_CHECKS) private readonly historyChecks: UserHistoryCheck[] = [],
  ) {}

  list(ctx: TenantContext, filters: UserFilters): Promise<Page<UserDto>> {
    const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor, Cursor);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      const rows = await repo.list(tx, { ...filters, afterId: after?.id });
      const roles = await repo.rolesOf(tx, rows.map((row) => row.id));
      return toPage(rows, filters.limit, (row) => ({ id: row.id }), (row) => this.toDto(row, roles));
    });
  }

  get(ctx: TenantContext, userId: string): Promise<UserDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => this.load(ctx, tx, userId));
  }

  /** 201 with the user; 409 `EMAIL_IN_USE` for an existing active, deactivated or customer user. */
  async invite(ctx: TenantContext, input: { email: string; name?: string; roleIds: string[] }): Promise<UserDto> {
    const inviterId = actorId(ctx);
    const result = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      const kind = await this.kindForRoles(tx, repo, input.roleIds);
      const existing = await repo.byEmail(tx, input.email);
      if (existing !== undefined && !(existing.status === 'invited' && kind === 'staff')) {
        throw conflict('EMAIL_IN_USE', 'A user with this email already exists');
      }

      let userId: string;
      if (existing === undefined) {
        userId = await repo.insertUser(tx, {
          email: input.email,
          name: input.name ?? defaultName(input.email),
          kind,
          status: kind === 'staff' ? 'invited' : 'active',
        });
        if (kind === 'customer') await repo.insertCustomerProfile(tx, userId);
      } else {
        userId = existing.id;
        if (input.name !== undefined) await repo.update(tx, userId, { name: input.name });
      }
      await repo.setRoles(tx, userId, input.roleIds);

      let invitation: CreatedInvitation | undefined;
      if (kind === 'staff') {
        invitation = await this.invitations.create(tx, { userId, email: input.email, roleIds: input.roleIds, invitedBy: inviterId });
      }
      await this.audit.record(tx, {
        action: 'user.invited',
        resourceType: 'user',
        resourceId: userId,
        details: { kind, roleIds: input.roleIds },
      });
      return {
        user: await this.load(ctx, tx, userId),
        invitation,
        tenant: await repo.tenant(tx),
        inviterName: (await repo.byId(tx, inviterId))?.name ?? 'An administrator',
      };
    });
    if (result.invitation !== undefined) {
      await this.invitations.sendEmail(result.tenant, result.invitation, result.inviterName);
    }
    return result.user;
  }

  async update(ctx: TenantContext, userId: string, input: { name?: string; roleIds?: string[] }): Promise<UserDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      const user = await this.require(tx, repo, userId);
      if (input.name !== undefined) await repo.update(tx, userId, { name: input.name });
      if (input.roleIds !== undefined) {
        const kind = await this.kindForRoles(tx, repo, input.roleIds);
        if (kind !== user.kind) throw validationFailed([{ path: 'roleIds', issue: 'invalid_value' }]);
        await repo.setRoles(tx, userId, input.roleIds);
        await bumpAccessVersion(tx, ctx.tenantId, 'user.roles_changed', this.outbox);
      }
      await this.audit.record(tx, {
        action: 'user.updated',
        resourceType: 'user',
        resourceId: userId,
        details: { fields: Object.keys(input), ...(input.roleIds === undefined ? {} : { roleIds: input.roleIds }) },
      });
      return this.load(ctx, tx, userId);
    });
  }

  async deactivate(ctx: TenantContext, userId: string): Promise<UserDto> {
    if (userId === actorId(ctx)) throw conflict('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      const user = await this.require(tx, repo, userId);
      if (user.status !== 'deactivated') {
        await this.deactivateIn(tx, ctx, repo, userId);
        await this.audit.record(tx, { action: 'user.deactivated', resourceType: 'user', resourceId: userId });
      }
      return this.load(ctx, tx, userId);
    });
  }

  async reactivate(ctx: TenantContext, userId: string): Promise<UserDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      const user = await this.require(tx, repo, userId);
      if (user.erased_at !== null) throw conflict('USER_ERASED', 'An erased user cannot be reactivated');
      if (user.status === 'deactivated') {
        await repo.update(tx, userId, { status: 'active' });
        await bumpAccessVersion(tx, ctx.tenantId, 'user.reactivated', this.outbox);
        await this.audit.record(tx, { action: 'user.reactivated', resourceType: 'user', resourceId: userId });
      }
      return this.load(ctx, tx, userId);
    });
  }

  /** Hard delete of a user who never authored anything (FR-009). */
  async delete(ctx: TenantContext, userId: string): Promise<void> {
    if (userId === actorId(ctx)) throw conflict('CANNOT_DELETE_SELF', 'You cannot delete your own account');
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      await this.require(tx, repo, userId);
      for (const check of this.historyChecks) {
        if (await check.hasHistory(tx, userId)) {
          throw conflict('USER_HAS_HISTORY', 'This user has messages or history. Deactivate or erase them instead');
        }
      }
      await this.sessions.revokeAllForUser(tx, userId, 'deleted');
      await repo.delete(tx, userId);
      await bumpAccessVersion(tx, ctx.tenantId, 'user.deleted', this.outbox);
      await this.audit.record(tx, { action: 'user.deleted', resourceType: 'user', resourceId: userId });
    });
  }

  /** Deactivates now and schedules the erasure job (202). */
  async requestErasure(ctx: TenantContext, userId: string): Promise<void> {
    if (userId === actorId(ctx)) throw conflict('CANNOT_ERASE_SELF', 'You cannot erase your own account');
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new UsersRepository(ctx);
      const user = await this.require(tx, repo, userId);
      if (user.erased_at !== null) return;
      if (user.status !== 'deactivated') await this.deactivateIn(tx, ctx, repo, userId);
      await this.outbox.append(tx, { type: 'user.erasure_requested', payload: { userId }, streams: [`user:${userId}`] });
      await this.audit.record(tx, { action: 'user.erasure_requested', resourceType: 'user', resourceId: userId });
    });
  }

  private async deactivateIn(tx: TenantTransaction, ctx: TenantContext, repo: UsersRepository, userId: string) {
    await repo.update(tx, userId, { status: 'deactivated' });
    await this.sessions.revokeAllForUser(tx, userId, 'deactivated');
    await repo.deletePendingInvitations(tx, userId);
    await bumpAccessVersion(tx, ctx.tenantId, 'user.deactivated', this.outbox);
    await this.outbox.append(tx, { type: 'user.deactivated', payload: { userId }, streams: [`user:${userId}`] });
  }

  /** `customer` when every role is the Customer role, `staff` when none is; mixing is invalid. */
  private async kindForRoles(tx: TenantTransaction, repo: UsersRepository, roleIds: string[]): Promise<UserKind> {
    const roles = await repo.roles(tx, roleIds);
    if (roles.length !== new Set(roleIds).size) throw validationFailed([{ path: 'roleIds', issue: 'invalid_value' }]);
    const customer = roles.filter((role) => role.system_key === 'customer').length;
    if (customer === 0) return 'staff';
    if (customer === roles.length) return 'customer';
    throw validationFailed([{ path: 'roleIds', issue: 'invalid_value' }]);
  }

  private async require(tx: TenantTransaction, repo: UsersRepository, userId: string) {
    const user = await repo.byId(tx, userId);
    if (user === undefined) throw notFound('user');
    return user;
  }

  private async load(ctx: TenantContext, tx: TenantTransaction, userId: string): Promise<UserDto> {
    const repo = new UsersRepository(ctx);
    const row = await repo.byId(tx, userId);
    if (row === undefined) throw notFound('user');
    return this.toDto(row, await repo.rolesOf(tx, [userId]));
  }

  private toDto(row: UserRow, roles: Map<string, { id: string; name: string }[]>): UserDto {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      kind: row.kind,
      status: row.status,
      locked: row.locked_until !== null && row.locked_until.getTime() > this.clock.nowMs(),
      roles: roles.get(row.id) ?? [],
      availability: row.availability,
      lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }
}

function actorId(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new AppError('PERMISSION_DENIED', 403, 'You do not have permission to do this');
  return ctx.actor.id;
}

function defaultName(email: string): string {
  return (email.split('@')[0] ?? email).slice(0, 120) || 'New user';
}

const USER_COLUMNS = [
  'id',
  'email',
  'name',
  'kind',
  'status',
  'locked_until',
  'availability',
  'last_sign_in_at',
  'erased_at',
  'created_at',
] as const;

type UserRow = Awaited<ReturnType<UsersRepository['byId']>> & object;

class UsersRepository extends TenantRepository {
  byId(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users').select(USER_COLUMNS).where('id', '=', userId).executeTakeFirst();
  }

  byEmail(tx: TenantTransaction, email: string) {
    return this.selectFrom(tx, 'users').select(USER_COLUMNS).where('email', '=', email).executeTakeFirst();
  }

  list(tx: TenantTransaction, filters: Omit<UserFilters, 'cursor'> & { afterId?: string }) {
    let query = this.selectFrom(tx, 'users').select(USER_COLUMNS);
    if (filters.kind !== undefined) query = query.where('kind', '=', filters.kind);
    if (filters.status !== undefined) query = query.where('status', '=', filters.status);
    if (filters.roleId !== undefined) {
      const roleId = filters.roleId;
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('user_roles')
            .select(sql`1`.as('one'))
            .whereRef('user_roles.tenant_id', '=', 'users.tenant_id')
            .whereRef('user_roles.user_id', '=', 'users.id')
            .where('user_roles.role_id', '=', roleId),
        ),
      );
    }
    if (filters.q !== undefined && filters.q.trim() !== '') {
      const pattern = `%${filters.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or([eb('name', 'ilike', pattern), eb('email', 'ilike', pattern)]));
    }
    if (filters.afterId !== undefined) query = query.where('id', '<', filters.afterId);
    return query.orderBy('id', 'desc').limit(filters.limit + 1).execute();
  }

  async rolesOf(tx: TenantTransaction, userIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
    const result = new Map<string, { id: string; name: string }[]>();
    if (userIds.length === 0) return result;
    const rows = await this.selectFrom(tx, 'user_roles')
      .innerJoin('roles', (join) =>
        join.onRef('roles.tenant_id', '=', 'user_roles.tenant_id').onRef('roles.id', '=', 'user_roles.role_id'),
      )
      .select(['user_roles.user_id', 'roles.id', 'roles.name'])
      .where('user_roles.user_id', 'in', userIds)
      .orderBy('roles.name')
      .execute();
    for (const row of rows) {
      const list = result.get(row.user_id) ?? [];
      list.push({ id: row.id, name: row.name });
      result.set(row.user_id, list);
    }
    return result;
  }

  roles(tx: TenantTransaction, roleIds: string[]) {
    if (roleIds.length === 0) return Promise.resolve([]);
    return this.selectFrom(tx, 'roles').select(['id', 'system_key']).where('id', 'in', roleIds).execute();
  }

  async insertUser(
    tx: TenantTransaction,
    row: { email: string; name: string; kind: UserKind; status: UserStatus },
  ): Promise<string> {
    const inserted = await this.insertInto(tx, 'users', row).returning('id').executeTakeFirstOrThrow();
    return inserted.id;
  }

  async insertCustomerProfile(tx: TenantTransaction, userId: string): Promise<void> {
    await this.insertInto(tx, 'customer_profiles', { user_id: userId }).execute();
  }

  async setRoles(tx: TenantTransaction, userId: string, roleIds: string[]): Promise<void> {
    await this.deleteFrom(tx, 'user_roles').where('user_id', '=', userId).execute();
    await this.insertInto(
      tx,
      'user_roles',
      [...new Set(roleIds)].map((roleId) => ({ user_id: userId, role_id: roleId })),
    ).execute();
  }

  async update(tx: TenantTransaction, userId: string, values: { name?: string; status?: UserStatus }): Promise<void> {
    await this.updateTable(tx, 'users').set(values).where('id', '=', userId).execute();
  }

  async deletePendingInvitations(tx: TenantTransaction, userId: string): Promise<void> {
    await this.deleteFrom(tx, 'user_invitations').where('user_id', '=', userId).where('accepted_at', 'is', null).execute();
  }

  async delete(tx: TenantTransaction, userId: string): Promise<void> {
    await this.deleteFrom(tx, 'users').where('id', '=', userId).execute();
  }

  async tenant(tx: TenantTransaction): Promise<{ id: string; slug: string; name: string }> {
    return tx.selectFrom('tenants').select(['id', 'slug', 'name']).where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
  }
}
