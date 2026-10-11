import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Duration } from 'luxon';

import { Clock } from '../../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

import { AutomationMatchRepository, enqueueRun, type AutomationRunJobData } from './automation-engine.js';
import { AutomationRulesRepository } from './automation-rules.repository.js';

import type { Kysely } from 'kysely';

/**
 * The time side of automation rules (T254, FR-088): a repeatable job every minute that, per active
 * tenant and enabled `time.elapsed` rule, finds tickets whose `since` timestamp is at least `after`
 * old, that match the conditions and have no run for that waiting period, and queues a run for
 * each. The run key is the waiting period (`since:<timestamp>`), so a rule runs once per period
 * however often the sweep sees it; new activity on the ticket starts a new period.
 */

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_SIZE = 200;

@Injectable()
export class AutomationSweepJob extends JobProcessor implements OnApplicationBootstrap {
  readonly queue = 'automation' as const;
  readonly jobName = 'automation-time-sweep';
  private readonly logger = new Logger('AutomationSweepJob');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {
    super();
  }

  /** Schedules the repeatable job; BullMQ dedupes by name + repeat options, safe on every boot. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queues.get(this.queue).add(this.jobName, {}, { jobId: this.jobName, repeat: { every: SWEEP_INTERVAL_MS } });
  }

  async process(): Promise<void> {
    const now = this.clock.now();
    const tenants = await this.platformDb.selectFrom('tenants').select('id').where('status', '=', 'active').execute();
    for (const { id } of tenants) {
      try {
        await this.sweepTenant(id, now);
      } catch (error) {
        this.logger.error(`Automation sweep failed for tenant ${id}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  /** One tenant's due time rules; returns the runs it queued. Public so tests sweep their own tenants. */
  async sweepTenant(tenantId: string, now: Date): Promise<AutomationRunJobData[]> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `automation-sweep:${uuidv7()}` });
    const due = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const rules = await new AutomationRulesRepository(ctx).enabledFor(tx, 'time.elapsed');
      const match = new AutomationMatchRepository(ctx);
      const runs: AutomationRunJobData[] = [];
      for (const rule of rules) {
        const { after, since } = rule.trigger;
        if (after === undefined || since === undefined) continue;
        const wait = Duration.fromISO(after);
        if (!wait.isValid) continue;
        const cutoff = new Date(now.getTime() - wait.toMillis());
        for (const ticket of await match.dueForTime(tx, { id: rule.id, since, conditions: rule.conditions }, cutoff, now, BATCH_SIZE)) {
          runs.push({ tenantId, ruleId: rule.id, ticketId: ticket.id, triggerKey: ticket.triggerKey, depth: 1, eventId: null });
        }
      }
      return runs;
    });
    for (const run of due) await enqueueRun(this.queues, run);
    return due;
  }
}
