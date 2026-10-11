import { Injectable } from '@nestjs/common';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';

import { CsatRepository } from './csat.repository.js';
import { ratingOfferId } from './rating-offer.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Customer satisfaction ratings (FR-087, spec US16, contracts/customer.yaml `/customer/ratings/{id}`).
 *
 * - **Offer** (`pendingRating` in `GET /customer/conversation`): the customer's most recently
 *   resolved conversation while it is still in its grace period (state `resolved`, not merged),
 *   when nothing newer is active and it was neither rated nor skipped.
 * - **Rate**: score 1–5 and an optional comment on any of the customer's own resolved or closed
 *   tickets; rating again changes it (one rating per ticket). **Skip** records that the customer
 *   declined, so the offer is not shown again; a rated ticket keeps its rating.
 * - An id that is not one of the caller's own rateable tickets is 404, like any unknown id.
 */

export type RatingInput = { score: number; comment?: string } | { skip: true };

@Injectable()
export class SatisfactionService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** The offer to show in the chat, or `null` (call inside the conversation's transaction). */
  async pendingRating(ctx: TenantContext, tx: TenantTransaction, customerId: string): Promise<{ ratingId: string } | null> {
    const latest = await new RateableTickets(ctx).latest(tx, customerId);
    if (latest?.state !== 'resolved') return null;
    if ((await new CsatRepository(ctx).state(tx, latest.id)) !== undefined) return null;
    return { ratingId: ratingOfferId(ctx.tenantId, latest.id) };
  }

  rate(ctx: TenantContext, customerId: string, ratingId: string, input: RatingInput): Promise<void> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const tickets = await new RateableTickets(ctx).resolvedOrClosed(tx, customerId);
      const ticket = tickets.find((candidate) => ratingOfferId(ctx.tenantId, candidate.id) === ratingId);
      if (ticket === undefined) throw notFound('rating');
      const repo = new CsatRepository(ctx);
      if ('skip' in input) await repo.skip(tx, ticket.id, customerId, this.clock.now());
      else await repo.rate(tx, ticket.id, customerId, input.score, input.comment ?? null, this.clock.now());
    });
  }
}

class RateableTickets extends TenantRepository {
  /** The customer's most recently updated ticket that is not merged into another. */
  latest(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.state'])
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.merged_into_id', 'is', null)
      .orderBy('tickets.updated_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  resolvedOrClosed(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['tickets.id'])
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.merged_into_id', 'is', null)
      .where('tickets.state', 'in', ['resolved', 'closed'])
      .execute();
  }
}
