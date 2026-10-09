import { Injectable } from '@nestjs/common';

import { AssistantMessageWriter } from '../../messaging/assistant-message.writer.js';
import { tenantScopeOf, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

import { AiTicketStateRepository } from './assistant.repositories.js';
import { ResponderService } from './responder.js';

import type { AiReplyMode, AiStopReason } from '../../platform-kernel/db/tables/ai.js';

/** The one fixed hand-off notice (research R7 step 6); localization comes with the tenant locale work. */
export const HANDOFF_MESSAGE = "I've passed this to our team; a person will reply here soon.";

const MAX_REASON_LENGTH = 40;

/** `ai_ticket_state_stopped_reason` allows `handoff:` plus 1 to 40 lower-case letters and underscores. */
export function handoffStopReason(reason: string): AiStopReason {
  const slug = reason
    .toLowerCase()
    .replace(/[^a-z_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_REASON_LENGTH);
  return `handoff:${slug.length === 0 ? 'unspecified' : slug}`;
}

export interface HandoffInput {
  ticketId: string;
  turnId: string;
  reason: string;
  /** The mode now: only Auto-reply posts the notice. */
  mode: AiReplyMode;
}

/**
 * Hands a ticket to staff inside the turn's write transaction: stops the assistant on it, posts the
 * fixed notice in Auto-reply mode (it never counts for SLA, T020) and announces the responder change.
 *
 * TODO(T022): also add the `ai_handoff` history entry, the tenant tag "AI hand-off" (created on
 * first use), `waiting_on = support`, and the audit entry. They belong here, in this transaction.
 */
@Injectable()
export class HandoffWriter {
  constructor(
    private readonly messages: AssistantMessageWriter,
    private readonly responders: ResponderService,
  ) {}

  /** Returns the id of the notice, or undefined when none was posted. */
  async write(tx: TenantTransaction, input: HandoffInput): Promise<string | undefined> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('HandoffWriter.write must run inside withTenant');
    const before = await this.responders.current(tx, ctx, input.ticketId);
    await new AiTicketStateRepository(ctx).stop(tx, input.ticketId, handoffStopReason(input.reason));

    let noticeId: string | undefined;
    if (input.mode === 'auto') {
      const notice = await this.messages.write(tx, { ticketId: input.ticketId, body: HANDOFF_MESSAGE, clientMessageId: `ai-handoff:${input.turnId}`, kind: 'handoff' });
      noticeId = notice.id;
    }
    await this.responders.emitIfChanged(tx, ctx, input.ticketId, before);
    return noticeId;
  }
}
