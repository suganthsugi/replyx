import { Injectable } from '@nestjs/common';

import type { TicketPriority } from '../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import type { TicketRow } from '../tickets/tickets.repository.js';

/**
 * Decides where a new customer ticket goes (FR-059–FR-061, data-model.md "Routing rules"). The
 * conversation router calls it once, inside its transaction, for every ticket it creates from a
 * customer message (never for reopened tickets, and never for staff-started ones).
 *
 * `null` means no decision: the ticket stays Ungrouped (Needs Triage). The rule-based router
 * (US11) and a future classifier implement the same interface; bind one to `TICKET_ROUTER`.
 */

export interface RoutingCustomer {
  id: string;
  email: string;
}

export interface RoutingFirstMessage {
  body: string;
}

export interface RoutingDecision {
  /** Must be an active group; the router skips rules that target inactive ones. */
  groupId?: string;
  priority?: TicketPriority;
  tagIds?: string[];
  /** Shown in ticket history, e.g. the rule that matched. */
  reason?: string;
}

export interface TicketRouter {
  route(
    tx: TenantTransaction,
    ticket: TicketRow,
    firstMessage: RoutingFirstMessage,
    customer: RoutingCustomer,
  ): Promise<RoutingDecision | null>;
}

export const TICKET_ROUTER = Symbol('TICKET_ROUTER');

/** Default until routing rules exist: every new ticket waits in Needs Triage. */
@Injectable()
export class NoRoutingRouter implements TicketRouter {
  route(): Promise<RoutingDecision | null> {
    return Promise.resolve(null);
  }
}
