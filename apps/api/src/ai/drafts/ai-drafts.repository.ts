import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

export interface OpenDraft {
  id: string;
  ticketId: string;
  body: string;
  createdAt: Date;
}

/**
 * Reads and the discard of a ticket's open AI draft (data-model.md `ai_drafts`, research R13).
 * Writing a draft is `AiDraftWriter`; closing it as sent or superseded is `StaffReplyConsumer`.
 * Tenant scoping comes from `TenantRepository`; no query is built from request input.
 */
export class TicketAiDraftsRepository extends TenantRepository {
  async findOpen(tx: TenantTransaction, ticketId: string): Promise<OpenDraft | undefined> {
    const row = await this.selectFrom(tx, 'ai_drafts')
      .select(['ai_drafts.id', 'ai_drafts.ticket_id', 'ai_drafts.body', 'ai_drafts.created_at'])
      .where('ai_drafts.ticket_id', '=', ticketId)
      .where('ai_drafts.status', '=', 'open')
      .executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, ticketId: row.ticket_id, body: row.body, createdAt: row.created_at };
  }

  /** Whether `draftId` is this ticket's open draft. */
  async isOpenFor(tx: TenantTransaction, ticketId: string, draftId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'ai_drafts')
      .select('ai_drafts.id')
      .where('ai_drafts.id', '=', draftId)
      .where('ai_drafts.ticket_id', '=', ticketId)
      .where('ai_drafts.status', '=', 'open')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Closes the ticket's open draft as discarded. Returns false when none was open. */
  async discardOpen(tx: TenantTransaction, ticketId: string, resolvedBy: string, now: Date): Promise<boolean> {
    const row = await this.updateTable(tx, 'ai_drafts')
      .set({ status: 'discarded', resolved_by: resolvedBy, resolved_at: now })
      .where('ai_drafts.ticket_id', '=', ticketId)
      .where('ai_drafts.status', '=', 'open')
      .returning('ai_drafts.id')
      .executeTakeFirst();
    return row !== undefined;
  }
}
