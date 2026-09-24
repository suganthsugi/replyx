import { sql } from 'kysely';

import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

/**
 * Invalidates every cached effective access of a tenant at once (research D6): increments
 * `tenants.access_version` in the caller's transaction and appends `access.changed` to the
 * tenant stream, so the gateway recomputes connected users' rooms after commit (FR-025).
 *
 * Call it in the same transaction as every change to roles, role permissions, group access,
 * user roles or user status. Returns the new version.
 */
export async function bumpAccessVersion(
  tx: TenantTransaction,
  tenantId: string,
  reason: string,
  outbox: OutboxService = defaultOutbox,
): Promise<string> {
  const scope = tenantScopeOf(tx);
  if (scope === undefined) throw new Error('bumpAccessVersion must run inside withTenant');
  if (scope.tenantId !== tenantId.toLowerCase()) {
    throw new Error('bumpAccessVersion tenant does not match the transaction');
  }

  // `tenants` is global; the app role may update only access_version and updated_at (P2-2).
  const row = await tx
    .updateTable('tenants')
    .set({ access_version: sql`access_version + 1`, updated_at: sql`now()` })
    .where('id', '=', scope.tenantId)
    .returning('access_version')
    .executeTakeFirstOrThrow();
  const accessVersion = String(row.access_version);

  await outbox.append(tx, { type: 'access.changed', payload: { accessVersion, reason }, streams: ['tenant'] });
  return accessVersion;
}

const defaultOutbox = new OutboxService();
