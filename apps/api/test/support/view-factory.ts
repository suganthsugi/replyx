import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository, type TenantInsert } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';

import { service } from './app.js';

import type { TestTenant } from './factories.js';
import type { ViewVisibility } from '../../src/platform-kernel/db/tables/tags-views.js';
import type { ConditionGroup } from '../../src/views/condition-schema.js';

/**
 * A view row inserted directly (no create-view endpoint yet, T148/T141): used to test read-path
 * visibility scoping (`personal`/`roles`/`groups`) that the 12 (`all_staff`) default views alone
 * cannot exercise.
 */

function systemContext(tenant: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-view-factory' });
}

class ViewFactoryRepository extends TenantRepository {
  async insertView(tx: TenantTransaction, values: TenantInsert<'views'>): Promise<string> {
    const row = await this.insertInto(tx, 'views', values).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }
}

export interface TestView {
  id: string;
  tenant: TestTenant;
}

const DEFAULT_CONDITIONS: ConditionGroup = { op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }] };

export async function createView(
  tenant: TestTenant,
  options: {
    name?: string;
    visibility?: ViewVisibility;
    ownerId?: string | null;
    sharedRoleIds?: string[];
    sharedGroupIds?: string[];
    conditions?: ConditionGroup;
    position?: number;
    hidden?: boolean;
  } = {},
): Promise<TestView> {
  const ctx = systemContext(tenant);
  const unitOfWork = await service(UnitOfWork);
  const repo = new ViewFactoryRepository(ctx);
  const id = await unitOfWork.withTenant(ctx, (tx) =>
    repo.insertView(tx, {
      name: options.name ?? `View ${Math.random().toString(36).slice(2)}`,
      description: null,
      system_key: null,
      owner_id: options.ownerId ?? null,
      visibility: options.visibility ?? 'all_staff',
      shared_role_ids: options.sharedRoleIds ?? [],
      shared_group_ids: options.sharedGroupIds ?? [],
      // jsonb columns: `pg` sends `.toString()` unless the value is already a JSON string
      // (default-views.contributor.ts, audit.service.ts).
      conditions: JSON.stringify(options.conditions ?? DEFAULT_CONDITIONS),
      sort: JSON.stringify([{ field: 'updated_at', direction: 'desc' }]),
      columns: ['number', 'title', 'state'],
      position: options.position ?? 1000,
      hidden: options.hidden ?? false,
    }),
  );
  return { id, tenant };
}
