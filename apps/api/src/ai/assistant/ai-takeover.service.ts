import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { decide, PolicyService, type EffectiveAccess } from '../../authorization/policy.service.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { AppError, conflict, notFound, permissionDenied } from '../../platform-kernel/http/app-error.js';
import { TicketHistoryService } from '../../tickets/ticket-history.service.js';
import { TicketsRepository, type TicketRow } from '../../tickets/tickets.repository.js';
import { TicketsService } from '../../tickets/tickets.service.js';
import { AiSettingsRepository, DEFAULT_SETTINGS } from '../settings/ai-settings.repository.js';
import { isActive } from '../settings/ai-status.js';

import { isStopped } from './ai-ticket-status.js';
import { AiTicketStateRepository } from './assistant.repositories.js';
import { ResponderService } from './responder.js';

import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { Responder } from '../../platform-kernel/outbox/event-types.js';

/**
 * Take over and hand back (specs/002-ai-assist research R17, FR-030): the agent's controls over
 * the assistant on one ticket. Both need `ticket.edit` on the ticket's group (404 when the ticket
 * is not visible, 403 when it is but edit is not granted) and run in one transaction.
 *
 * Lock order is the turn job's: the ticket row first (`TicketsRepository.lock`, then owner changes
 * through `TicketsService.applyLocked`), then `ai_ticket_state`. A turn that is thinking meanwhile
 * finds the stop or the new message in its write phase and discards its answer.
 *
 * - **Take over**: the caller becomes the owner (409 `OWNER_NOT_ALLOWED` if they cannot own tickets
 *   in the group), the assistant stops (`taken_over`, `taken_over_by`), history `ai_takeover`,
 *   audit `ai_assistant.taken_over`. Repeating it as the same user changes nothing.
 * - **Hand back**: only in Auto-reply (409 `AI_NOT_IN_AUTO_MODE`) and while AI runs (409
 *   `AI_PAUSED`). It clears the stop fields and the unresolved run, clears the owner, history
 *   `ai_handback`, audit `ai_assistant.handed_back`. A ticket the assistant is not stopped on is
 *   left as it is. The assistant answers from the next customer message, never the old ones.
 *
 * Both return the responder afterwards and emit `conversation.responder_changed` when it changed.
 */
@Injectable()
export class AiTakeoverService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly tickets: TicketsService,
    private readonly responders: ResponderService,
    private readonly history: TicketHistoryService,
    private readonly audit: AuditService,
  ) {}

  async takeOver(ctx: TenantContext, ticketId: string): Promise<Responder> {
    const { userId, access } = await this.caller(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const before = await this.editable(ctx, tx, access, ticketId);
      const states = new AiTicketStateRepository(ctx);
      const state = await states.ensureLocked(tx, ticketId);
      const responderBefore = await this.responders.current(tx, ctx, ticketId);
      if (state.stoppedReason === 'taken_over' && state.takenOverBy === userId && before.owner_id === userId) {
        return responderBefore ?? { kind: 'team' };
      }

      if (before.owner_id !== userId) {
        try {
          await this.tickets.applyLocked(ctx, tx, access, before, { ownerId: userId });
        } catch (error) {
          if (error instanceof AppError && error.code === 'OWNER_NOT_ELIGIBLE') {
            throw conflict('OWNER_NOT_ALLOWED', 'You cannot own tickets in this ticket’s group');
          }
          throw error;
        }
      }
      // The owner change above announces its own responder change; this one covers the stop.
      const responderMid = await this.responders.current(tx, ctx, ticketId);
      await states.takeOver(tx, ticketId, userId);
      await this.history.record(tx, ticketId, [{ field: 'ai_takeover', old: state.stoppedReason, new: userId }]);
      await this.audit.record(tx, {
        action: 'ai_assistant.taken_over',
        resourceType: 'ticket',
        resourceId: ticketId,
        details: { previousStop: state.stoppedReason ?? 'none' },
      });
      await this.responders.emitIfChanged(tx, ctx, ticketId, responderMid);
      return (await this.responders.current(tx, ctx, ticketId)) ?? { kind: 'team' };
    });
  }

  async handBack(ctx: TenantContext, ticketId: string): Promise<Responder> {
    const { access } = await this.caller(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const before = await this.editable(ctx, tx, access, ticketId);
      const settings = (await new AiSettingsRepository(ctx).find(tx)) ?? DEFAULT_SETTINGS;
      if (settings.replyMode !== 'auto') throw conflict('AI_NOT_IN_AUTO_MODE', 'The assistant can only take a ticket back in Auto-reply mode');
      if (!isActive(settings)) throw conflict('AI_PAUSED', 'AI is paused or has no key, so the assistant cannot take this ticket back');

      const states = new AiTicketStateRepository(ctx);
      const state = await states.ensureLocked(tx, ticketId);
      const responderBefore = await this.responders.current(tx, ctx, ticketId);
      if (!isStopped(state)) return responderBefore ?? { kind: 'assistant' };

      // The stop is cleared first: the owner change below then leaves the responder as the assistant.
      await states.handBack(tx, ticketId);
      if (before.owner_id !== null) await this.tickets.applyLocked(ctx, tx, access, before, { ownerId: null });
      await this.history.record(tx, ticketId, [{ field: 'ai_handback', old: state.stoppedReason ?? 'agent_replied', new: null }]);
      await this.audit.record(tx, {
        action: 'ai_assistant.handed_back',
        resourceType: 'ticket',
        resourceId: ticketId,
        details: { previousStop: state.stoppedReason ?? 'agent_replied' },
      });
      await this.responders.emitIfChanged(tx, ctx, ticketId, responderBefore);
      return (await this.responders.current(tx, ctx, ticketId)) ?? { kind: 'assistant' };
    });
  }

  /** The ticket row, locked: 404 when the caller cannot view it, 403 when they cannot edit it. */
  private async editable(ctx: TenantContext, tx: TenantTransaction, access: EffectiveAccess, ticketId: string): Promise<TicketRow> {
    const row = await new TicketsRepository(ctx).lock(tx, ticketId);
    if (row === undefined) throw notFound('ticket');
    if (decide(access, 'ticket.view', { type: 'ticket', groupId: row.group_id }) !== 'allow') throw notFound('ticket');
    if (decide(access, 'ticket.edit', { type: 'ticket', groupId: row.group_id }) !== 'allow') throw permissionDenied();
    return row;
  }

  /** Only a signed-in staff user acts on the assistant: support sessions are read-only. */
  private async caller(ctx: TenantContext): Promise<{ userId: string; access: EffectiveAccess }> {
    if (ctx.actor.kind !== 'user') throw permissionDenied();
    return { userId: ctx.actor.id, access: await this.policy.effectiveAccess(ctx, ctx.actor.id) };
  }
}
