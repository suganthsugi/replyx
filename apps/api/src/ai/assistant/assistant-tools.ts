import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { COMMERCE_CONNECTOR, CommerceError, type CommerceConnector, type CommerceOrder } from '../commerce/ports.js';
import { StoreConnectionService } from '../commerce/store-connection.service.js';
import { PolicySearch } from '../knowledge/policy-search.js';

import { plainToolResult, wrapToolResult } from './assistant-prompt.js';

import type { TurnInput } from './turn-brain.js';
import type { ToolCall } from '../providers/ports.js';

/** What a tool call leads to: text for the model, or the end of the turn. */
export type ToolOutcome = { kind: 'result'; content: string } | { kind: 'handoff'; reason: string };

/** Policy searches one turn may run; more only repeat passages and grow every later prompt. */
export const MAX_POLICY_SEARCHES = 3;

/** What the tools remember within one turn: searches run and passages the model already has. */
export interface ToolTurn {
  searches: number;
  seenPassages: Set<string>;
}

export function newToolTurn(): ToolTurn {
  return { searches: 0, seenPassages: new Set() };
}

const SearchArguments = z.object({ query: z.string().trim().min(1).max(500) }).strict();
/** The only shape an order number may have; nothing else reaches the store (research R8). */
export const ORDER_NUMBER = /^[A-Za-z0-9-]{3,32}$/;
const OrderArguments = z.object({ orderNumber: z.string().trim().regex(ORDER_NUMBER) }).strict();
const HandoffArguments = z.object({ reason: z.string().trim().min(1).max(200) }).strict();

/**
 * The same answer for an unknown number and for another customer's order, so the assistant cannot be
 * used to find out which numbers exist (FR-018). Keep these two paths on this one constant.
 */
const ORDER_NOT_FOUND = { found: false } as const;

function sameEmail(a: string | null, b: string): boolean {
  return a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The part of an order the assistant may repeat. No customer email, no internal ids. */
function orderFacts(order: CommerceOrder) {
  return {
    found: true,
    number: order.number,
    status: order.state,
    shipmentState: order.shipmentState,
    completedAt: order.completedAt,
    canceledAt: order.canceledAt,
    items: order.items,
    shipments: order.shipments,
  };
}

/**
 * The assistant's three tools (research R7, R8). Identity comes from the turn (the ticket's
 * customer), never from the model's arguments; arguments are validated with zod; a missing store
 * connection or a store error is a result the model can work with, not a turn failure. Provider
 * errors from the policy search's embedding do propagate: the job pauses or retries.
 */
@Injectable()
export class AssistantTools {
  private readonly logger = new Logger('AssistantTools');

  constructor(
    private readonly policies: PolicySearch,
    private readonly stores: StoreConnectionService,
    @Inject(COMMERCE_CONNECTOR) private readonly commerce: CommerceConnector,
  ) {}

  async execute(input: TurnInput, call: ToolCall, turn: ToolTurn): Promise<ToolOutcome> {
    const args = parseJson(call.arguments);
    switch (call.name) {
      case 'search_policies':
        return this.searchPolicies(input, args, turn);
      case 'lookup_order':
        return this.lookupOrder(input, args);
      case 'handoff': {
        const parsed = HandoffArguments.safeParse(args);
        return { kind: 'handoff', reason: parsed.success ? parsed.data.reason : 'model_requested' };
      }
      default:
        return { kind: 'result', content: plainToolResult({ error: 'unknown_tool' }) };
    }
  }

  /** Up to `MAX_POLICY_SEARCHES` per turn; a passage already returned in the turn is not sent again. */
  private async searchPolicies(input: TurnInput, args: unknown, turn: ToolTurn): Promise<ToolOutcome> {
    const parsed = SearchArguments.safeParse(args);
    if (!parsed.success) return { kind: 'result', content: plainToolResult({ error: 'invalid_arguments' }) };
    if (turn.searches >= MAX_POLICY_SEARCHES) return { kind: 'result', content: plainToolResult({ error: 'search_limit_reached' }) };
    turn.searches += 1;
    const passages = await this.policies.search(input.ctx, parsed.data.query, { ticketId: input.ticketId });
    const fresh = passages.filter((p) => {
      const key = JSON.stringify([p.documentTitle, p.heading, p.content]);
      if (turn.seenPassages.has(key)) return false;
      turn.seenPassages.add(key);
      return true;
    });
    return {
      kind: 'result',
      content: wrapToolResult('policies', {
        passages: fresh.map((p) => ({ document: p.documentTitle, heading: p.heading, content: p.content })),
        ...(fresh.length < passages.length ? { alreadyReturned: passages.length - fresh.length } : {}),
      }),
    };
  }

  private async lookupOrder(input: TurnInput, args: unknown): Promise<ToolOutcome> {
    const parsed = OrderArguments.safeParse(args);
    if (!parsed.success) return { kind: 'result', content: plainToolResult({ error: 'invalid_order_number' }) };

    const credentials = await this.stores.credentials(input.ctx);
    if (credentials === undefined) return { kind: 'result', content: plainToolResult({ status: 'not_available' }) };

    let order: CommerceOrder | null;
    try {
      order = await this.commerce.getOrder(credentials, parsed.data.orderNumber);
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      // No body, no key: only the kind is logged.
      this.logger.warn(`Order lookup failed: ${error.kind}`);
      return { kind: 'result', content: plainToolResult({ status: 'unavailable' }) };
    }
    if (order === null || !sameEmail(order.email, input.customer.email)) return { kind: 'result', content: wrapToolResult('order', ORDER_NOT_FOUND) };
    return { kind: 'result', content: wrapToolResult('order', orderFacts(order)) };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
