import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import {
  ProvisioningContributor,
  type ProvisionedTenant,
  type TenantProvisioningContributor,
} from '../tenancy/provisioning-contributor.js';

import { BUILT_IN_DEFAULTS } from './notification-preferences.js';

/**
 * Seeds a new tenant's notification defaults (FR-080, T163): every event and channel spelled out
 * in `tenant_settings.notification_defaults`, so admins later edit concrete values. Tenants
 * created before this ran keep `{}`, which resolves to the same built-in defaults.
 */

class NotificationDefaultsRepository extends TenantRepository {
  async write(tx: TenantTransaction): Promise<void> {
    // jsonb: JSON text, not an object (default-views.contributor.ts).
    await this.updateTable(tx, 'tenant_settings').set({ notification_defaults: JSON.stringify(BUILT_IN_DEFAULTS) }).execute();
  }
}

@Injectable()
@ProvisioningContributor()
export class NotificationDefaultsContributor implements TenantProvisioningContributor {
  async contribute(tx: TenantTransaction, _tenant: ProvisionedTenant): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('Notification defaults must be seeded inside withTenant');
    await new NotificationDefaultsRepository(ctx).write(tx);
  }
}
