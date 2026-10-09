import { isActive } from '../settings/ai-status.js';

import { isStopped } from './ai-ticket-status.js';
import { responderSnapshot } from './responder.js';

import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import type { Responder } from '../../platform-kernel/outbox/event-types.js';
import type { TicketRow } from '../../tickets/tickets.repository.js';

/** `ai` on the staff ticket detail (contracts/ai.yaml, FR-030). */
export interface TicketAiDto {
  stopped: boolean;
  stoppedReason: 'handoff' | 'takeover' | null;
  canTakeOver: boolean;
  canHandBack: boolean;
}

export interface TicketAiView {
  responder: Responder;
  /** Absent while the tenant's reply mode is Off: there is no assistant to take over from. */
  ai?: TicketAiDto;
}

/**
 * The assistant's part of the staff ticket detail: who answers next, and what the caller may do
 * about the assistant. `canEdit` is the caller's `edit` on the ticket's group (`allowedActions`).
 *
 * - `canTakeOver`: edit access, AI running, and the assistant not already stopped.
 * - `canHandBack`: edit access, Auto-reply on and running, and the assistant stopped (handed off,
 *   a person replied, or a take-over), matching the 409 rules of the hand-back route.
 * - A stop after a staff reply has no reason in the contract's enum, so it reads `stopped: true`
 *   with `stoppedReason: null`.
 */
export async function ticketAiView(tx: TenantTransaction, ctx: TenantContext, ticket: TicketRow, canEdit: boolean): Promise<TicketAiView> {
  const { responder, settings, state } = await responderSnapshot(tx, ctx, ticket);
  if (settings.replyMode === 'off') return { responder };
  const stopped = isStopped(state);
  const running = isActive(settings);
  const reason = state?.stoppedReason ?? null;
  return {
    responder,
    ai: {
      stopped,
      stoppedReason: reason === 'taken_over' ? 'takeover' : reason?.startsWith('handoff:') === true ? 'handoff' : null,
      canTakeOver: canEdit && running && !stopped,
      canHandBack: canEdit && running && settings.replyMode === 'auto' && stopped,
    },
  };
}
