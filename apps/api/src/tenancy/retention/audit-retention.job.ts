import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Kysely } from 'kysely';

import { AuditService } from '../../audit/audit.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

import { periodYears, retentionCutoff } from './retention-period.js';
import { RetentionRepository } from './retention.repository.js';

/**
 * The daily audit-log retention job (T193, FR-005a, research D18). `audit_logs` is append-only for
 * `replyx_app`, so entries older than a tenant's `audit_retention` are deleted through the
 * dedicated `replyx_retention` role (`DATABASE_URL_RETENTION`, migration 0012: SELECT and DELETE on
 * `audit_logs` and nothing else). That role is still under forced row-level security, so each
 * delete runs in a tenant transaction like every other tenant query.
 *
 * `audit_retention` is at least one year (`P1Y`) or `forever`; anything else is skipped here even
 * if the database check were ever loosened. Without `DATABASE_URL_RETENTION` the job does nothing
 * and says so in the log.
 */

export const AUDIT_RETENTION_JOB_NAME = 'audit-retention-purge';
const AUDIT_RETENTION_CRON = '45 3 * * *';
const DELETE_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 500;

/** The `replyx_retention` unit of work; `undefined` when the role is not configured. */
export const RETENTION_UNIT_OF_WORK = Symbol('RETENTION_UNIT_OF_WORK');

class AuditRetentionRepository extends TenantRepository {
  /** Deletes up to `limit` entries older than `cutoff`; returns how many. */
  async deleteOlderThan(tx: TenantTransaction, cutoff: Date, limit: number): Promise<number> {
    const result = await this.deleteFrom(tx, 'audit_logs')
      .where('audit_logs.id', 'in', (eb) =>
        eb
          .selectFrom('audit_logs as expired')
          .select('expired.id')
          .where('expired.tenant_id', '=', this.ctx.tenantId)
          .where('expired.occurred_at', '<', cutoff)
          .orderBy('expired.occurred_at')
          .limit(limit),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

@Injectable()
export class AuditRetentionJob extends JobProcessor implements OnApplicationBootstrap {
  readonly queue = 'retention' as const;
  readonly jobName = AUDIT_RETENTION_JOB_NAME;
  private readonly logger = new Logger('AuditRetentionJob');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(RETENTION_UNIT_OF_WORK) private readonly retentionUnitOfWork: UnitOfWork | undefined,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly queues: QueueRegistry,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues.get(this.queue).add(this.jobName, {}, { jobId: this.jobName, repeat: { pattern: AUDIT_RETENTION_CRON } });
  }

  async process(): Promise<void> {
    if (this.retentionUnitOfWork === undefined) {
      this.logger.warn('DATABASE_URL_RETENTION is not set: audit log retention is not enforced');
      return;
    }
    const tenants = await this.platformDb.selectFrom('tenants').select('id').where('status', '=', 'active').execute();
    for (const { id: tenantId } of tenants) {
      try {
        await this.purgeTenant(this.retentionUnitOfWork, tenantId);
      } catch (error) {
        this.logger.error(`Audit retention failed for tenant ${tenantId}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  /** Returns how many entries were deleted. */
  async purgeTenant(retentionUnitOfWork: UnitOfWork, tenantId: string): Promise<number> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `audit-retention:${uuidv7()}` });
    const { auditRetention } = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new RetentionRepository(ctx).settings(tx));
    const years = periodYears(auditRetention);
    if (years === null) return 0; // `forever`, or not a whole-year duration
    const cutoff = retentionCutoff(this.clock.now(), auditRetention);
    if (cutoff === null) return 0;

    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const count = await retentionUnitOfWork.withTenant(ctx, (tx) =>
        new AuditRetentionRepository(ctx).deleteOlderThan(tx, cutoff, DELETE_BATCH_SIZE),
      );
      deleted += count;
      if (count < DELETE_BATCH_SIZE) break;
    }
    if (deleted > 0) {
      // Counts only.
      await this.unitOfWork.withTenant(ctx, (tx) =>
        this.audit.record(tx, {
          action: 'audit_log.purged',
          resourceType: 'audit_log',
          details: { auditRetention, olderThan: cutoff.toISOString(), entryCount: deleted },
        }),
      );
    }
    return deleted;
  }
}
