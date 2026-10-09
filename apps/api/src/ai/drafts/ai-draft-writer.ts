import { Injectable } from '@nestjs/common';

import { tenantScopeOf, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { ticketStream } from '../../tickets/ticket-events.js';
import { AiDraftsRepository } from '../assistant/assistant.repositories.js';

import type { DraftInput, DraftWriter } from '../assistant/draft-writer.js';

/**
 * Stores a drafts-mode turn's reply for the agents (research R13), bound to `DRAFT_WRITER`.
 *
 * The ticket keeps at most one open draft (partial unique index on `ai_drafts (tenant_id,
 * ticket_id) where status = 'open'`): a new turn replaces the open draft's body in place, so its
 * id stays the same, and otherwise inserts one. `ai.draft_ready` is appended in the same
 * transaction with ids only (`{ ticketId, draftId }`, never the body) on the ticket stream, so it
 * reaches the staff looking at the ticket; they then call `GET /tickets/{id}/ai-draft`.
 *
 * Runs inside the turn job's write transaction, which already holds the ticket lock, so two turns
 * on one ticket never race on the open draft.
 */
@Injectable()
export class AiDraftWriter implements DraftWriter {
  constructor(private readonly outbox: OutboxService) {}

  async write(tx: TenantTransaction, input: DraftInput): Promise<{ draftId: string }> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AiDraftWriter.write must run inside withTenant');
    const draftId = await new AiDraftsRepository(ctx).upsertOpen(tx, input);
    await this.outbox.append(tx, { type: 'ai.draft_ready', payload: { ticketId: input.ticketId, draftId }, streams: [ticketStream(input.ticketId)] });
    return { draftId };
  }
}
