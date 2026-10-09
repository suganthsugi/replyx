import { validationFailed } from '../../platform-kernel/http/app-error.js';

import { TicketAiDraftsRepository } from './ai-drafts.repository.js';

import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/**
 * The ai module's entry point for a staff reply that says which AI draft it was composed from
 * (`aiDraftId` on `POST /tickets/{id}/messages`, research R13). Throws 400 `VALIDATION_FAILED` on
 * `aiDraftId` unless the draft is this ticket's open draft: another ticket's, another tenant's, an
 * unknown, a discarded or an already closed draft all fail the same way.
 */
export async function assertOpenAiDraft(ctx: TenantContext, tx: TenantTransaction, ticketId: string, draftId: string): Promise<void> {
  if (!(await new TicketAiDraftsRepository(ctx).isOpenFor(tx, ticketId, draftId))) {
    throw validationFailed([{ path: 'aiDraftId', issue: 'invalid' }]);
  }
}
