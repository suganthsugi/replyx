import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Read access to the tenant settings other modules act on (data-model.md "tenant_settings"). The
 * tenancy module owns the table; messaging and tickets read their settings through this, in
 * their own transaction.
 */

export interface ConversationSettings {
  workspaceName: string;
  /** FR-035: how long a resolved ticket waits before it closes. */
  gracePeriodHours: number;
  /** FR-050: what a message after close does. */
  afterCloseBehavior: 'new_follow_up' | 'reopen_previous';
  /** FR-055: how offline customers hear about replies. */
  offlineCustomerNotification: 'email' | 'off';
}

const DEFAULTS: Omit<ConversationSettings, 'workspaceName'> = {
  gracePeriodHours: 72,
  afterCloseBehavior: 'new_follow_up',
  offlineCustomerNotification: 'email',
};

export class TenantSettingsRepository extends TenantRepository {
  async conversation(tx: TenantTransaction): Promise<ConversationSettings> {
    const row = await this.selectFrom(tx, 'tenant_settings')
      .select(['grace_period_hours', 'after_close_behavior', 'offline_customer_notification'])
      .executeTakeFirst();
    // `tenants` is global and readable by the app role.
    const tenant = await tx.selectFrom('tenants').select(['name', 'slug']).where('id', '=', this.ctx.tenantId).executeTakeFirst();
    return {
      workspaceName: tenant?.name ?? tenant?.slug ?? 'Support',
      gracePeriodHours: row?.grace_period_hours ?? DEFAULTS.gracePeriodHours,
      afterCloseBehavior: row?.after_close_behavior ?? DEFAULTS.afterCloseBehavior,
      offlineCustomerNotification: row?.offline_customer_notification ?? DEFAULTS.offlineCustomerNotification,
    };
  }
}
