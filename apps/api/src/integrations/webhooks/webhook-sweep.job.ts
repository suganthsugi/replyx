import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { Clock } from '../../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

import { enqueueDelivery, WEBHOOK_DELIVERY_JOB } from './delivery.job.js';
import { WebhooksRepository } from './webhooks.repository.js';

import type { Kysely } from 'kysely';

/**
 * Webhook housekeeping (US18, research D16), every minute, per active tenant:
 *
 * - Recovery: pending attempts more than `GRACE_MS` past due get a delivery job again. That covers
 *   jobs lost before they were queued (or with Redis), workers that died mid-request (the claim's
 *   lease ran out) and attempts held while the tenant was suspended. Duplicate jobs are harmless:
 *   only the one that claims the row sends.
 * - Retention: deliveries older than 30 days are deleted.
 */

const SWEEP_INTERVAL_MS = 60_000;
const GRACE_MS = 2 * 60_000;
const RECOVERY_BATCH = 200;
const PURGE_BATCH = 1_000;
export const DELIVERY_RETENTION_DAYS = 30;

@Injectable()
export class WebhookSweepJob extends JobProcessor implements OnApplicationBootstrap {
  readonly queue = 'webhooks' as const;
  readonly jobName = 'webhook-sweep';
  private readonly logger = new Logger('WebhookSweepJob');

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
        this.logger.error(`Webhook sweep failed for tenant ${id}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  /** One tenant: returns the attempts it queued again and how many old deliveries it deleted. Public so tests sweep their own tenants. */
  async sweepTenant(tenantId: string, now: Date): Promise<{ requeued: string[]; purged: number }> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `webhook-sweep:${uuidv7()}` });
    const repo = new WebhooksRepository(ctx);
    const { requeued, purged } = await this.unitOfWork.withTenant(ctx, async (tx) => ({
      requeued: await repo.overdue(tx, new Date(now.getTime() - GRACE_MS), RECOVERY_BATCH),
      purged: await repo.purgeOlderThan(tx, new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000), PURGE_BATCH),
    }));
    // A fresh job id per sweep: the attempt's original job may still be kept as completed.
    const bucket = Math.floor(now.getTime() / SWEEP_INTERVAL_MS);
    for (const deliveryId of requeued) await enqueueDelivery(this.queues, { tenantId, deliveryId }, { jobId: `${WEBHOOK_DELIVERY_JOB}.${deliveryId}.sweep-${bucket}` });
    return { requeued, purged };
  }
}
