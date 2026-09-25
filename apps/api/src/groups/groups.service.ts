import { Inject, Injectable, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { bumpAccessVersion } from '../authorization/access-version.js';
import { PolicyService } from '../authorization/policy.service.js';
import { newGroupAccess } from '../authorization/role-access.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import type { Availability } from '../platform-kernel/db/tables/identity.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Groups (FR-028–FR-030, contracts/access.yaml `/groups*`).
 *
 * - Names are 1–80 chars, unique per tenant case-insensitively (DB index `groups_tenant_name`);
 *   the unique violation is surfaced as 409 `GROUP_NAME_TAKEN`.
 * - A new group gets full access for the Admin role only, in the same transaction (FR-029), and
 *   bumps the access version so Admins' sockets join its room.
 * - Deactivation keeps the group's tickets (FR-028); moving tickets into an inactive group is the
 *   tickets module's check.
 * - Delete is refused with 409 `GROUP_HAS_TICKETS` while any ticket references the group (FR-030);
 *   otherwise the role access rows go with it (FK cascade) and the access version is bumped.
 * - Ticket counts come from the tickets module through `GROUP_TICKET_STATS` (US6); until it
 *   exists every count is 0 and no group has tickets.
 */

export interface GroupDto {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive';
  openTicketCount: number;
}

export interface GroupInput {
  name?: string;
  description?: string;
  status?: 'active' | 'inactive';
}

export interface EligibleOwnerDto {
  id: string;
  name: string;
  avatarUrl: null;
  availability: Availability;
  openTicketCount: number;
}

/** Ticket numbers for groups and owners, answered by the tickets module (US6). */
export interface GroupTicketStats {
  /** Open tickets per group id; groups without any are absent. */
  openTicketCounts(tx: TenantTransaction, groupIds: readonly string[]): Promise<Map<string, number>>;
  /** Open tickets owned per user id; users without any are absent. */
  openTicketCountsByOwner(tx: TenantTransaction, userIds: readonly string[]): Promise<Map<string, number>>;
  /** Whether any ticket (in any state) references the group. */
  hasTickets(tx: TenantTransaction, groupId: string): Promise<boolean>;
}

/** Provided by the tickets module from a global module once tickets exist. */
export const GROUP_TICKET_STATS = Symbol('GROUP_TICKET_STATS');

const noTickets: GroupTicketStats = {
  openTicketCounts: () => Promise.resolve(new Map()),
  openTicketCountsByOwner: () => Promise.resolve(new Map()),
  hasTickets: () => Promise.resolve(false),
};

type GroupRow = { id: string; name: string; description: string | null; status: 'active' | 'inactive' };

@Injectable()
export class GroupsService {
  private readonly tickets: GroupTicketStats;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Optional() @Inject(GROUP_TICKET_STATS) tickets?: GroupTicketStats,
  ) {
    this.tickets = tickets ?? noTickets;
  }

  list(ctx: TenantContext, filters: { status?: 'active' | 'inactive' }): Promise<GroupDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const rows = await new GroupsRepository(ctx).list(tx, filters.status);
      const counts = await this.tickets.openTicketCounts(tx, rows.map((row) => row.id));
      return rows.map((row) => toDto(row, counts.get(row.id) ?? 0));
    });
  }

  get(ctx: TenantContext, groupId: string): Promise<GroupDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => this.load(ctx, tx, groupId));
  }

  async create(ctx: TenantContext, input: GroupInput & { name: string }): Promise<GroupDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new GroupsRepository(ctx);
      const groupId = await nameTaken(() =>
        repo.insert(tx, { name: input.name, description: input.description ?? null, status: input.status ?? 'active' }),
      );
      await repo.grantAdminFullAccess(tx, groupId);
      await bumpAccessVersion(tx, ctx.tenantId, 'group.created', this.outbox);
      await this.audit.record(tx, {
        action: 'group.created',
        resourceType: 'group',
        resourceId: groupId,
        details: { name: input.name, status: input.status ?? 'active' },
      });
      return this.load(ctx, tx, groupId);
    });
  }

  async update(ctx: TenantContext, groupId: string, input: GroupInput): Promise<GroupDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new GroupsRepository(ctx);
      const group = await repo.byId(tx, groupId);
      if (group === undefined) throw notFound('group');

      const changes: Partial<Pick<GroupRow, 'name' | 'description' | 'status'>> = {};
      if (input.name !== undefined && input.name !== group.name) changes.name = input.name;
      if (input.description !== undefined && input.description !== (group.description ?? '')) {
        changes.description = input.description === '' ? null : input.description;
      }
      if (input.status !== undefined && input.status !== group.status) changes.status = input.status;

      if (Object.keys(changes).length > 0) {
        await nameTaken(() => repo.update(tx, groupId, changes));
        await this.audit.record(tx, {
          action: 'group.updated',
          resourceType: 'group',
          resourceId: groupId,
          details: changes,
        });
      }
      return this.load(ctx, tx, groupId);
    });
  }

  async delete(ctx: TenantContext, groupId: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new GroupsRepository(ctx);
      const group = await repo.byId(tx, groupId);
      if (group === undefined) throw notFound('group');
      if (await this.tickets.hasTickets(tx, groupId)) {
        throw conflict('GROUP_HAS_TICKETS', 'Move this group’s tickets to another group or to Ungrouped first');
      }
      await repo.delete(tx, groupId);
      await bumpAccessVersion(tx, ctx.tenantId, 'group.deleted', this.outbox);
      await this.audit.record(tx, { action: 'group.deleted', resourceType: 'group', resourceId: groupId, details: { name: group.name } });
    });
  }

  /**
   * Active staff with edit on the group (FR-040, FR-062). The caller needs `ticket.edit` on the
   * group themselves: no view → 404 like an unknown group, view without edit → 403. A support
   * session (read-only operator) skips the group check; the grant is its authorisation.
   */
  async eligibleOwners(ctx: TenantContext, groupId: string): Promise<EligibleOwnerDto[]> {
    await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      if ((await new GroupsRepository(ctx).byId(tx, groupId)) === undefined) throw notFound('group');
    });
    if (ctx.actor.kind === 'user') {
      const decision = await this.policy.can(ctx, 'ticket.edit', { type: 'ticket', groupId });
      if (decision === 'not_found') throw notFound('group');
      if (decision === 'deny') throw permissionDenied();
    }
    const owners = await this.policy.eligibleOwners(ctx, groupId);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const counts = await this.tickets.openTicketCountsByOwner(tx, owners.map((owner) => owner.id));
      return owners.map((owner) => ({
        id: owner.id,
        name: owner.name,
        avatarUrl: null,
        availability: owner.availability,
        openTicketCount: counts.get(owner.id) ?? 0,
      }));
    });
  }

  private async load(ctx: TenantContext, tx: TenantTransaction, groupId: string): Promise<GroupDto> {
    const row = await new GroupsRepository(ctx).byId(tx, groupId);
    if (row === undefined) throw notFound('group');
    const counts = await this.tickets.openTicketCounts(tx, [groupId]);
    return toDto(row, counts.get(groupId) ?? 0);
  }
}

function toDto(row: GroupRow, openTicketCount: number): GroupDto {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status,
    openTicketCount,
  };
}

/** Runs a write and turns the case-insensitive name index violation into 409 `GROUP_NAME_TAKEN`. */
async function nameTaken<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'groups_tenant_name') {
      throw conflict('GROUP_NAME_TAKEN', 'A group with this name already exists');
    }
    throw error;
  }
}

class GroupsRepository extends TenantRepository {
  list(tx: TenantTransaction, status?: 'active' | 'inactive'): Promise<GroupRow[]> {
    let query = this.selectFrom(tx, 'groups').select(['id', 'name', 'description', 'status']);
    if (status !== undefined) query = query.where('status', '=', status);
    return query.orderBy('name').orderBy('id').execute();
  }

  byId(tx: TenantTransaction, groupId: string): Promise<GroupRow | undefined> {
    return this.selectFrom(tx, 'groups').select(['id', 'name', 'description', 'status']).where('id', '=', groupId).executeTakeFirst();
  }

  async insert(tx: TenantTransaction, row: { name: string; description: string | null; status: 'active' | 'inactive' }): Promise<string> {
    const inserted = await this.insertInto(tx, 'groups', row).returning('id').executeTakeFirstOrThrow();
    return inserted.id;
  }

  async update(tx: TenantTransaction, groupId: string, values: Partial<Pick<GroupRow, 'name' | 'description' | 'status'>>): Promise<void> {
    await this.updateTable(tx, 'groups').set(values).where('id', '=', groupId).execute();
  }

  async delete(tx: TenantTransaction, groupId: string): Promise<void> {
    await this.deleteFrom(tx, 'groups').where('id', '=', groupId).execute();
  }

  /** FR-029: the Admin role, and no other, gets every flag on a new group. */
  async grantAdminFullAccess(tx: TenantTransaction, groupId: string): Promise<void> {
    const roles = await this.selectFrom(tx, 'roles').select(['id', 'system_key']).execute();
    const rows = newGroupAccess(roles, groupId);
    if (rows.length === 0) throw new Error('Tenant has no Admin role');
    await this.insertInto(
      tx,
      'role_group_access',
      rows.map((row) => ({
        role_id: row.roleId,
        group_id: row.groupId,
        can_view: row.view,
        can_create: row.create,
        can_edit: row.edit,
        can_delete: row.delete,
      })),
    ).execute();
  }
}
