import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Kysely } from 'kysely';

import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

import { RetentionService } from './retention.service.js';

/**
 * The daily ticket retention job (T193, research D18): a BullMQ repeatable job at 03:15 UTC that
 * runs `RetentionService.purgeTenant` for every active tenant. A tenant whose purge fails is
 * logged and skipped; the next tenant and the next day's run are unaffected.
 */

export const RETENTION_JOB_NAME = 'retention-purge';
const RETENTION_CRON = '15 3 * * *';

@Injectable()
export class RetentionJob extends JobProcessor implements OnApplicationBootstrap {
  readonly queue = 'retention' as const;
  readonly jobName = RETENTION_JOB_NAME;
  private readonly logger = new Logger('RetentionJob');

  constructor(
    private readonly retention: RetentionService,
    private readonly queues: QueueRegistry,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {
    super();
  }

  /** Schedules the repeatable job; BullMQ dedupes by name + repeat options, safe on every boot. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queues.get(this.queue).add(this.jobName, {}, { jobId: this.jobName, repeat: { pattern: RETENTION_CRON } });
  }

  async process(): Promise<void> {
    const tenants = await this.platformDb.selectFrom('tenants').select('id').where('status', '=', 'active').execute();
    for (const { id: tenantId } of tenants) {
      try {
        await this.retention.purgeTenant(tenantId);
      } catch (error) {
        this.logger.error(`Retention purge failed for tenant ${tenantId}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }
}
