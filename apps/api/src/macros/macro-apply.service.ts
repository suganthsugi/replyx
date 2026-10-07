import { Injectable } from '@nestjs/common';

import { decide, type EffectiveAccess } from '../authorization/policy.service.js';
import { MessagesRepository } from '../messaging/messages.repository.js';
import { StaffMessagesService } from '../messaging/staff-messages.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound, permissionDenied, validationFailed } from '../platform-kernel/http/app-error.js';
import { TagsService } from '../tags/tags.service.js';
import { isPending } from '../tickets/state-machine.js';
import { TicketsRepository, type TicketRow } from '../tickets/tickets.repository.js';
import { canView, SUPPORT, TicketsService, type TicketUpdateInput } from '../tickets/tickets.service.js';

import { MACRO_BODY_MAX } from './macro-input.js';
import { MacrosRepository, type MacroRow } from './macros.repository.js';
import { MacrosService } from './macros.service.js';

import type { ApplyMacroInput } from './macro-input.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TicketDto } from '../tickets/ticket-dto.js';

/**
 * `POST /tickets/{id}/apply-macro` (contracts/tickets.yaml, FR-068, US14): the macro's reply and
 * field changes in one transaction, on the ticket row locked once up front.
 *
 * - The ticket must be visible (else 404) and editable (else 403) on its current group, the caller
 *   must hold `macro.view`, and the macro must be visible to them (else 404 `MACRO_NOT_FOUND`).
 * - The reply (the macro body, or `bodyOverride` when the agent edited it) is a public message
 *   inserted through `StaffMessagesService.insertMessage`, the same path as
 *   `POST /tickets/{id}/messages`: customer projection, offline email, first-reply timestamps and
 *   `new` to `open` all apply. A blank body means a fields-only macro and no message is created.
 * - The field changes (state, priority, tags added to the existing set, owner = the caller) then go
 *   through `TicketsService.applyLocked`, so state-machine, owner-eligibility and event rules are
 *   exactly those of `PATCH /tickets/{id}`. Any failure (409 `INVALID_TRANSITION`,
 *   `OWNER_NOT_ELIGIBLE`) rolls the reply back too.
 * - Retried with the same `clientMessageId` after the reply was stored, nothing is applied twice:
 *   the current ticket is returned.
 * - Both halves record history under the caller in this one transaction (one timestamp), each
 *   linked to its own `ticket.updated` event.
 */

const HOUR_MS = 3_600_000;

@Injectable()
export class MacroApplyService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly macros: MacrosService,
    private readonly tickets: TicketsService,
    private readonly staffMessages: StaffMessagesService,
    private readonly tags: TagsService,
    private readonly clock: Clock,
  ) {}

  async apply(ctx: TenantContext, ticketId: string, input: ApplyMacroInput): Promise<TicketDto> {
    const access = await this.tickets.access(ctx);
    if (access === SUPPORT || ctx.actor.kind !== 'user') throw permissionDenied();
    const actorId = ctx.actor.id;

    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const ticketsRepo = new TicketsRepository(ctx);
      const locked = await ticketsRepo.lock(tx, ticketId);
      if (locked === undefined || !canView(access, locked.group_id)) throw notFound('ticket');
      const decision = decide(access, 'ticket.edit', { type: 'ticket', groupId: locked.group_id });
      if (decision === 'not_found') throw notFound('ticket');
      if (decision === 'deny' || !access.permissions.has('macro.view')) throw permissionDenied();
      const macro = await this.macros.visibleMacro(ctx, tx, input.macroId, actorId);

      const retried = await new MessagesRepository(ctx).findByClientMessageId(tx, actorId, input.clientMessageId);
      if (retried?.ticket_id === locked.id) return this.current(ctx, tx, access, locked);

      const body = (input.bodyOverride ?? macro.body).trim();
      if (body.length > MACRO_BODY_MAX) throw validationFailed([{ path: 'bodyOverride', issue: 'too_long' }]);
      if (body.length > 0) {
        await this.staffMessages.insertMessage(ctx, tx, actorId, locked, {
          visibility: 'public',
          body,
          clientMessageId: input.clientMessageId,
          attachmentIds: [],
          mentionIds: [],
        });
      }

      // The reply moved the ticket (state, reply timestamps): the field changes diff against that.
      const afterReply = (await ticketsRepo.lock(tx, ticketId)) ?? locked;
      const changes = await this.fieldChanges(ctx, tx, afterReply, macro, actorId);
      if (changes === undefined) return this.current(ctx, tx, access, afterReply);

      const { ticket, tags } = await this.tickets.applyLocked(ctx, tx, access, afterReply, changes);
      return this.tickets.toDto(ctx, tx, access, ticket, tags);
    });
  }

  /** The macro's actions as a ticket update, or `undefined` when it changes no field. */
  private async fieldChanges(
    ctx: TenantContext,
    tx: TenantTransaction,
    ticket: TicketRow,
    macro: MacroRow,
    actorId: string,
  ): Promise<TicketUpdateInput | undefined> {
    const { actions } = macro;
    const update: TicketUpdateInput = {};
    if (actions.state !== undefined) {
      update.state = actions.state;
      if (isPending(actions.state)) {
        update.pendingUntil = new Date(this.clock.now().getTime() + (actions.pendingInHours ?? 1) * HOUR_MS).toISOString();
      }
    }
    if (actions.priority !== undefined) update.priority = actions.priority;
    if (actions.assignToMe === true) update.ownerId = actorId;
    if (actions.addTagIds !== undefined && actions.addTagIds.length > 0) {
      // A tag deleted since the macro was saved is skipped rather than failing the whole macro.
      const existing = await new MacrosRepository(ctx).existingTagIds(tx, actions.addTagIds);
      const current = (await this.tags.tagsByTicketIds(tx, [ticket.id])).get(ticket.id) ?? [];
      const merged = [...new Set([...current.map((tag) => tag.id), ...actions.addTagIds.filter((id) => existing.has(id))])];
      if (merged.length > current.length) update.tagIds = merged;
    }
    return Object.keys(update).length === 0 ? undefined : update;
  }

  private async current(ctx: TenantContext, tx: TenantTransaction, access: EffectiveAccess, ticket: TicketRow): Promise<TicketDto> {
    const tags = (await this.tags.tagsByTicketIds(tx, [ticket.id])).get(ticket.id) ?? [];
    return this.tickets.toDto(ctx, tx, access, ticket, tags);
  }
}
