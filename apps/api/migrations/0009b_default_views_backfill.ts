import { sql, type Kysely } from 'kysely';

/**
 * Backfills the 12 default views (data-model.md "Default view conditions", FR-073) for tenants
 * provisioned before `apps/api/src/views/default-views.contributor.ts` existed. New tenants get
 * them from that contributor at provisioning time; this migration only covers the gap.
 *
 * `views` is tenant-owned with `FORCE ROW LEVEL SECURITY` (0009_tags_views), and this runs as
 * `replyx_owner`, which FORCE applies to too (tenant-scoping rule 10): `app.tenant_id` is set per
 * tenant before each tenant's inserts (`set_config(..., true)`, i.e. `SET LOCAL`, safe to repeat
 * inside one transaction). `ON CONFLICT` on `views_tenant_system_key` makes this safe to run more
 * than once and to run after a tenant already has these views (e.g. a fresh database where this
 * migration still applies after 0009_tags_views created the table).
 *
 * The condition trees are duplicated from `default-views.contributor.ts`, not imported: the
 * migrations build compiles this folder on its own (`rootDir: migrations`) and cannot see `src/`.
 * Both come from data-model.md verbatim — keep them in sync.
 */

interface DefaultView {
  systemKey: string;
  name: string;
  conditions: unknown;
}

const DEFAULT_VIEW_COLUMNS = ['number', 'title', 'customer', 'state', 'priority', 'group', 'owner', 'updated_at'];
const DEFAULT_VIEW_SORT = [{ field: 'updated_at', direction: 'desc' }];

const DEFAULT_VIEWS: readonly DefaultView[] = [
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
    conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: ['new', 'open', 'pending_reminder', 'pending_close'] }] },
  },
  { systemKey: 'new', name: 'New', conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'new' }] } },
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
    conditions: {
      op: 'and',
      items: [
        { field: 'sla_status', operator: 'is', value: ['warning', 'breached'] },
        { field: 'state', operator: 'is_not', value: 'closed' },
      ],
    },
  },
  { systemKey: 'resolved', name: 'Resolved', conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'resolved' }] } },
  { systemKey: 'closed', name: 'Closed', conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'closed' }] } },
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const tenants = await sql<{ id: string }>`SELECT id FROM tenants`.execute(db);
  for (const { id } of tenants.rows) {
    await sql`SELECT set_config('app.tenant_id', ${id}, true)`.execute(db);
    for (let position = 0; position < DEFAULT_VIEWS.length; position += 1) {
      const view = DEFAULT_VIEWS[position]!;
      await sql`
        INSERT INTO views (tenant_id, name, system_key, visibility, conditions, sort, columns, position)
        VALUES (
          ${id}, ${view.name}, ${view.systemKey}, 'all_staff',
          ${JSON.stringify(view.conditions)}::jsonb, ${JSON.stringify(DEFAULT_VIEW_SORT)}::jsonb,
          ${sql.val(DEFAULT_VIEW_COLUMNS)}, ${position}
        )
        ON CONFLICT (tenant_id, system_key) WHERE system_key IS NOT NULL DO NOTHING
      `.execute(db);
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const systemKeys = DEFAULT_VIEWS.map((view) => view.systemKey);
  const tenants = await sql<{ id: string }>`SELECT id FROM tenants`.execute(db);
  for (const { id } of tenants.rows) {
    await sql`SELECT set_config('app.tenant_id', ${id}, true)`.execute(db);
    await sql`DELETE FROM views WHERE system_key = ANY(${sql.val(systemKeys)}::text[])`.execute(db);
  }
}
