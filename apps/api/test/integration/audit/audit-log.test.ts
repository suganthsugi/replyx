import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditConsumer } from '../../../src/audit/audit.consumer.js';
import { createDatabase, type Database } from '../../../src/platform-kernel/db/database.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, getTestWorker } from '../../support/app.js';
import { createGroup, createRole, createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asOperator, asSupport, asUser } from '../../support/http.js';
import { latestEventId } from '../../support/jobs.js';

/**
 * The audit log (T195; audit/*.ts, FR-092): every audited action shows up in `GET /audit-logs`
 * with actor, action, resource, time and details, never with a message body; the log is append-only
 * for the app role and cannot be changed by the retention role. The smoke test
 * (audit-logs.smoke.test.ts) covers paging and cross-tenant emptiness; this file covers the
 * actions themselves.
 */

interface Entry {
  id: string;
  occurredAt: string;
  actor: { kind: string; id: string | null; name?: string };
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
}
interface Page {
  items: Entry[];
  nextCursor: string | null;
}

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const query = (filters: Record<string, string | number>): string =>
  `/audit-logs?${new URLSearchParams(Object.entries(filters).map(([key, value]): [string, string] => [key, String(value)])).toString()}`;

/** Every entry matching the filters, all pages, newest first. */
async function entries(admin: TestUser, filters: Record<string, string> = {}): Promise<Entry[]> {
  const all: Entry[] = [];
  let cursor: string | null = null;
  do {
    const response = await asUser(admin).get(query({ limit: 100, ...filters, ...(cursor === null ? {} : { cursor }) }));
    expect(response.status).toBe(200);
    const page = response.body as Page;
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

const actionsOf = (rows: Entry[]): string[] => rows.map((row) => row.action);

let appDb: Kysely<Database>;
let retentionDb: Kysely<Database>;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  appDb = createDatabase(process.env.DATABASE_URL_APP as string, 'app');
  retentionDb = createDatabase(process.env.DATABASE_URL_RETENTION as string, 'app');
});

afterAll(async () => {
  await Promise.all([appDb.destroy(), retentionDb.destroy()]);
});

describe('ticket lifecycle entries (audit consumer)', () => {
  const BODY_TEXT = 'Secret-customer-body-7f3a';
  const REPLY_TEXT = 'Public-reply-text-91bc';
  const NOTE_TEXT = 'Internal-note-text-c40d';
  const TITLE = 'Ticket-title-5e21';

  let tenant: TestTenant;
  let admin: TestUser;
  let agent: TestUser;
  let other: TestUser;
  let ticketId: string;
  let groupOne: string;
  let groupTwo: string;

  beforeAll(async () => {
    tenant = await createTenant();
    [admin, agent, other] = await Promise.all([
      createUser(tenant, { roles: ['admin'] }),
      createUser(tenant, { roles: ['agent'] }),
      createUser(tenant, { roles: ['agent'] }),
    ]);
    const customer = await createUser(tenant, { roles: ['customer'] });
    [groupOne, groupTwo] = (await Promise.all([1, 2].map(() => createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: true } }] })))).map((group) => group.id) as [string, string];

    const created = await asUser(admin).post('/tickets', { customerId: customer.id, groupId: groupOne, title: TITLE, message: { body: BODY_TEXT } });
    expect(created.status).toBe(201);
    ticketId = (created.body as { id: string }).id;
    const initialState = (created.body as { state: string }).state;

    const changes = [
      { priority: 'high' },
      { groupId: groupTwo },
      { state: initialState === 'resolved' ? 'open' : 'resolved' },
      { ownerId: agent.id },
      { ownerId: other.id },
    ];
    for (const change of changes) {
      const response = await asUser(admin).patch(`/tickets/${ticketId}`, change);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect((await asUser(admin).post(`/tickets/${ticketId}/messages`, { visibility: 'public', body: REPLY_TEXT, clientMessageId: uuidv7() })).status).toBe(201);
    expect((await asUser(admin).post(`/tickets/${ticketId}/messages`, { visibility: 'internal', body: NOTE_TEXT, clientMessageId: uuidv7() })).status).toBe(201);

    // The worker relays the events and the audit consumer writes the entries.
    await vi.waitFor(
      async () => {
        const actions = actionsOf(await entries(admin, { resourceId: ticketId }));
        expect(actions).toEqual(
          expect.arrayContaining([
            'ticket.created',
            'ticket.priority_changed',
            'ticket.group_changed',
            'ticket.state_changed',
            'ticket.assigned',
            'ticket.reassigned',
            'ticket.message_added',
            'ticket.note_added',
          ]),
        );
      },
      { timeout: 20_000, interval: 250 },
    );
  }, 60_000);

  it('records each action with actor, resource, time and id-only details', async () => {
    const rows = await entries(admin, { resourceId: ticketId });
    const one = (action: string, pick: (row: Entry) => boolean = () => true): Entry => {
      const found = rows.filter((row) => row.action === action && pick(row));
      expect(found, action).toHaveLength(1);
      return found[0] as Entry;
    };
    const staffActor = { kind: 'user', id: admin.id, name: admin.name };

    const created = one('ticket.created');
    expect(created).toMatchObject({ actor: staffActor, resourceType: 'ticket', resourceId: ticketId, details: { groupId: groupOne } });
    expect(Number.isNaN(Date.parse(created.occurredAt))).toBe(false);

    expect(one('ticket.priority_changed')).toMatchObject({ actor: staffActor, details: { to: 'high' } });
    expect(one('ticket.group_changed')).toMatchObject({ actor: staffActor, details: { from: groupOne, to: groupTwo } });
    expect(one('ticket.state_changed').actor).toMatchObject(staffActor);
    expect(one('ticket.assigned')).toMatchObject({ actor: staffActor, details: { previousOwnerId: null, ownerId: agent.id } });
    expect(one('ticket.reassigned')).toMatchObject({ actor: staffActor, details: { previousOwnerId: agent.id, ownerId: other.id } });
    // The staff-started ticket's first message and the public reply.
    const messages = rows.filter((row) => row.action === 'ticket.message_added');
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toMatchObject({ actor: staffActor, resourceType: 'ticket', details: { authorKind: 'staff', attachmentCount: 0 } });
    }
    expect(one('ticket.note_added')).toMatchObject({ actor: staffActor, details: { authorKind: 'staff', attachmentCount: 0 } });
  });

  it('never carries a message body, note or title in any entry', async () => {
    const serialized = JSON.stringify(await entries(admin));
    for (const text of [BODY_TEXT, REPLY_TEXT, NOTE_TEXT, TITLE]) expect(serialized).not.toContain(text);
  });

  it('filters by action, resource, actor and time', async () => {
    const byAction = await entries(admin, { action: 'ticket.reassigned' });
    expect(byAction).toHaveLength(1);
    expect(byAction[0]?.resourceId).toBe(ticketId);

    const byResource = await entries(admin, { resourceType: 'ticket', resourceId: ticketId });
    expect(byResource.length).toBeGreaterThanOrEqual(8);
    expect(byResource.every((row) => row.resourceId === ticketId && row.resourceType === 'ticket')).toBe(true);

    const byActor = await entries(admin, { actorId: admin.id, resourceId: ticketId });
    expect(byActor).toHaveLength(byResource.filter((row) => row.actor.id === admin.id).length);
    expect(await entries(admin, { actorId: agent.id, resourceId: ticketId })).toEqual([]);

    expect(await entries(admin, { to: '2000-01-01T00:00:00Z' })).toEqual([]);
    expect((await entries(admin, { from: '2000-01-01T00:00:00Z', action: 'ticket.created' })).length).toBe(1);
  });

  it('writes one entry when the same outbox event is consumed twice', async () => {
    const eventId = await latestEventId(tenant.id, 'ticket.assigned');
    const consumer = (await getTestWorker()).module.get(AuditConsumer, { strict: false });
    const before = actionsOf(await entries(admin, { resourceId: ticketId }));

    // Already consumed by the worker, so both redeliveries are skipped.
    const results = [await consumer.process({ tenantId: tenant.id, eventId }, 'redelivery-1'), await consumer.process({ tenantId: tenant.id, eventId }, 'redelivery-2')];
    expect(results).toEqual(['skipped', 'skipped']);

    const after = await entries(admin, { resourceId: ticketId });
    expect(actionsOf(after)).toHaveLength(before.length);
    expect(after.filter((row) => row.action === 'ticket.reassigned')).toHaveLength(1);
  });
});

describe('directly audited actions', () => {
  it('lists one entry of each security and configuration action', async () => {
    const tenant = await createTenant();
    const password = 'correct-horse-battery-1';
    const admin = await createUser(tenant, { roles: ['admin'] });
    const member = await createUser(tenant, { roles: ['agent'], password });
    const group = await createGroup(tenant);
    const role = await createRole(tenant, { permissions: ['ticket.view'] });

    // Sign-in and a failed sign-in.
    expect((await asGuest(tenant).post('/auth/sign-in', { email: member.email, password })).status).toBe(200);
    expect((await asGuest(tenant).post('/auth/sign-in', { email: member.email, password: 'wrong-password-here-9' })).status).toBe(401);

    // Role permission change and group access change.
    const changed = await asUser(admin).put(`/roles/${role.id}`, {
      name: 'Audited role',
      permissions: ['ticket.view', 'ticket.edit'],
      groupAccess: [{ groupId: group.id, view: true, create: false, edit: false, delete: false }],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // Tenant settings.
    expect((await asUser(admin).patch('/settings', { timezone: 'Europe/Berlin' })).status).toBe(200);

    // Support access: grant, read as an operator, revoke.
    const granted = await asUser(admin).post('/support-access', { durationHours: 2, reason: 'Audit test' });
    expect(granted.status).toBe(201);
    const grantId = (granted.body as { id: string }).id;
    const { client: operator } = await asOperator();
    const session = await operator.post(`/platform/tenants/${tenant.id}/support-session`);
    expect(session.status).toBe(201);
    expect((await asSupport(tenant, (session.body as { token: string }).token).get('/users')).status).toBe(200);
    expect((await asUser(admin).post(`/support-access/${grantId}/revoke`)).status).toBe(200);

    const rows = await entries(admin);
    const only = (action: string): Entry => {
      const found = rows.filter((row) => row.action === action);
      expect(found, action).toHaveLength(1);
      return found[0] as Entry;
    };

    expect(only('auth.sign_in')).toMatchObject({ actor: { kind: 'user', id: member.id }, resourceType: 'user', resourceId: member.id });
    expect(only('auth.sign_in_failed')).toMatchObject({ resourceType: 'user', resourceId: member.id, details: { reason: expect.any(String) as string } });
    expect(only('permission.changed')).toMatchObject({
      actor: { kind: 'user', id: admin.id },
      resourceType: 'role',
      resourceId: role.id,
      details: { permissions: ['ticket.view', 'ticket.edit'] },
    });
    expect(only('group_access.changed')).toMatchObject({ actor: { kind: 'user', id: admin.id }, resourceType: 'role', resourceId: role.id });
    expect(only('tenant_settings.changed')).toMatchObject({ actor: { kind: 'user', id: admin.id }, resourceType: 'tenant_settings', resourceId: tenant.id });
    expect(only('support_access.granted')).toMatchObject({ actor: { kind: 'user', id: admin.id }, resourceType: 'support_access_grant', resourceId: grantId });
    expect(only('support_access.revoked')).toMatchObject({ actor: { kind: 'user', id: admin.id }, resourceId: grantId });
    expect(only('support_access.read')).toMatchObject({ resourceId: grantId, details: { method: 'GET', path: '/api/v1/users' } });

    // Neither password is anywhere in the log.
    const serialized = JSON.stringify(rows);
    for (const secret of [password, 'wrong-password-here-9']) expect(serialized).not.toContain(secret);
    expect(rows.every((row) => !Number.isNaN(Date.parse(row.occurredAt)))).toBe(true);
  });
});

describe('GET /audit-logs access', () => {
  it('answers 403 in the standard error format without audit_log.view', async () => {
    const tenant = await createTenant();
    const agent = await createUser(tenant, { roles: ['agent'] });
    const response = await asUser(agent).get('/audit-logs');
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('lists none of tenant A rows for a tenant B admin', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const [adminA, adminB] = await Promise.all([createUser(a, { roles: ['admin'] }), createUser(b, { roles: ['admin'] })]);
    expect((await asUser(adminA).patch('/settings', { timezone: 'Europe/Paris' })).status).toBe(200);

    expect(actionsOf(await entries(adminA))).toContain('tenant_settings.changed');
    const seen = await entries(adminB);
    expect(seen.some((row) => row.resourceId === a.id)).toBe(false);
    expect(await entries(adminB, { action: 'tenant_settings.changed', resourceId: a.id })).toEqual([]);
  });
});

describe('the log is append-only at the database', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    expect((await asUser(admin).patch('/settings', { timezone: 'Europe/Berlin' })).status).toBe(200);
  });

  /** Runs `statement` in a transaction with the tenant set, so only privileges can reject it. */
  async function inTenant(db: Kysely<Database>, statement: ReturnType<typeof sql>): Promise<unknown> {
    return db.transaction().execute(async (tx) => {
      await sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`.execute(tx);
      return statement.execute(tx);
    });
  }

  it('rejects UPDATE, DELETE and TRUNCATE for the app role', async () => {
    const visible = await inTenant(appDb, sql`SELECT count(*)::int AS n FROM audit_logs`);
    expect((visible as { rows: { n: number }[] }).rows[0]?.n).toBeGreaterThan(0);

    await expect(inTenant(appDb, sql`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(/permission denied for table audit_logs/);
    await expect(inTenant(appDb, sql`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied for table audit_logs/);
    await expect(inTenant(appDb, sql`TRUNCATE audit_logs`)).rejects.toThrow(/permission denied for table audit_logs/);
  });

  it('rejects UPDATE and INSERT for the retention role', async () => {
    await expect(inTenant(retentionDb, sql`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(/permission denied for table audit_logs/);
    await expect(
      inTenant(
        retentionDb,
        sql`INSERT INTO audit_logs (tenant_id, actor_kind, action, resource_type) VALUES (${tenant.id}, 'system', 'forged.entry', 'test')`,
      ),
    ).rejects.toThrow(/permission denied for table audit_logs/);
  });
});
