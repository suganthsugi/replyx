import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AccessRepository, decide, PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { announceResolved } from '../messaging/conversation-events.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TagsService } from '../tags/tags.service.js';
import { TenantSettingsRepository } from '../tenancy/tenant-settings.js';

import { transition, type TransitionResult } from './state-machine.js';
import { allowedActions, TicketRefsRepository, toTicketDto, type RefDto, type TicketDto } from './ticket-dto.js';
import { groupStream, summaryOf, ticketStream } from './ticket-events.js';
import { TicketHistoryService, historyValue, type FieldChange } from './ticket-history.service.js';
import { TicketsRepository, type TicketPatch, type TicketRow } from './tickets.repository.js';

import type { TicketPriority, TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Ticket property, state and group changes, and hard deletion (contracts/tickets.yaml
 * `/tickets/{id}` PATCH/DELETE, FR-038 to FR-042).
 *
 * - Only the fields sent are changed; every request needs edit on the ticket's current group.
 * - A group move needs create on the destination and an active destination, except a ticket in
 *   Ungrouped, which a caller with edit on Ungrouped may move to any active group (FR-041).
 * - `ownerId` must have edit on the (new) group, else 409 `OWNER_NOT_ELIGIBLE` (FR-040). A move
 *   that names no owner unassigns the current one if they cannot edit the destination.
 * - State changes run through `state-machine.ts`; `pendingUntil` is required to enter or stay in
 *   a pending state.
 * - The ticket row is locked (`SELECT ... FOR UPDATE`) for the rest of the transaction, so
 *   concurrent edits serialize: the later commit wins and diffs against the true previous value,
 *   and each changed field gets its own `ticket_history` row.
 * - `tagIds`, when sent, replaces the ticket's tag set through `TagsService` (validated there,
 *   404 `TAG_NOT_FOUND` for an unknown id); the returned and broadcast ticket summary's `tags`
 *   comes from `TagsService.tagsByTicketIds`.
 */

export interface TicketUpdateInput {
  title?: string;
  state?: TicketState;
  /** `null` clears it; only meaningful while entering or remaining in a pending state. */
  pendingUntil?: string | null;
  priority?: TicketPriority;
  /** `null` is Ungrouped. */
  groupId?: string | null;
  /** `null` unassigns. */
  ownerId?: string | null;
  tagIds?: readonly string[];
}

export const SUPPORT = 'support' as const;
export type Viewer = EffectiveAccess | typeof SUPPORT;

export function canView(access: Viewer, groupId: string | null): boolean {
  return access === SUPPORT || decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
}

/** Throws 404 when the ticket is invisible and 403 when the caller may not perform `key`. */
function require(access: Viewer, key: 'ticket.edit' | 'ticket.delete' | 'ticket.create', groupId: string | null): void {
  if (access === SUPPORT) throw permissionDenied();
  const decision = decide(access, key, { type: 'ticket', groupId });
  if (decision === 'not_found') throw notFound(key === 'ticket.create' ? 'group' : 'ticket');
  if (decision === 'deny') throw permissionDenied();
}

function timersOf(ticket: TicketRow) {
  return {
    state: ticket.state,
    pendingUntil: ticket.pending_until,
    resolvedAt: ticket.resolved_at,
    autoCloseAt: ticket.auto_close_at,
    closedAt: ticket.closed_at,
  };
}

/** History entries for a transition: the state and each timer that changed. */
function transitionChanges(before: TicketRow, moved: TransitionResult): FieldChange[] {
  const changes: FieldChange[] = moved.stateChanged ? [{ field: 'state', old: before.state, new: moved.state }] : [];
  for (const [field, value] of Object.entries(moved.changes) as [keyof TransitionResult['changes'], Date | null][]) {
    changes.push({ field, old: historyValue(before[field]), new: historyValue(value) });
  }
  return changes;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly history: TicketHistoryService,
    private readonly audit: AuditService,
    private readonly tags: TagsService,
  ) {}

  async update(ctx: TenantContext, ticketId: string, input: TicketUpdateInput): Promise<TicketDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const before = await new TicketsRepository(ctx).lock(tx, ticketId);
      if (before === undefined || !canView(access, before.group_id)) throw notFound('ticket');
      require(access, 'ticket.edit', before.group_id);
      const { ticket, tags } = await this.applyLocked(ctx, tx, access, before, input);
      return this.toDto(ctx, tx, access, ticket, tags);
    });
  }

  /**
   * Applies `input` to a ticket row the caller has locked and checked edit on, with history and
   * events, in the caller's transaction. Shared by `update` and `TriageService`.
   */
  async applyLocked(
    ctx: TenantContext,
    tx: TenantTransaction,
    access: Viewer,
    before: TicketRow,
    input: TicketUpdateInput,
  ): Promise<{ ticket: TicketRow; tags: RefDto[] }> {
    const ticketId = before.id;
    const tickets = new TicketsRepository(ctx);
    const patch: TicketPatch = {};
    const changes: FieldChange[] = [];

    if (input.title !== undefined && input.title !== before.title) {
      patch.title = input.title;
      changes.push({ field: 'title', old: before.title, new: input.title });
    }
    if (input.priority !== undefined && input.priority !== before.priority) {
      patch.priority = input.priority;
      changes.push({ field: 'priority', old: before.priority, new: input.priority });
    }

    const targetGroupId = input.groupId === undefined ? before.group_id : input.groupId;
    const groupChanged = targetGroupId !== before.group_id;
    if (groupChanged) {
      await this.checkGroupMove(ctx, tx, access, before.group_id, targetGroupId);
      patch.group_id = targetGroupId;
      changes.push({ field: 'group_id', old: before.group_id, new: targetGroupId });
    }

    if (input.ownerId !== undefined && input.ownerId !== before.owner_id) {
      if (input.ownerId !== null) {
        const eligible = await new AccessRepository(ctx).eligibleOwners(tx, targetGroupId);
        if (!eligible.some((owner) => owner.id === input.ownerId)) {
          throw conflict('OWNER_NOT_ELIGIBLE', 'This owner does not have edit access on the ticket’s group');
        }
      }
      patch.owner_id = input.ownerId;
      changes.push({ field: 'owner_id', old: before.owner_id, new: input.ownerId });
    } else if (groupChanged && input.ownerId === undefined && before.owner_id !== null) {
      // A move that doesn't name an owner keeps the current one only if they can edit the new group.
      const eligible = await new AccessRepository(ctx).eligibleOwners(tx, targetGroupId);
      if (!eligible.some((owner) => owner.id === before.owner_id)) {
        patch.owner_id = null;
        changes.push({ field: 'owner_id', old: before.owner_id, new: null });
      }
    }

    let moved: TransitionResult | undefined;
    if (input.state !== undefined || input.pendingUntil !== undefined) {
      const settings = await new TenantSettingsRepository(ctx).conversation(tx);
      const pendingUntil = input.pendingUntil === undefined ? undefined : input.pendingUntil === null ? null : new Date(input.pendingUntil);
      moved = transition(timersOf(before), {
        cause: 'agent',
        to: input.state ?? before.state,
        pendingUntil,
        now: this.clock.now(),
        gracePeriodHours: settings.gracePeriodHours,
      });
      Object.assign(patch, moved.changes);
      if (moved.stateChanged) patch.state = moved.state;
      changes.push(...transitionChanges(before, moved));
    }

    if (input.tagIds !== undefined) await this.replaceTags(tx, ticketId, input.tagIds);

    const ticket = Object.keys(patch).length === 0 ? before : await tickets.update(tx, ticketId, patch);
    const tagRefs = (await this.tags.tagsByTicketIds(tx, [ticket.id])).get(ticket.id) ?? [];

    if (changes.length > 0) {
      const eventId = await this.outbox.append(tx, {
        type: 'ticket.updated',
        payload: { ticket: await summaryOf(ctx, tx, ticket, tagRefs), changes },
        streams: groupChanged
          ? [ticketStream(ticket.id), groupStream(ticket.group_id), groupStream(before.group_id)]
          : [ticketStream(ticket.id), groupStream(ticket.group_id)],
      });
      await this.history.record(tx, ticket.id, changes, { eventId });

      if (moved?.stateChanged) {
        await this.outbox.append(tx, {
          type: 'ticket.state_changed',
          payload: { ticketId: ticket.id, from: moved.from, to: moved.state },
          streams: [ticketStream(ticket.id)],
        });
      }
      if (patch.owner_id !== undefined) {
        await this.outbox.append(tx, {
          type: 'ticket.assigned',
          payload: { ticketId: ticket.id, previousOwnerId: before.owner_id, ownerId: ticket.owner_id },
          streams: [ticketStream(ticket.id)],
        });
      }
      if (moved?.stateChanged && moved.state === 'resolved' && ticket.resolved_at !== null) {
        await announceResolved(this.outbox, tx, ctx, { id: ticket.id, customerId: ticket.customer_id, resolvedAt: ticket.resolved_at });
      }
      if (moved?.closed) {
        await this.outbox.append(tx, { type: 'ticket.closed', payload: { ticketId: ticket.id }, streams: [ticketStream(ticket.id)] });
      }
      if (moved?.reopened) {
        await this.outbox.append(tx, {
          type: 'ticket.reopened',
          payload: { ticketId: ticket.id, from: moved.from },
          streams: [ticketStream(ticket.id)],
        });
      }
      if (groupChanged) {
        await this.outbox.append(tx, {
          type: 'ticket.removed_from_view',
          payload: { ticketId: ticket.id, reason: 'moved' },
          streams: [groupStream(before.group_id)],
        });
      }
    }

    return { ticket, tags: tagRefs };
  }

  async delete(ctx: TenantContext, ticketId: string): Promise<void> {
    const access = await this.access(ctx);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const tickets = new TicketsRepository(ctx);
      const row = await tickets.lock(tx, ticketId);
      if (row === undefined || !canView(access, row.group_id)) throw notFound('ticket');
      require(access, 'ticket.delete', row.group_id);

      // Not a retention tombstone: drop other tickets' links to this one outright (see
      // `deleteIncomingLinks`) instead of leaving them for the FK's `ON DELETE SET NULL`.
      await tickets.deleteIncomingLinks(tx, ticketId);
      await tickets.delete(tx, ticketId);
      await this.audit.record(tx, {
        action: 'ticket.deleted',
        resourceType: 'ticket',
        resourceId: ticketId,
        details: { number: row.number, groupId: row.group_id },
      });
      await this.outbox.append(tx, {
        type: 'ticket.removed_from_view',
        payload: { ticketId, reason: 'deleted' },
        streams: [groupStream(row.group_id), ticketStream(ticketId)],
      });
    });
  }

  /** FR-041: create on the destination, which must be active; from Ungrouped, edit on it is enough. */
  private async checkGroupMove(
    ctx: TenantContext,
    tx: TenantTransaction,
    access: Viewer,
    currentGroupId: string | null,
    targetGroupId: string | null,
  ): Promise<void> {
    if (currentGroupId !== null) require(access, 'ticket.create', targetGroupId);
    if (targetGroupId !== null) {
      const status = await new GroupStatusRepository(ctx).status(tx, targetGroupId);
      if (status === undefined) throw notFound('group');
      if (status !== 'active') throw conflict('GROUP_INACTIVE', 'The destination group is not active');
    }
  }

  private async replaceTags(tx: TenantTransaction, ticketId: string, tagIds: readonly string[]): Promise<void> {
    const unique = [...new Set(tagIds)];
    await this.tags.assertTagsExist(tx, unique);
    await this.tags.setTicketTags(tx, ticketId, unique);
  }

  async toDto(ctx: TenantContext, tx: TenantTransaction, access: Viewer, row: TicketRow, tags: readonly RefDto[]): Promise<TicketDto> {
    const refs = new TicketRefsRepository(ctx);
    const [names, links] = await Promise.all([refs.load(tx, [row]), refs.links(tx, row.id, (groupId) => canView(access, groupId))]);
    return toTicketDto(row, names, links, access === SUPPORT ? [] : allowedActions(access, row.group_id), tags);
  }

  /** Operators under a support-access grant are read-only (FR-001a): writes are always denied. */
  async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    if (ctx.actor.kind !== 'user') throw new Error('Ticket updates need a user actor');
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}

class GroupStatusRepository extends TenantRepository {
  async status(tx: TenantTransaction, groupId: string): Promise<'active' | 'inactive' | undefined> {
    const row = await this.selectFrom(tx, 'groups').select('groups.status').where('groups.id', '=', groupId).executeTakeFirst();
    return row?.status;
  }
}
