import { Inject, Injectable, Logger } from '@nestjs/common';

import { FILE_STORAGE, type FileStorage } from '../../attachments/storage/file-storage.js';
import { AuditService } from '../../audit/audit.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { AppError } from '../../platform-kernel/http/app-error.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';

import { retentionCutoff } from './retention-period.js';
import { RetentionRepository, type BatchCounts } from './retention.repository.js';

/**
 * The ticket retention purge (T193, FR-005a, research D18). Closed tickets whose closure is older
 * than the tenant's `retention_period` are hard-deleted in batches of 500, each batch in its own
 * transaction: the messages, attachments (rows and stored files), history, tags and links go with
 * them. A link from a surviving ticket becomes a tombstone (`removed_reason = 'retention'`).
 *
 * Search entries and the customer's thread need no separate cleanup: both are read from the rows
 * deleted here (`tickets.title` / `ticket_messages.body` GIN indexes, `ticket_messages` for the
 * conversation), so they disappear with the transaction.
 *
 * Files are deleted before the rows of their batch: a crash in between leaves rows without files
 * (the next run deletes them, a missing file is not an error) instead of files no row points to.
 */

export const PURGE_BATCH_SIZE = 500;
/** A run stops after this many batches (100,000 tickets) and continues the next day. */
const MAX_BATCHES_PER_RUN = 200;

export interface PurgeCounts extends BatchCounts {
  tickets: number;
  files: number;
}

const EMPTY: PurgeCounts = { tickets: 0, messages: 0, attachments: 0, files: 0, history: 0, links: 0, tags: 0 };

@Injectable()
export class RetentionService {
  private readonly logger = new Logger('RetentionService');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** How many tickets a `retentionPeriod` would purge right now (the number an admin confirms). */
  async countPurgeable(tx: TenantTransaction, period: string): Promise<number> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('RetentionService.countPurgeable must run inside withTenant');
    const cutoff = retentionCutoff(this.clock.now(), period);
    return cutoff === null ? 0 : new RetentionRepository(ctx).countPurgeable(tx, cutoff);
  }

  /** How many audit entries an `auditRetention` would delete at the next audit purge (the number an admin confirms). */
  async countPurgeableAudit(tx: TenantTransaction, period: string): Promise<number> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('RetentionService.countPurgeableAudit must run inside withTenant');
    const cutoff = retentionCutoff(this.clock.now(), period);
    return cutoff === null ? 0 : new RetentionRepository(ctx).countAuditOlderThan(tx, cutoff);
  }

  /** One tenant's daily run. Returns what was purged; writes one audit entry when anything was. */
  async purgeTenant(tenantId: string): Promise<PurgeCounts> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `retention:${uuidv7()}` });
    const { retentionPeriod } = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new RetentionRepository(ctx).settings(tx));
    const cutoff = retentionCutoff(this.clock.now(), retentionPeriod);
    if (cutoff === null) return { ...EMPTY };

    const total: PurgeCounts = { ...EMPTY };
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
        const purged = await this.unitOfWork.withTenant(ctx, (tx) => this.purgeBatch(ctx, tx, cutoff));
        if (purged === undefined) break;
        for (const key of Object.keys(total) as (keyof PurgeCounts)[]) total[key] += purged[key];
      }
    } finally {
      // Counts only, even for a run that failed part-way: what was deleted is on record.
      if (total.tickets > 0) await this.recordPurge(ctx, retentionPeriod, cutoff, total);
    }
    return total;
  }

  private async purgeBatch(ctx: TenantContext, tx: TenantTransaction, cutoff: Date): Promise<PurgeCounts | undefined> {
    const repo = new RetentionRepository(ctx);
    const batch = await repo.lockBatch(tx, cutoff, PURGE_BATCH_SIZE);
    if (batch.length === 0) return undefined;
    const ids = batch.map((candidate) => candidate.id);

    const related = await repo.countRelated(tx, ids);
    const attachmentIds = await repo.attachmentIds(tx, ids);
    for (const attachmentId of attachmentIds) {
      await this.storage.delete({ tenantId: ctx.tenantId, attachmentId, area: 'files' });
      await this.storage.delete({ tenantId: ctx.tenantId, attachmentId, area: 'quarantine' });
    }
    await repo.retireLinks(tx, ids);
    await repo.deleteTickets(tx, ids);

    // Persist before publish: list views drop the ticket, no content in the event.
    for (const candidate of batch) {
      await this.outbox.append(tx, {
        type: 'ticket.removed_from_view',
        payload: { ticketId: candidate.id, reason: 'deleted' },
        streams: [`ticket:${candidate.id}`, `tickets:group:${candidate.groupId ?? 'ungrouped'}`],
      });
    }
    return { ...related, tickets: batch.length, files: attachmentIds.length };
  }

  private async recordPurge(ctx: TenantContext, period: string, cutoff: Date, counts: PurgeCounts): Promise<void> {
    try {
      await this.unitOfWork.withTenant(ctx, (tx) =>
        this.audit.record(tx, {
          action: 'retention.purged',
          resourceType: 'tenant_settings',
          resourceId: ctx.tenantId,
          // sanitizeDetails drops keys named messages/body/text/content, hence the *Count names.
          details: {
            retentionPeriod: period,
            closedBefore: cutoff.toISOString(),
            ticketCount: counts.tickets,
            messageCount: counts.messages,
            attachmentCount: counts.attachments,
            fileCount: counts.files,
            historyEntryCount: counts.history,
            linkCount: counts.links,
            tagCount: counts.tags,
          },
        }),
      );
    } catch (error) {
      this.logger.error(`Retention audit entry failed for tenant ${ctx.tenantId}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

/**
 * 409 for a settings change that would delete closed tickets (FR-005a): the admin confirms by
 * resending `confirmPurgeCount` equal to `purgeCount`, the number the response carries.
 */
export function retentionConfirmationRequired(purgeCount: number): AppError {
  return new AppError(
    'RETENTION_CONFIRMATION_REQUIRED',
    409,
    'Shortening the retention period deletes closed tickets. Confirm the number of tickets that will be deleted.',
    [{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount }],
  );
}

/**
 * 409 for a settings change that would irreversibly delete audit entries (FR-005a): the admin
 * confirms by resending `confirmAuditPurgeCount` equal to `purgeCount`, the number the response carries.
 */
export function auditRetentionConfirmationRequired(purgeCount: number): AppError {
  return new AppError(
    'AUDIT_RETENTION_CONFIRMATION_REQUIRED',
    409,
    'Shortening the audit retention deletes audit log entries. Confirm the number of entries that will be deleted.',
    [{ path: 'confirmAuditPurgeCount', issue: 'confirmation_required', purgeCount }],
  );
}
