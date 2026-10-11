import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** Satisfaction ratings (data-model.md "csat_ratings", FR-087). */

/** contracts/tickets.yaml `Ticket.csat`: shown on the ticket once the customer rated it. */
export interface CsatDto {
  score: number;
  comment: string | null;
  ratedAt: string;
}

export interface SatisfactionFigure {
  /** Mean score, 2 decimals; `null` with no ratings. */
  average: number | null;
  responses: number;
}

export function toFigure(row: { average: string | number | null; responses: string | number }): SatisfactionFigure {
  const responses = Number(row.responses);
  return { average: responses === 0 || row.average === null ? null : Math.round(Number(row.average) * 100) / 100, responses };
}

export class CsatRepository extends TenantRepository {
  /** Ratings (not skips) by ticket id. */
  async byTicketIds(tx: TenantTransaction, ticketIds: readonly string[]): Promise<Map<string, CsatDto>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'csat_ratings')
      .select(['csat_ratings.ticket_id', 'csat_ratings.score', 'csat_ratings.comment', 'csat_ratings.rated_at'])
      .where('csat_ratings.ticket_id', 'in', ticketIds)
      .where('csat_ratings.score', 'is not', null)
      .execute();
    const result = new Map<string, CsatDto>();
    for (const row of rows) {
      if (row.score === null || row.rated_at === null) continue;
      result.set(row.ticket_id, { score: row.score, comment: row.comment, ratedAt: row.rated_at.toISOString() });
    }
    return result;
  }

  /** Rated (score set) or not: `undefined` when there is no row. */
  async state(tx: TenantTransaction, ticketId: string): Promise<'rated' | 'skipped' | undefined> {
    const row = await this.selectFrom(tx, 'csat_ratings').select('csat_ratings.score').where('csat_ratings.ticket_id', '=', ticketId).executeTakeFirst();
    if (row === undefined) return undefined;
    return row.score === null ? 'skipped' : 'rated';
  }

  async rate(tx: TenantTransaction, ticketId: string, customerId: string, score: number, comment: string | null, now: Date): Promise<void> {
    await this.insertInto(tx, 'csat_ratings', { ticket_id: ticketId, customer_id: customerId, score, comment, rated_at: now, skipped_at: null })
      .onConflict((oc) => oc.columns(['tenant_id', 'ticket_id']).doUpdateSet({ score, comment, rated_at: now, skipped_at: null }))
      .execute();
  }

  /** Records a skip; a ticket that was already rated keeps its rating. */
  async skip(tx: TenantTransaction, ticketId: string, customerId: string, now: Date): Promise<void> {
    await this.insertInto(tx, 'csat_ratings', { ticket_id: ticketId, customer_id: customerId, score: null, comment: null, rated_at: null, skipped_at: now })
      .onConflict((oc) => oc.columns(['tenant_id', 'ticket_id']).doNothing())
      .execute();
  }

  /** Ratings on tickets matching `access` (the caller's view filter), rated since `since` when given. */
  async figure(tx: TenantTransaction, access: Expression<SqlBool>, options: { since?: Date; customerId?: string } = {}): Promise<SatisfactionFigure> {
    let query = this.selectFrom(tx, 'csat_ratings')
      .innerJoin('tickets', (join) => join.onRef('tickets.tenant_id', '=', 'csat_ratings.tenant_id').onRef('tickets.id', '=', 'csat_ratings.ticket_id'))
      .select([sql<string | null>`avg(csat_ratings.score)`.as('average'), sql<string>`count(csat_ratings.score)`.as('responses')])
      .where('csat_ratings.score', 'is not', null)
      .where(access);
    if (options.since !== undefined) query = query.where('csat_ratings.rated_at', '>=', options.since);
    if (options.customerId !== undefined) query = query.where('csat_ratings.customer_id', '=', options.customerId);
    return toFigure(await query.executeTakeFirstOrThrow());
  }
}
