import { SetMetadata } from '@nestjs/common';

import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Lets a module seed its own per-tenant defaults when a tenant is created (FR-006): Views adds
 * the default views, Notifications the default preferences. Contributors run inside the
 * provisioning transaction, after the core seed (settings, counters, system roles), so a failure
 * rolls the whole tenant back.
 *
 * Mark the provider class with `@ProvisioningContributor()` and register it in its module; the
 * provisioning service discovers it at start-up.
 */
export interface TenantProvisioningContributor {
  contribute(tx: TenantTransaction, tenant: ProvisionedTenant): Promise<void>;
}

export interface ProvisionedTenant {
  id: string;
  slug: string;
  name: string;
  /** System role ids by `system_key`. */
  roles: Readonly<Record<'admin' | 'manager' | 'agent' | 'customer', string>>;
}

export const PROVISIONING_CONTRIBUTOR = 'replyx:provisioningContributor';

export const ProvisioningContributor = (): ClassDecorator => SetMetadata(PROVISIONING_CONTRIBUTOR, true);
