import { Injectable } from '@nestjs/common';

import { tenantScopeOf, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { AiStatus, isActive } from '../settings/ai-status.js';

import { AiTicketStateRepository, type AiTicketState } from './assistant.repositories.js';

import type { AiReplyMode } from '../../platform-kernel/db/tables/ai.js';

/** The assistant is stopped on the ticket for any reason: hand-off, a staff reply or a take-over. */
export function isStopped(state: Pick<AiTicketState, 'stoppedReason' | 'agentRepliedAt'> | undefined): boolean {
  return state !== undefined && (state.stoppedReason !== null || state.agentRepliedAt !== null);
}

/**
 * Whether the assistant may still act on the ticket in a mode (FR-015, FR-016). In Auto-reply any
 * stop ends its posting. In Drafts mode a staff reply or a take-over still allows drafts ("Drafts
 * are still allowed"), but a hand-off ends them too.
 */
export function blocksAssistant(state: Pick<AiTicketState, 'stoppedReason' | 'agentRepliedAt'> | undefined, mode: AiReplyMode): boolean {
  if (state === undefined) return false;
  if (mode === 'auto') return isStopped(state);
  return state.stoppedReason?.startsWith('handoff:') === true;
}

/**
 * What the assistant is doing on a ticket right now (specs/002-ai-assist):
 *
 * - `isAssistantHandling`: it will act on the next customer message, by posting in Auto-reply or
 *   by drafting in Drafts mode. AI is active (key saved, not paused), the mode is not Off, and
 *   `blocksAssistant` is false for the mode. The turn trigger uses it.
 * - `isAssistantAnswering`: it will answer the customer itself. Auto-reply only, and the ticket
 *   not stopped at all (hand-off, staff reply or take-over). The notifications consumer uses it:
 *   in Drafts mode nobody answers the customer, so agents must still be pinged. It matches the
 *   `assistant` responder (T024 can reuse it).
 */
@Injectable()
export class AiTicketStatus {
  constructor(private readonly status: AiStatus) {}

  async isAssistantHandling(tx: TenantTransaction, ticketId: string): Promise<boolean> {
    const { settings, state } = await this.load(tx, ticketId);
    if (!isActive(settings) || settings.replyMode === 'off') return false;
    return !blocksAssistant(state, settings.replyMode);
  }

  async isAssistantAnswering(tx: TenantTransaction, ticketId: string): Promise<boolean> {
    const { settings, state } = await this.load(tx, ticketId);
    return isActive(settings) && settings.replyMode === 'auto' && !isStopped(state);
  }

  private async load(tx: TenantTransaction, ticketId: string) {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AiTicketStatus must run inside withTenant');
    const settings = await this.status.settings(ctx, tx);
    return { settings, state: await new AiTicketStateRepository(ctx).find(tx, ticketId) };
  }
}
