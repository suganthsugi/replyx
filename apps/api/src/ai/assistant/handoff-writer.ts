import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { AssistantMessageWriter } from '../../messaging/assistant-message.writer.js';
import { tenantScopeOf, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { TagsService } from '../../tags/tags.service.js';
import { groupStream, summaryOf, ticketStream } from '../../tickets/ticket-events.js';
import { TicketHistoryService, type FieldChange } from '../../tickets/ticket-history.service.js';
import { TicketsRepository } from '../../tickets/tickets.repository.js';

import { AiTicketStateRepository } from './assistant.repositories.js';
import { ResponderService } from './responder.js';

import type { AiReplyMode, AiStopReason } from '../../platform-kernel/db/tables/ai.js';

/** The one fixed hand-off notice (research R7 step 6); localization comes with the tenant locale work. */
export const HANDOFF_MESSAGE = "I've passed this to our team; a person will reply here soon.";

/** The tenant tag that marks tickets the assistant passed on, so views can filter by it. */
export const HANDOFF_TAG = 'AI hand-off';

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
 * Hands a ticket to staff inside the caller's transaction (FR-015, FR-022, research R7 step 6):
 *
 * - stops the assistant on the ticket (`stopped_reason = handoff:{reason}`);
 * - tags the ticket "AI hand-off" (the tag is created on first use) and sets `waiting_on = support`;
 * - announces `ticket.updated`, writes the `ai_handoff` history entry (actor kind `ai`) and an audit entry;
 * - in Auto-reply mode only, posts the fixed notice with `metadata.handoff = true`, which never
 *   counts as a reply for SLA (T020);
 * - emits `conversation.responder_changed` when the responder changed.
 *
 * The caller holds the ticket lock (`TicketsRepository.lock`), then `ai_ticket_state`.
 */
@Injectable()
export class HandoffWriter {
  constructor(
    private readonly messages: AssistantMessageWriter,
    private readonly responders: ResponderService,
    private readonly tags: TagsService,
    private readonly history: TicketHistoryService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the id of the notice, or undefined when none was posted. */
  async write(tx: TenantTransaction, input: HandoffInput): Promise<string | undefined> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('HandoffWriter.write must run inside withTenant');
    const before = await this.responders.current(tx, ctx, input.ticketId);
    const stopReason = handoffStopReason(input.reason);
    await new AiTicketStateRepository(ctx).stop(tx, input.ticketId, stopReason);

    const tickets = new TicketsRepository(ctx);
    const ticket = await tickets.lock(tx, input.ticketId);
    if (ticket === undefined) throw new Error('Cannot hand off a ticket that does not exist');
    await this.tags.addToTicket(tx, input.ticketId, (await this.tags.findOrCreate(tx, HANDOFF_TAG)).id);
    const updated = ticket.waiting_on === 'support' ? ticket : await tickets.update(tx, ticket.id, { waiting_on: 'support' });

    const changes: FieldChange[] = [
      { field: 'waiting_on', old: ticket.waiting_on, new: 'support' },
      { field: 'ai_handoff', old: null, new: stopReason.slice('handoff:'.length) },
    ];
    const tagRefs = (await this.tags.tagsByTicketIds(tx, [ticket.id])).get(ticket.id) ?? [];
    const eventId = await this.outbox.append(tx, {
      type: 'ticket.updated',
      payload: { ticket: await summaryOf(ctx, tx, updated, tagRefs), changes },
      streams: [ticketStream(ticket.id), groupStream(ticket.group_id)],
    });
    await this.history.record(tx, ticket.id, changes, { eventId, actorKind: 'ai' });
    await this.audit.record(tx, {
      action: 'ai_assistant.handed_off',
      resourceType: 'ticket',
      resourceId: ticket.id,
      details: { reason: stopReason.slice('handoff:'.length), mode: input.mode },
    });

    let noticeId: string | undefined;
    if (input.mode === 'auto') {
      const notice = await this.messages.write(tx, { ticketId: input.ticketId, body: HANDOFF_MESSAGE, clientMessageId: `ai-handoff:${input.turnId}`, kind: 'handoff' });
      noticeId = notice.id;
    }
    await this.responders.emitIfChanged(tx, ctx, input.ticketId, before);
    return noticeId;
  }
}
