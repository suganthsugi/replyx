import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/**
 * Stores a drafts-mode turn's reply for the agents (research R13). The turn job calls it inside its
 * write transaction, after inserting the `ai_turns` row the draft points at. The implementation is
 * `AiDraftWriter` (`../drafts/ai-draft-writer.ts`), bound to `DRAFT_WRITER` in `ai.module.ts`.
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
