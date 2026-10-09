import { Injectable } from '@nestjs/common';

import { decide, PolicyService, type EffectiveAccess } from '../../authorization/policy.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { notFound, permissionDenied } from '../../platform-kernel/http/app-error.js';
import { TicketsRepository } from '../../tickets/tickets.repository.js';

import { TicketAiDraftsRepository } from './ai-drafts.repository.js';

import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

export interface AiDraftDto {
  id: string;
  ticketId: string;
  body: string;
  createdAt: string;
}

/**
 * The agent's side of a ticket's AI draft (contracts/ai.yaml `/tickets/{id}/ai-draft`, R13). Both
 * calls need reply access to the ticket, which is `ticket.edit` on its group, like posting a
 * reply: a ticket the caller cannot view (or another tenant's) is 404 like a missing one, a
 * visible ticket without edit is 403. Support sessions are read-only and cannot reply, so 403.
 */
@Injectable()
export class AiDraftsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly clock: Clock,
  ) {}

  /** The ticket's open draft; 404 `AI_DRAFT_NOT_FOUND` when there is none. */
  async get(ctx: TenantContext, ticketId: string): Promise<AiDraftDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      await this.replyAccess(ctx, tx, access, ticketId);
      const draft = await new TicketAiDraftsRepository(ctx).findOpen(tx, ticketId);
      if (draft === undefined) throw notFound('ai_draft');
      return { id: draft.id, ticketId: draft.ticketId, body: draft.body, createdAt: draft.createdAt.toISOString() };
    });
  }

  /** Discards the open draft; a repeat with none open is a no-op, so a retry is safe. */
  async discard(ctx: TenantContext, ticketId: string): Promise<void> {
    const access = await this.access(ctx);
    const actor = ctx.actor.kind === 'user' ? ctx.actor.id : undefined;
    if (actor === undefined) throw permissionDenied();
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      await this.replyAccess(ctx, tx, access, ticketId);
      await new TicketAiDraftsRepository(ctx).discardOpen(tx, ticketId, actor, this.clock.now());
    });
  }

  private async replyAccess(ctx: TenantContext, tx: TenantTransaction, access: EffectiveAccess, ticketId: string): Promise<void> {
    const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
    if (ticket === undefined) throw notFound('ticket');
    const decision = decide(access, 'ticket.edit', { type: 'ticket', groupId: ticket.group_id });
    if (decision === 'not_found') throw notFound('ticket');
    if (decision === 'deny') throw permissionDenied();
  }

  private async access(ctx: TenantContext): Promise<EffectiveAccess> {
    if (ctx.actor.kind !== 'user') throw permissionDenied();
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}
