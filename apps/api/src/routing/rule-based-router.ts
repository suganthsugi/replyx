import { Injectable } from '@nestjs/common';

import { RoutingEvaluator } from './rule-evaluator.service.js';

import type { RoutingCustomer, RoutingDecision, RoutingFirstMessage, TicketRouter } from '../messaging/ticket-router.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import type { TicketRow } from '../tickets/tickets.repository.js';

/**
 * The rule-based `TicketRouter` (US11, FR-059–FR-061): the first enabled rule, by position, whose
 * conditions match the customer's first message and attributes and whose group is active decides
 * the group, and optionally priority and tags. No match is `null`: the ticket stays Ungrouped
 * (Needs Triage). Matching lives in `rule-evaluation.ts`; applying the decision (and the
 * `routing` history entries) stays with the conversation router.
 */
@Injectable()
export class RuleBasedRouter implements TicketRouter {
  constructor(private readonly evaluator: RoutingEvaluator) {}

  async route(
    tx: TenantTransaction,
    _ticket: TicketRow,
    firstMessage: RoutingFirstMessage,
    customer: RoutingCustomer,
  ): Promise<RoutingDecision | null> {
    const subject = await this.evaluator.subjectFor(tx, customer, firstMessage.body);
    const { matched } = await this.evaluator.evaluate(tx, subject);
    if (matched === null) return null;
    return {
      groupId: matched.groupId,
      ...(matched.priority === undefined ? {} : { priority: matched.priority }),
      ...(matched.tagIds.length === 0 ? {} : { tagIds: matched.tagIds }),
      reason: matched.ruleName,
    };
  }
}
