import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../identity/session.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../platform-kernel/db/database.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { Kysely } from 'kysely';

/**
 * Suspending and reactivating a tenant (FR-004, contracts/platform.yaml). Suspension is a switch,
 * never a deletion: the workspace keeps every row and comes back untouched on reactivation.
 *
 * What suspension does:
 * - `tenants.status = 'suspended'` with `suspended_at`. `TenantStatusGuard` then answers 503
 *   `TENANT_SUSPENDED` to every tenant route except the ones marked `@AllowSuspended()`
 *   (customer branding), and staff sign-in stops working.
 * - every session of the tenant is deleted, so nothing survives on a still-open tab;
 * - `tenant.suspended` goes to the outbox, and the gateway disconnects the tenant's sockets;
 * - the tenant's own audit log records it, with the operator as the actor.
 *
 * Status lives in the global `tenants` table, which only `replyx_platform` may update, while the
 * sessions, outbox and audit rows are tenant-owned and go through `replyx_app`. The status flips
 * first: from that moment the guard already refuses requests, so a failure in the second step
 * leaves the tenant closed rather than half-open.
 *
 * "Webhooks and notification sending are paused" needs no flag of its own — their consumers
 * (US11, US15) read `tenants.status`, which is exactly this switch.
 */

export interface SuspensionActor {
  operatorId: string;
  requestId: string;
  ip: string | null;
}

@Injectable()
export class SuspensionService {
  constructor(
    @Inject(PLATFORM_DB) private readonly db: Kysely<Database>,
    private readonly unitOfWork: UnitOfWork,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Idempotent: suspending an already suspended tenant changes nothing and audits nothing. */
  async suspend(ctx: TenantContext, reason?: string): Promise<boolean> {
    const updated = await this.db
      .updateTable('tenants')
      .set({ status: 'suspended', suspended_at: this.clock.now() })
      .where('id', '=', ctx.tenantId)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    if (updated === undefined) return false;

    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const revoked = await new TenantSessionsRepository(ctx).deleteAll(tx);
      await this.sessions.purgeCache(ctx.tenantId, revoked.map((row) => row.id));
      // One control event for the whole tenant: every gateway disconnects its sockets.
      await this.outbox.append(tx, { type: 'tenant.suspended', payload: {}, streams: ['tenant'] });
      await this.audit.record(tx, {
        action: 'tenant.suspended',
        resourceType: 'tenant',
        resourceId: ctx.tenantId,
        details: { sessionsEnded: revoked.length, ...(reason === undefined ? {} : { reason }) },
      });
    });
    return true;
  }

  /** Idempotent, and the mirror image: data was never touched, so there is nothing to restore. */
  async reactivate(ctx: TenantContext): Promise<boolean> {
    const updated = await this.db
      .updateTable('tenants')
      .set({ status: 'active', suspended_at: null })
      .where('id', '=', ctx.tenantId)
      .where('status', '=', 'suspended')
      .returning('id')
      .executeTakeFirst();
    if (updated === undefined) return false;

    await this.unitOfWork.withTenant(ctx, (tx) =>
      this.audit.record(tx, { action: 'tenant.reactivated', resourceType: 'tenant', resourceId: ctx.tenantId }),
    );
    return true;
  }
}

class TenantSessionsRepository extends TenantRepository {
  /** Every session of the tenant, staff and customer alike. */
  deleteAll(tx: TenantTransaction) {
    return this.deleteFrom(tx, 'sessions').returning('id').execute();
  }
}
