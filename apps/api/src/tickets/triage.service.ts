import { Injectable } from '@nestjs/common';

import { decide } from '../authorization/policy.service.js';
import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';

import { TicketsRepository } from './tickets.repository.js';
import { canView, SUPPORT, TicketsService } from './tickets.service.js';

import type { TicketDto } from './ticket-dto.js';
import type { TicketPriority } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * One-step triage of an ungrouped ticket (contracts/tickets.yaml `/tickets/{id}/triage`, FR-041,
 * FR-063): group, and optionally owner, priority and tags, in one transaction.
 *
 * - Needs edit on Ungrouped: 404 when the caller can't see Ungrouped, 403 when they can see but
 *   not edit it.
 * - The ticket row is locked first, so of two concurrent triages the second sees the group the
 *   first set and gets 409 `ALREADY_TRIAGED` if they can see the ticket's new group. If the winner
 *   moved it into a group the loser can't see, the loser gets the same 404 as an unknown ticket
 *   (constitution I): telling them it was triaged would confirm a ticket they have no access to.
 *   The web client shows both as "already triaged".
 * - The destination must exist (404 `GROUP_NOT_FOUND`) and be active (409 `GROUP_INACTIVE`); the
 *   owner must be able to edit it (409 `OWNER_NOT_ELIGIBLE`). The change itself, its history and
 *   events (`ticket.updated` on both group streams, `ticket.assigned`, `ticket.removed_from_view`
 *   on the Ungrouped stream; the notifications consumer turns the group change into
 *   `ticket.arrived_in_group`) come from `TicketsService.applyLocked`.
 * - `visibleToCaller` is false when the caller can't view the destination; the ticket is then
 *   left out of the response.
 */

export interface TriageInput {
  groupId: string;
  ownerId?: string;
  priority?: TicketPriority;
  tagIds?: readonly string[];
}

export interface TriageResult {
  visibleToCaller: boolean;
  ticket?: TicketDto;
}

@Injectable()
export class TriageService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly tickets: TicketsService,
  ) {}

  async triage(ctx: TenantContext, ticketId: string, input: TriageInput): Promise<TriageResult> {
    const access = await this.tickets.access(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const before = await new TicketsRepository(ctx).lock(tx, ticketId);
      if (before === undefined) throw notFound('ticket');
      const ungroupedEdit = access === SUPPORT ? 'deny' : decide(access, 'ticket.edit', { type: 'ticket', groupId: null });

      if (before.group_id !== null) {
        if (!canView(access, before.group_id)) throw notFound('ticket');
        if (ungroupedEdit === 'allow') {
          throw conflict('ALREADY_TRIAGED', 'This ticket has already been triaged');
        }
        throw permissionDenied();
      }
      if (!canView(access, null) || ungroupedEdit === 'not_found') throw notFound('ticket');
      if (ungroupedEdit === 'deny') throw permissionDenied();

      const { ticket, tags } = await this.tickets.applyLocked(ctx, tx, access, before, {
        groupId: input.groupId,
        ownerId: input.ownerId,
        priority: input.priority,
        tagIds: input.tagIds,
      });
      if (!canView(access, ticket.group_id)) return { visibleToCaller: false };
      return { visibleToCaller: true, ticket: await this.tickets.toDto(ctx, tx, access, ticket, tags) };
    });
  }
}
