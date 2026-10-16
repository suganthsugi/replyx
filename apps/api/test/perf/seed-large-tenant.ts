import { sql } from 'kysely';

import { createDatabase } from '../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../src/platform-kernel/db/unit-of-work.js';
import { service } from '../support/app.js';
import { createGroup, type TestGroup, type TestTenant } from '../support/factories.js';

/**
 * A tenant at the plan's scale (plan.md "Scale/Scope": ~200 staff, ~100k tickets a year), for the
 * performance check (T266). Rows go in with set-based SQL in the tenant's own transaction (RLS
 * applies), not through the services: no events, history or notifications, just the data the read
 * paths query. Ticket states carry the timer columns their checks need; the ticket counter is moved
 * past the seeded numbers so new tickets still get fresh ones.
 */

export interface LargeTenantOptions {
  tickets?: number;
  staff?: number;
  customers?: number;
  groups?: number;
  messagesPerTicket?: number;
}

export interface LargeTenant {
  groups: TestGroup[];
  tickets: number;
  messages: number;
}

export async function seedLargeTenant(tenant: TestTenant, options: LargeTenantOptions = {}): Promise<LargeTenant> {
  const tickets = options.tickets ?? 100_000;
  const staff = options.staff ?? 200;
  const customers = options.customers ?? 20_000;
  const messagesPerTicket = options.messagesPerTicket ?? 3;
  const groups: TestGroup[] = [];
  for (let index = 0; index < (options.groups ?? 8); index += 1) groups.push(await createGroup(tenant, { name: `Perf group ${index + 1}` }));
  const groupIds = groups.map((group) => group.id);

  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'perf-seed' });
  await (await service(UnitOfWork)).withTenant(ctx, async (tx) => {
    const t = tenant.id;
    await sql`
      INSERT INTO users (tenant_id, email, name, kind, status)
      SELECT ${t}, 'perf-staff-' || n || '@perf.test', 'Perf Staff ' || n, 'staff', 'active' FROM generate_series(1, ${staff}) AS n
    `.execute(tx);
    await sql`
      INSERT INTO users (tenant_id, email, name, kind, status)
      SELECT ${t}, 'perf-customer-' || n || '@perf.test', 'Perf Customer ' || n, 'customer', 'active' FROM generate_series(1, ${customers}) AS n
    `.execute(tx);
    // Ordered arrays to pick from by index (the app role can't create temp tables).
    const ids = async (prefix: string) =>
      (await sql<{ id: string }>`SELECT id FROM users WHERE tenant_id = ${t} AND email LIKE ${prefix} ORDER BY email`.execute(tx)).rows.map((row) => row.id);
    const people = sql`(SELECT ${sql.val(await ids('perf-staff-%'))}::uuid[] AS staff, ${sql.val(await ids('perf-customer-%'))}::uuid[] AS customers, ${sql.val(groupIds)}::uuid[] AS groups)`;
    // About a year of tickets: spread over 365 days; a tenth ungrouped, a third unassigned.
    await sql`
      INSERT INTO tickets (
        tenant_id, number, title, customer_id, group_id, owner_id, priority, state, origin, waiting_on,
        pending_until, resolved_at, auto_close_at, closed_at, last_customer_message_at, last_agent_reply_at, created_at, updated_at
      )
      SELECT ${t}, n, 'Order ' || (100000 + n) || ' ' || (ARRAY['has not arrived', 'refund request', 'wrong size', 'billing question', 'login problem'])[1 + n % 5],
        p.customers[1 + n % array_length(p.customers, 1)],
        CASE WHEN n % 10 = 0 THEN NULL ELSE p.groups[1 + n % array_length(p.groups, 1)] END,
        CASE WHEN n % 3 = 0 THEN NULL ELSE p.staff[1 + n % array_length(p.staff, 1)] END,
        (ARRAY['low', 'normal', 'normal', 'high', 'urgent'])[1 + n % 5],
        s.state, 'customer_message', CASE WHEN n % 2 = 0 THEN 'support' ELSE 'customer' END,
        CASE WHEN s.state IN ('pending_reminder', 'pending_close') THEN c.created + interval '3 days' END,
        CASE WHEN s.state IN ('resolved', 'closed') THEN c.created + interval '1 day' END,
        CASE WHEN s.state = 'resolved' THEN c.created + interval '4 days' END,
        CASE WHEN s.state = 'closed' THEN c.created + interval '4 days' END,
        c.created, c.created + interval '2 hours', c.created, c.created + interval '2 hours'
      FROM generate_series(1, ${tickets}) AS n
      CROSS JOIN ${people} AS p
      CROSS JOIN LATERAL (SELECT now() - (n % 365) * interval '1 day' - (n % 1440) * interval '1 minute' AS created) AS c
      CROSS JOIN LATERAL (
        SELECT (ARRAY['closed', 'closed', 'closed', 'closed', 'closed', 'resolved', 'open', 'open', 'new', 'pending_reminder', 'pending_close'])[1 + n % 11] AS state
      ) AS s
    `.execute(tx);
    await sql`
      INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, author_kind, visibility, body, created_at, updated_at)
      SELECT ${t}, tk.id,
        CASE WHEN m % 2 = 1 THEN tk.customer_id ELSE p.staff[1 + tk.number % array_length(p.staff, 1)] END,
        CASE WHEN m % 2 = 1 THEN 'customer' ELSE 'staff' END,
        CASE WHEN m = 2 AND tk.number % 4 = 0 THEN 'internal' ELSE 'public' END,
        'Message ' || m || ' about order ' || (100000 + tk.number) || ': my parcel is late and the tracking page shows nothing new',
        tk.created_at + m * interval '1 hour', tk.created_at + m * interval '1 hour'
      FROM tickets AS tk
      CROSS JOIN ${people} AS p
      CROSS JOIN generate_series(1, ${messagesPerTicket}) AS m
      WHERE tk.tenant_id = ${t}
    `.execute(tx);
    await sql`UPDATE tenant_counters SET value = ${tickets} WHERE tenant_id = ${t} AND name = 'ticket_number'`.execute(tx);
  });
  // Fresh planner statistics, as autovacuum would have after a year of normal growth. Only the
  // table owner may ANALYZE.
  const owner = createDatabase(process.env.DATABASE_URL_OWNER as string, 'retention');
  try {
    await sql`ANALYZE tickets, ticket_messages, users`.execute(owner);
  } finally {
    await owner.destroy();
  }
  return { groups, tickets, messages: tickets * messagesPerTicket };
}
