import { beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../../src/audit/audit.service.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/** Smoke test for `GET /audit-logs` (T192); the full suite is T195. */

interface Page {
  items: { id: string; occurredAt: string; actor: { kind: string; id: string | null; name?: string }; action: string; resourceType: string; resourceId: string | null; details: Record<string, unknown> }[];
  nextCursor: string | null;
}

const list = (query: Record<string, string | number>): string =>
  `/audit-logs?${new URLSearchParams(Object.entries(query).map(([key, value]): [string, string] => [key, String(value)])).toString()}`;

const RESOURCE ='0192f3c4-0000-7000-8000-0000000000b1';

async function seed(tenant: TestTenant, actorId: string, count: number): Promise<void> {
  const unitOfWork = await service(UnitOfWork);
  const audit = await service(AuditService);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'audit-smoke' });
  // One transaction: every row shares `occurred_at`, so paging must tie-break on the id.
  await unitOfWork.withTenant(ctx, async (tx) => {
    for (let index = 0; index < count; index += 1) {
      await audit.record(
        tx,
        { action: 'ticket.assigned', resourceType: 'ticket', resourceId: RESOURCE, details: { index } },
        { actor: { kind: 'user', id: actorId } },
      );
    }
    await audit.record(tx, { action: 'retention.purged', resourceType: 'tenant', details: { ticketCount: 3 } });
  });
}

beforeAll(async () => {
  await getTestApp();
});

describe('GET /audit-logs', () => {
  it('lists newest first with filters and a stable cursor, for audit_log.view only', async () => {
    const tenant = await createTenant();
    const [admin, agent] = await Promise.all([createUser(tenant, { roles: ['admin'] }), createUser(tenant, { roles: ['agent'] })]);
    await seed(tenant, admin.id, 5);

    const denied = await asUser(agent).get('/audit-logs');
    expect(denied.status).toBe(403);

    const first = await asUser(admin).get(list({ limit: 2 }));
    expect(first.status).toBe(200);
    const page1 = first.body as Page;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const seen = [...page1.items];
    let cursor = page1.nextCursor;
    while (cursor !== null) {
      const next = (await asUser(admin).get(list({ limit: 2, cursor }))).body as Page;
      seen.push(...next.items);
      cursor = next.nextCursor;
    }
    const ids = seen.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(seen.filter((entry) => entry.action === 'ticket.assigned')).toHaveLength(5);
    expect(seen.map((entry) => entry.occurredAt)).toEqual([...seen.map((entry) => entry.occurredAt)].sort().reverse());

    const filtered = (await asUser(admin).get(list({ actorId: admin.id, action: 'ticket.assigned', resourceType: 'ticket', resourceId: RESOURCE }))).body as Page;
    expect(filtered.items).toHaveLength(5);
    expect(filtered.items[0]).toMatchObject({ actor: { kind: 'user', id: admin.id, name: expect.any(String) as string }, resourceId: RESOURCE });

    const system = (await asUser(admin).get(list({ action: 'retention.purged' }))).body as Page;
    expect(system.items).toEqual([expect.objectContaining({ actor: { kind: 'system', id: null }, resourceId: null, details: { ticketCount: 3 } })]);

    const future = (await asUser(admin).get(list({ from: '2999-01-01T00:00:00Z' }))).body as Page;
    expect(future.items).toEqual([]);

    const bad = await asUser(admin).get(list({ cursor: 'nope' }));
    expect(bad.status).toBe(400);
  });

  it('never shows another tenant its entries', async () => {
    const [one, two] = await Promise.all([createTenant(), createTenant()]);
    const [adminOne, adminTwo] = await Promise.all([createUser(one, { roles: ['admin'] }), createUser(two, { roles: ['admin'] })]);
    await seed(one, adminOne.id, 2);

    const body = (await asUser(adminTwo).get(list({ action: 'ticket.assigned' }))).body as Page;
    expect(body.items).toEqual([]);
  });
});
