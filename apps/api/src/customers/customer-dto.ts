import type { UserStatus } from '../platform-kernel/db/tables/identity.js';
import type { RefDto, TicketSummaryDto } from '../tickets/ticket-dto.js';

/**
 * Customer profile DTO (contracts/tickets.yaml `CustomerProfile`). Ticket summaries reuse the
 * tickets module's `TicketSummaryDto`/`RefDto` (ticket-dto.ts) rather than redefining them.
 */
export interface CustomerProfileDto {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  phone: string | null;
  company: string | null;
  tags: RefDto[];
  createdAt: string;
  lastMessageAt: string | null;
  openTickets: TicketSummaryDto[];
  closedTickets: TicketSummaryDto[];
}
