import { Injectable } from '@nestjs/common';

import { tenantScopeOf, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { ticketStream } from '../../tickets/ticket-events.js';

import { AiDraftsRepository } from './assistant.repositories.js';

/**
 * Stores a drafts-mode turn's reply for the agents (research R13). The turn job calls it inside its
 * write transaction, after inserting the `ai_turns` row the draft points at. T023 replaces
 * `PlaceholderDraftWriter` behind `DRAFT_WRITER` with the full drafts feature.
 *
 * Contract: leave the ticket with exactly one open draft holding `body` (replacing a previous open
 * one), announce it with `ai.draft_ready` in the same transaction, and return the draft's id.
 */
export interface DraftInput {
  ticketId: string;
  turnId: string;
  body: string;
}

export interface DraftWriter {
  write(tx: TenantTransaction, input: DraftInput): Promise<{ draftId: string }>;
}

export const DRAFT_WRITER = Symbol('DRAFT_WRITER');

/** Minimal version until T023: replaces the open draft in place and announces it. */
@Injectable()
export class PlaceholderDraftWriter implements DraftWriter {
  constructor(private readonly outbox: OutboxService) {}

  async write(tx: TenantTransaction, input: DraftInput): Promise<{ draftId: string }> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('DraftWriter.write must run inside withTenant');
    const draftId = await new AiDraftsRepository(ctx).upsertOpen(tx, input);
    await this.outbox.append(tx, { type: 'ai.draft_ready', payload: { ticketId: input.ticketId, draftId }, streams: [ticketStream(input.ticketId)] });
    return { draftId };
  }
}
