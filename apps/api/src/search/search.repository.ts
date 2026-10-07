import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { TICKET_COLUMNS, type TicketRow } from '../tickets/tickets.repository.js';

import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Search queries (research D14, migration 0015). Every statement goes through the
 * `TenantRepository` helpers, so the tenant filter is always present; request text only ever
 * reaches the database as a bound parameter, and the `to_tsquery` input is built from letters and
 * digits only (see `buildSearchTerm`).
 *
 * Index use: `title_tsv` / `body_tsv` (GIN) for words and word prefixes; `tickets_number_trgm`,
 * `users_name_trgm` and `users_email_trgm` for the substring `ILIKE` lookups. The expressions here
 * must stay identical to the ones in 0015 (`replyx_unaccent(name)`, `email::text`, `number::text`).
 */

/** Wraps a matched word in the snippets. Plain text, so a client must never render a snippet as HTML. */
export const HIGHLIGHT_START = '⟦';
export const HIGHLIGHT_STOP = '⟧';

const MAX_TOKENS = 10;
const HEADLINE_OPTIONS = sql.lit(
  `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_STOP}, MaxWords=25, MinWords=10, ShortWord=1, MaxFragments=1, HighlightAll=false`,
);

export interface SearchTerm {
  /** The trimmed text as typed (exact tag name match). */
  text: string;
  /** `word:* & word:*` over the letters and digits of the text, or null when there are none. */
  tsquery: string | null;
  /** `%text%` with LIKE wildcards escaped. */
  like: string;
  /** Digits when the whole text looks like a ticket number (`1042`, `#1042`). */
  numberPrefix: string | null;
}

export function buildSearchTerm(raw: string): SearchTerm {
  const text = raw.trim();
  const tokens = text.match(/[\p{L}\p{N}]+/gu)?.slice(0, MAX_TOKENS) ?? [];
  const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`);
  return {
    text,
    tsquery: tokens.length === 0 ? null : tokens.map((token) => `${token}:*`).join(' & '),
    like: `%${escaped}%`,
    numberPrefix: /^#?\d{1,12}$/.test(text) ? text.replace('#', '') : null,
  };
}


export interface CustomerHit {
  id: string;
  name: string;
  email: string;
}

type RawTicket = Omit<TicketRow, 'number'> & { number: string };

export class SearchRepository extends TenantRepository {
  private tsquery(term: SearchTerm): Expression<unknown> {
    return sql`to_tsquery('simple', public.replyx_unaccent(${term.tsquery}))`;
  }

  /** Tickets matching the term by title, message text, number, tag name or customer name/email. */
  async tickets(
    tx: TenantTransaction,
    params: { term: SearchTerm; access: Expression<SqlBool>; afterId?: string; limit: number },
  ): Promise<TicketRow[]> {
    const { term } = params;
    const tenantId = this.ctx.tenantId;
    const matches: Expression<SqlBool>[] = [
      sql<SqlBool>`EXISTS (
        SELECT 1 FROM users u
        WHERE u.tenant_id = tickets.tenant_id AND u.id = tickets.customer_id
          AND (public.replyx_unaccent(u.name) ILIKE public.replyx_unaccent(${term.like}) OR u.email::text ILIKE ${term.like})
      )`,
      sql<SqlBool>`EXISTS (
        SELECT 1 FROM ticket_tags tt JOIN tags t ON t.tenant_id = tt.tenant_id AND t.id = tt.tag_id
        WHERE tt.tenant_id = ${tenantId}::uuid AND tt.ticket_id = tickets.id AND lower(t.name) = lower(${term.text})
      )`,
    ];
    if (term.tsquery !== null) {
      matches.push(
        sql<SqlBool>`tickets.title_tsv @@ ${this.tsquery(term)}`,
        sql<SqlBool>`EXISTS (
          SELECT 1 FROM ticket_messages m
          WHERE m.tenant_id = ${tenantId}::uuid AND m.ticket_id = tickets.id AND m.body_tsv @@ ${this.tsquery(term)}
        )`,
      );
    }
    if (term.numberPrefix !== null) matches.push(sql<SqlBool>`tickets.number::text LIKE ${`${term.numberPrefix}%`}`);

    let query = this.selectFrom(tx, 'tickets')
      .select(TICKET_COLUMNS)
      .where(params.access)
      .where(sql<SqlBool>`(${sql.join(matches, sql` OR `)})`);
    if (params.afterId !== undefined) query = query.where('tickets.id', '<', params.afterId);
    const rows = await query.orderBy('tickets.id', 'desc').limit(params.limit).execute();
    return rows.map((row) => ({ ...(row as unknown as RawTicket), number: Number((row as unknown as RawTicket).number) }));
  }

  /**
   * One snippet per ticket: the title when it matches, else the newest matching message (public
   * or internal; the caller already holds view access to these tickets). Tickets matched by
   * number, tag or customer have none. Snippets come from the unaccented text.
   */
  async highlights(tx: TenantTransaction, term: SearchTerm, ticketIds: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (term.tsquery === null || ticketIds.length === 0) return found;
    const ids = [...ticketIds];

    const messages = await this.selectFrom(tx, 'ticket_messages')
      .distinctOn('ticket_messages.ticket_id')
      .select([
        'ticket_messages.ticket_id as ticketId',
        sql<string>`ts_headline('simple', public.replyx_unaccent(ticket_messages.body), ${this.tsquery(term)}, ${HEADLINE_OPTIONS})`.as('highlight'),
      ])
      .where('ticket_messages.ticket_id', 'in', ids)
      .where(sql<SqlBool>`ticket_messages.body_tsv @@ ${this.tsquery(term)}`)
      .orderBy('ticket_messages.ticket_id')
      .orderBy('ticket_messages.created_at', 'desc')
      .orderBy('ticket_messages.id', 'desc')
      .execute();
    for (const message of messages) found.set(message.ticketId, message.highlight);

    const titles = await this.selectFrom(tx, 'tickets')
      .select([
        'tickets.id as ticketId',
        sql<string>`ts_headline('simple', public.replyx_unaccent(tickets.title), ${this.tsquery(term)}, ${HEADLINE_OPTIONS})`.as('highlight'),
      ])
      .where('tickets.id', 'in', ids)
      .where(sql<SqlBool>`tickets.title_tsv @@ ${this.tsquery(term)}`)
      .execute();
    for (const title of titles) found.set(title.ticketId, title.highlight);
    return found;
  }

  /** Customers (not staff, not erased) matching by name, email or exact tag name. */
  async customers(tx: TenantTransaction, params: { term: SearchTerm; afterId?: string; limit: number }): Promise<CustomerHit[]> {
    const { term } = params;
    let query = this.selectFrom(tx, 'users')
      .select(['users.id', 'users.name', 'users.email'])
      .where('users.kind', '=', 'customer')
      .where('users.erased_at', 'is', null)
      .where(
        sql<SqlBool>`(
          public.replyx_unaccent(users.name) ILIKE public.replyx_unaccent(${term.like})
          OR users.email::text ILIKE ${term.like}
          OR EXISTS (
            SELECT 1 FROM customer_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
            WHERE ct.tenant_id = users.tenant_id AND ct.user_id = users.id AND lower(t.name) = lower(${term.text})
          )
        )`,
      );
    if (params.afterId !== undefined) query = query.where('users.id', '<', params.afterId);
    return query.orderBy('users.id', 'desc').limit(params.limit).execute();
  }
}
