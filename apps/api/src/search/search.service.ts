import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PolicyService } from '../authorization/policy.service.js';
import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';
import { validationFailed } from '../platform-kernel/http/app-error.js';
import { decodeCursor, encodeCursor, type Page } from '../platform-kernel/http/pagination.js';
import { TagsService } from '../tags/tags.service.js';
import { TicketRefsRepository, toTicketSummary, type TicketSummaryDto } from '../tickets/ticket-dto.js';

import { buildSearchTerm, SearchRepository } from './search.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Staff search (FR-070, research D14, T231). `SearchService` is the seam: this file ships the
 * PostgreSQL implementation (full-text on ticket titles and message bodies, trigram on customer
 * name/email/ticket number, exact tag names); another engine can replace it behind the same class.
 *
 * - Ticket results are ALWAYS the tenant filter AND `ticketAccessFilter(ctx, 'view')` AND the
 *   match, so a ticket in a group the caller cannot view never appears, whatever matched. Message
 *   text (public replies and internal notes alike) is only searched on those visible tickets, and
 *   only staff reach this service (customers have no search).
 * - Customer results need `user.view` (the same key as customer profiles); without it they are
 *   left out rather than answered with an error.
 * - Ordering is newest first by id (UUIDv7 is time-ordered), tickets before customers for
 *   `type=all`. The cursor is `{ phase, id }`: the last returned id of the phase being read, or
 *   just the phase when that phase has not started.
 * - `highlight` is plain text with the match wrapped in `HIGHLIGHT_START` / `HIGHLIGHT_STOP`.
 */

export type SearchType = 'tickets' | 'customers' | 'all';

export interface SearchQuery {
  q: string;
  type: SearchType;
  limit: number;
  cursor?: string;
}

export interface TicketSearchResult {
  type: 'ticket';
  ticket: TicketSummaryDto;
  highlight?: string;
}

export interface CustomerSearchResult {
  type: 'customer';
  customer: { id: string; name: string; avatarUrl: string | null };
  email: string;
}

export type SearchResult = TicketSearchResult | CustomerSearchResult;

export abstract class SearchService {
  abstract search(ctx: TenantContext, query: SearchQuery): Promise<Page<SearchResult>>;
}

const Cursor = z
  .object({ phase: z.enum(['tickets', 'customers']), id: z.uuid().optional() })
  .strict();
type Cursor = z.infer<typeof Cursor>;

@Injectable()
export class PostgresSearchService extends SearchService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly tags: TagsService,
  ) {
    super();
  }

  async search(ctx: TenantContext, query: SearchQuery): Promise<Page<SearchResult>> {
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, Cursor);
    // A cursor belongs to the `type` it came from: one that points into a phase this type never reads is a bad cursor.
    if (cursor !== undefined && ((query.type === 'tickets' && cursor.phase === 'customers') || (query.type === 'customers' && cursor.phase === 'tickets'))) {
      throw validationFailed([{ path: 'cursor', issue: 'invalid_cursor' }]);
    }
    const term = buildSearchTerm(query.q);

    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new SearchRepository(ctx);
      const wantTickets = query.type !== 'customers';
      const wantCustomers = query.type !== 'tickets' && (await this.policy.can(ctx, 'user.view')) === 'allow';
      const inTickets = wantTickets && (cursor === undefined || cursor.phase === 'tickets');

      const items: SearchResult[] = [];
      let nextCursor: Cursor | null = null;

      if (inTickets) {
        const access = await this.policy.ticketAccessFilter(ctx, 'view');
        const rows = await repo.tickets(tx, { term, access, afterId: cursor?.id, limit: query.limit + 1 });
        const page = rows.slice(0, query.limit);
        const [refs, tagsByTicket, highlights] = await Promise.all([
          new TicketRefsRepository(ctx).load(tx, page),
          this.tags.tagsByTicketIds(tx, page.map((row) => row.id)),
          repo.highlights(tx, term, page.map((row) => row.id)),
        ]);
        for (const row of page) {
          const highlight = highlights.get(row.id);
          items.push({
            type: 'ticket',
            ticket: toTicketSummary(row, refs, tagsByTicket.get(row.id) ?? []),
            ...(highlight === undefined ? {} : { highlight }),
          });
        }
        if (rows.length > query.limit) nextCursor = { phase: 'tickets', id: page.at(-1)?.id };
      }

      // Customers follow the tickets once the tickets are exhausted (or alone for type=customers).
      if (wantCustomers && nextCursor === null) {
        const remaining = query.limit - items.length;
        const afterId = inTickets ? undefined : cursor?.id;
        const rows = await repo.customers(tx, { term, afterId, limit: remaining + 1 });
        const page = rows.slice(0, remaining);
        for (const row of page) {
          items.push({ type: 'customer', customer: { id: row.id, name: row.name, avatarUrl: null }, email: row.email });
        }
        if (rows.length > remaining) nextCursor = { phase: 'customers', id: page.at(-1)?.id ?? afterId };
      }

      return { items, nextCursor: nextCursor === null ? null : encodeCursor(nextCursor) };
    });
  }
}
