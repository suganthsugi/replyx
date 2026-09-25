import { TicketRefsRepository, toTicketSummary, type TicketSummaryDto } from './ticket-dto.js';

import type { TicketRow } from './tickets.repository.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import type { StreamKey } from '../platform-kernel/outbox/event-types.js';

/** Stream keys and payload helpers shared by everything that announces ticket changes. */

/** The list room of a group; `null` is Ungrouped. */
export function groupStream(groupId: string | null): StreamKey {
  return `tickets:group:${groupId ?? 'ungrouped'}`;
}

export function ticketStream(ticketId: string): StreamKey {
  return `ticket:${ticketId}`;
}

export async function summaryOf(ctx: TenantContext, tx: TenantTransaction, row: TicketRow): Promise<TicketSummaryDto> {
  return toTicketSummary(row, await new TicketRefsRepository(ctx).load(tx, [row]));
}
