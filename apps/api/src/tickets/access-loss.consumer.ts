import { Injectable, Module } from '@nestjs/common';

import { AccessRepository } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TagsService } from '../tags/tags.service.js';

import { groupStream, summaryOf, ticketStream } from './ticket-events.js';
import { TicketHistoryService, type FieldChange } from './ticket-history.service.js';
import { TicketsRepository } from './tickets.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { DomainEventPayload, DomainEventType } from '../platform-kernel/outbox/event-types.js';

/**
 * Unassigns ticket owners who lost access (FR-026, FR-008, T142).
 *
 * - `role.updated { groupsLostEdit }`: reconciles exactly the groups the role lost `can_edit` on
 *   (`null` = Ungrouped). A user can hold several roles, so losing it through one role doesn't
 *   necessarily mean losing edit on the group; each owner is rechecked against the current,
 *   recomputed grant (`AccessRepository.eligibleOwners`), not just the changed role.
 * - `access.changed`: every other access-reducing path (`user.roles_changed` in particular) only
 *   bumps the access version without saying which group or user was affected, so this reconciles
 *   every group that currently has an owned ticket. Other reasons (`role.created`, `group.created`,
 *   `user.activated`, `user.reactivated`, `permission_registry`, `role.deleted`, `group.deleted`)
 *   only ever grow access or are guarded against existing tickets, so this is a defensive no-op
 *   for them: nobody it looks at has actually lost edit.
 * - `user.deactivated { userId }`: a deactivated user has no access at all (`AccessRepository.load`
 *   returns nothing for a non-active user), so every ticket they own, in any group, is unassigned
 *   without recomputing anything.
 *
 * Every unassignment writes ticket history as `system` and announces `ticket.updated` /
 * `ticket.assigned` the same way `TicketsService.update` does for an owner change.
 */

type Handled = Extract<DomainEventType, 'role.updated' | 'access.changed' | 'user.deactivated'>;

@Injectable()
export class AccessLossConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'ticket-access-loss';
  readonly queue = 'automation' as const;
  readonly eventTypes: readonly Handled[] = ['role.updated', 'access.changed', 'user.deactivated'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly history: TicketHistoryService,
    private readonly tags: TagsService,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AccessLossConsumer.handle must run inside withTenant');
    const ownership = new TicketOwnershipRepository(ctx);

    if (event.type === 'user.deactivated') {
      const payload = event.payload as DomainEventPayload<'user.deactivated'>;
      for (const ticketId of await ownership.ownedBy(tx, payload.userId)) {
        await this.unassign(ctx, tx, ticketId);
      }
      return;
    }

    const groups =
      event.type === 'role.updated'
        ? (event.payload as DomainEventPayload<'role.updated'>).groupsLostEdit
        : await ownership.ownedGroups(tx);
    for (const groupId of groups) await this.reconcileGroup(ctx, tx, ownership, groupId);
  }

  private async reconcileGroup(
    ctx: TenantContext,
    tx: TenantTransaction,
    ownership: TicketOwnershipRepository,
    groupId: string | null,
  ): Promise<void> {
    const owned = await ownership.ownedInGroup(tx, groupId);
    if (owned.length === 0) return;
    const eligible = new Set((await new AccessRepository(ctx).eligibleOwners(tx, groupId)).map((owner) => owner.id));
    for (const ticket of owned) {
      if (!eligible.has(ticket.ownerId)) await this.unassign(ctx, tx, ticket.id);
    }
  }

  /** Locks the ticket, clears the owner and announces it like a caller-driven owner change would. */
  private async unassign(ctx: TenantContext, tx: TenantTransaction, ticketId: string): Promise<void> {
    const tickets = new TicketsRepository(ctx);
    const before = await tickets.lock(tx, ticketId);
    // A concurrent reconciliation (another matching group/reason in the same event) already cleared it.
    if (before === undefined || before.owner_id === null) return;

    const ticket = await tickets.update(tx, ticketId, { owner_id: null });
    const changes: FieldChange[] = [{ field: 'owner_id', old: before.owner_id, new: null }];
    await this.history.record(tx, ticket.id, changes, { actorKind: 'system' });

    const tagRefs = (await this.tags.tagsByTicketIds(tx, [ticket.id])).get(ticket.id) ?? [];
    await this.outbox.append(tx, {
      type: 'ticket.updated',
      payload: { ticket: await summaryOf(ctx, tx, ticket, tagRefs), changes },
      streams: [ticketStream(ticket.id), groupStream(ticket.group_id)],
    });
    await this.outbox.append(tx, {
      type: 'ticket.assigned',
      payload: { ticketId: ticket.id, previousOwnerId: before.owner_id, ownerId: null },
      streams: [ticketStream(ticket.id)],
    });
  }
}

class TicketOwnershipRepository extends TenantRepository {
  /** Owned tickets in one group (`null` = Ungrouped), with their current owner. */
  async ownedInGroup(tx: TenantTransaction, groupId: string | null): Promise<{ id: string; ownerId: string }[]> {
    const rows = await this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.owner_id'])
      .where('tickets.owner_id', 'is not', null)
      .where('tickets.group_id', groupId === null ? 'is' : '=', groupId)
      .execute();
    return rows.map((row) => ({ id: row.id, ownerId: row.owner_id as string }));
  }

  /** Every group (`null` = Ungrouped) that currently has at least one owned ticket. */
  async ownedGroups(tx: TenantTransaction): Promise<(string | null)[]> {
    const rows = await this.selectFrom(tx, 'tickets').select('tickets.group_id').distinct().where('tickets.owner_id', 'is not', null).execute();
    return rows.map((row) => row.group_id);
  }

  async ownedBy(tx: TenantTransaction, userId: string): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'tickets').select('tickets.id').where('tickets.owner_id', '=', userId).execute();
    return rows.map((row) => row.id);
  }
}

/** Worker-only consumer module (jobs.module.ts discovers it and routes its event types to it). */
@Module({ providers: [AccessLossConsumer] })
export class TicketsJobsModule {}
