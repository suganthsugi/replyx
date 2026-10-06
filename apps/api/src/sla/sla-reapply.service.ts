import { Injectable, Logger } from '@nestjs/common';

import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';

import { SlaAdminRepository } from './sla-admin.repository.js';
import { SlaRecomputeService } from './sla-recompute.service.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/** Tickets recomputed per transaction (each recompute holds an advisory lock until commit). */
export const REAPPLY_PAGE_SIZE = 100;

/**
 * Re-applies the SLA configuration to open tickets after a policy or business-hours change
 * (T224, research D15): every open ticket is recomputed with `reset: true`, so it picks up the
 * (possibly different) first matching policy and the edited calendar.
 *
 * It runs AFTER the configuration write has committed, in pages of `REAPPLY_PAGE_SIZE` tickets,
 * one transaction per page: `SlaRecomputeService.recompute` takes a transaction-scoped advisory
 * lock per ticket, so one transaction over thousands of tickets would exhaust Postgres' lock
 * table. A failed page is logged and skipped; the rest still run, and any ticket it left behind
 * converges at its next event (the SLA consumer recomputes from current facts). Never throws.
 */
@Injectable()
export class SlaReapplyService {
  private readonly logger = new Logger('SlaReapplyService');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly recompute: SlaRecomputeService,
  ) {}

  async reapplyToOpenTickets(ctx: TenantContext): Promise<void> {
    let afterId: string | undefined;
    for (;;) {
      let ids: string[];
      try {
        ids = await this.unitOfWork.withTenant(ctx, async (tx) => {
          const page = await new SlaAdminRepository(ctx).openTicketIds(tx, afterId, REAPPLY_PAGE_SIZE);
          for (const ticketId of page) await this.recompute.recompute(tx, ticketId, { reset: true });
          return page;
        });
      } catch (error) {
        // Keep going from the next page: ids are ordered, so skip past this page by reading it again
        // without recomputing (a failure of the read itself ends the run).
        this.logger.error(`SLA re-apply failed for a page of tickets after ${afterId ?? 'the start'}: ${error instanceof Error ? error.message : 'unknown error'}`);
        const skipped = await this.skipPage(ctx, afterId);
        if (skipped === undefined) return;
        ids = skipped;
      }
      const last = ids[ids.length - 1];
      if (last === undefined || ids.length < REAPPLY_PAGE_SIZE) return;
      afterId = last;
    }
  }

  private async skipPage(ctx: TenantContext, afterId: string | undefined): Promise<string[] | undefined> {
    try {
      return await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new SlaAdminRepository(ctx).openTicketIds(tx, afterId, REAPPLY_PAGE_SIZE));
    } catch {
      return undefined;
    }
  }
}
