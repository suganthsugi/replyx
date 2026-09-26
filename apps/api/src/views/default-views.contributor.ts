import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import {
  ProvisioningContributor,
  type ProvisionedTenant,
  type TenantProvisioningContributor,
} from '../tenancy/provisioning-contributor.js';

import { validateConditions } from './view-compiler.js';

import type { ConditionGroup } from './condition-schema.js';
import type { ViewVisibility } from '../platform-kernel/db/tables/tags-views.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The 12 default views (data-model.md "Default view conditions", FR-073). Every field here is
 * `system_key`, `name` and `conditions` exactly as data-model.md lists them; `columns`/`sort` are
 * this contributor's own reasonable defaults (data-model.md does not specify them). All twelve are
 * `all_staff`, editable, hideable and reorderable; Needs Triage is additionally hidden from
 * viewers without Ungrouped view access — that check lives in `views.service.ts` (read time), not
 * here, since access can change after provisioning.
 *
 * Also embedded (not imported) in `apps/api/migrations/0009b_default_views_backfill.ts`: the
 * migrations build compiles `migrations/` on its own (`rootDir: migrations`), so it cannot import
 * from `src/`. Keep the two definitions in sync; both come from data-model.md verbatim.
 */
export interface DefaultViewDefinition {
  systemKey: string;
  name: string;
  conditions: ConditionGroup;
}

export const DEFAULT_VIEW_COLUMNS = ['number', 'title', 'customer', 'state', 'priority', 'group', 'owner', 'updated_at'] as const;
export const DEFAULT_VIEW_SORT = [{ field: 'updated_at', direction: 'desc' }] as const;
const DEFAULT_VIEW_VISIBILITY: ViewVisibility = 'all_staff';

export const DEFAULT_VIEWS: readonly DefaultViewDefinition[] = [
  {
    systemKey: 'needs_triage',
    name: 'Needs Triage',
    conditions: {
      op: 'and',
      items: [
        { field: 'group', operator: 'is', value: 'ungrouped' },
        { field: 'state', operator: 'is_not', value: 'closed' },
      ],
    },
  },
  {
    systemKey: 'unassigned_open',
    name: 'Unassigned & Open',
    conditions: {
      op: 'and',
      items: [
        { field: 'group', operator: 'is_not', value: 'ungrouped' },
        { field: 'owner', operator: 'is', value: 'unassigned' },
        { field: 'state', operator: 'is_not', value: 'closed' },
      ],
    },
  },
  {
    systemKey: 'my_tickets',
    name: 'My Tickets',
    conditions: {
      op: 'and',
      items: [
        { field: 'owner', operator: 'is', value: 'me' },
        { field: 'state', operator: 'is_not', value: 'closed' },
      ],
    },
  },
  {
    systemKey: 'my_pending_reminders_reached',
    name: 'My Pending Reminders Reached',
    conditions: {
      op: 'and',
      items: [
        { field: 'owner', operator: 'is', value: 'me' },
        { field: 'state', operator: 'is', value: 'pending_reminder' },
        { field: 'pending_until', operator: 'before', value: 'now' },
      ],
    },
  },
  {
    systemKey: 'waiting_on_support',
    name: 'Waiting on Support',
    conditions: {
      op: 'and',
      items: [
        { field: 'waiting_on', operator: 'is', value: 'support' },
        { field: 'state', operator: 'is', value: ['new', 'open'] },
      ],
    },
  },
  {
    systemKey: 'all_open',
    name: 'All Open',
    conditions: {
      op: 'and',
      items: [{ field: 'state', operator: 'is', value: ['new', 'open', 'pending_reminder', 'pending_close'] }],
    },
  },
  {
    systemKey: 'new',
    name: 'New',
    conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'new' }] },
  },
  {
    systemKey: 'pending',
    name: 'Pending',
    conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: ['pending_reminder', 'pending_close'] }] },
  },
  {
    systemKey: 'high_urgent',
    name: 'High & Urgent',
    conditions: {
      op: 'and',
      items: [
        { field: 'priority', operator: 'is', value: ['high', 'urgent'] },
        { field: 'state', operator: 'is_not', value: 'closed' },
      ],
    },
  },
  {
    systemKey: 'escalated',
    name: 'Escalated',
    // Matches nothing until US12 gives tickets an `sla_status` (data-model.md "views").
    conditions: {
      op: 'and',
      items: [
        { field: 'sla_status', operator: 'is', value: ['warning', 'breached'] },
        { field: 'state', operator: 'is_not', value: 'closed' },
      ],
    },
  },
  {
    systemKey: 'resolved',
    name: 'Resolved',
    conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'resolved' }] },
  },
  {
    systemKey: 'closed',
    name: 'Closed',
    conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'closed' }] },
  },
];

// Fails loudly at start-up (module load) if a definition ever drifts from the whitelist.
for (const view of DEFAULT_VIEWS) validateConditions(view.conditions);

function scopeOf(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('Default views must be seeded inside withTenant');
  return ctx;
}

class DefaultViewsRepository extends TenantRepository {
  insertAll(tx: TenantTransaction) {
    return this.insertInto(
      tx,
      'views',
      DEFAULT_VIEWS.map((view, index) => ({
        name: view.name,
        description: null,
        system_key: view.systemKey,
        owner_id: null,
        visibility: DEFAULT_VIEW_VISIBILITY,
        shared_role_ids: [],
        shared_group_ids: [],
        // jsonb columns: `pg` sends a JS object's `.toString()`, not its JSON encoding, unless the
        // value is already a JSON string (audit.service.ts, ticket-history.service.ts).
        conditions: JSON.stringify(view.conditions),
        sort: JSON.stringify(DEFAULT_VIEW_SORT),
        columns: [...DEFAULT_VIEW_COLUMNS],
        position: index,
        hidden: false,
      })),
    ).execute();
  }
}

/** Seeds the 12 default views for a newly provisioned tenant (FR-006, FR-073). */
@Injectable()
@ProvisioningContributor()
export class DefaultViewsContributor implements TenantProvisioningContributor {
  async contribute(tx: TenantTransaction, _tenant: ProvisionedTenant): Promise<void> {
    await new DefaultViewsRepository(scopeOf(tx)).insertAll(tx);
  }
}
