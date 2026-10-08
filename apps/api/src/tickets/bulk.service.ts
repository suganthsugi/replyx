import { Injectable } from '@nestjs/common';

import { decide } from '../authorization/policy.service.js';
import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';
import { AppError, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { TagsService } from '../tags/tags.service.js';

import { TicketsRepository } from './tickets.repository.js';
import { canView, SUPPORT, TicketsService, type TicketUpdateInput, type Viewer } from './tickets.service.js';

import type { TicketPriority, TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * `POST /tickets/bulk` (contracts/tickets.yaml, FR-041, T238): the same changes applied to up to
 * 100 tickets, each one checked and written on its own.
 *
 * - Every ticket gets its own transaction, so one refusal never undoes or blocks the others; the
 *   response lists a result per ticket, in request order (duplicates are applied once).
 * - Per ticket: invisible or unknown is `TICKET_NOT_FOUND`, no edit on its group is
 *   `PERMISSION_DENIED` (`ticket.bulk_update` needs edit, like `PATCH /tickets/{id}`).
 * - The changes go through `TicketsService.applyLocked`, the path `PATCH` uses, so state rules,
 *   owner eligibility, history rows and events are the same as for a single edit; its errors
 *   (`INVALID_TRANSITION`, `OWNER_NOT_ELIGIBLE`, `TAG_NOT_FOUND`, ...) become that ticket's code.
 * - `addTagIds` adds to each ticket's tags instead of replacing them.
 */

export interface BulkChanges {
  state?: TicketState;
  pendingUntil?: string | null;
  priority?: TicketPriority;
  ownerId?: string | null;
  addTagIds?: readonly string[];
}

export interface BulkResult {
  ticketId: string;
  ok: boolean;
  errorCode?: string;
}

@Injectable()
export class BulkUpdateService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly tickets: TicketsService,
    private readonly tags: TagsService,
  ) {}

  async update(ctx: TenantContext, ticketIds: readonly string[], changes: BulkChanges): Promise<BulkResult[]> {
    const access = await this.tickets.access(ctx);
    const results: BulkResult[] = [];
    for (const ticketId of new Set(ticketIds)) {
      try {
        await this.updateOne(ctx, access, ticketId, changes);
        results.push({ ticketId, ok: true });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        results.push({ ticketId, ok: false, errorCode: error.code });
      }
    }
    return results;
  }

  private async updateOne(ctx: TenantContext, access: Viewer, ticketId: string, changes: BulkChanges): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const before = await new TicketsRepository(ctx).lock(tx, ticketId);
      if (before === undefined || !canView(access, before.group_id)) throw notFound('ticket');
      if (access === SUPPORT || decide(access, 'ticket.bulk_update', { type: 'ticket', groupId: before.group_id }) !== 'allow') {
        throw permissionDenied();
      }

      const { addTagIds, ...fields } = changes;
      const input: TicketUpdateInput = { ...fields };
      if (addTagIds !== undefined && addTagIds.length > 0) {
        const current = (await this.tags.tagsByTicketIds(tx, [ticketId])).get(ticketId) ?? [];
        const merged = [...new Set([...current.map((tag) => tag.id), ...addTagIds])];
        if (merged.length > current.length) input.tagIds = merged;
      }
      await this.tickets.applyLocked(ctx, tx, access, before, input);
    });
  }
}
