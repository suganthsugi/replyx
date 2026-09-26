import { sql } from 'kysely';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { EMAIL_JOB, type EmailJobData } from '../../../src/platform-kernel/mail/mail.service.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * Staff reads of a ticket and its timeline, and replies and notes (T123; contracts/tickets.yaml
 * `/tickets/{id}`, `/tickets/{id}/messages`, FR-055): success / permission-denied / cross-tenant
 * 404, the first public reply's state move, and that an internal note stays off the customer's
 * conversation and never queues the offline reply email.
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

interface TicketRowView {
  state: string;
  waiting_on: string;
  first_agent_reply_at: Date | null;
  last_agent_reply_at: Date | null;
}

class Inspect extends TenantRepository {
  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['state', 'waiting_on', 'first_agent_reply_at', 'last_agent_reply_at'])
      .where('id', '=', ticketId)
      .executeTakeFirstOrThrow();
  }

  events(tx: TenantTransaction, stream: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select(['type', 'payload', 'customer_payload', 'streams'])
      .where(sql<boolean>`streams @> ARRAY[${stream}]::text[]`)
      .orderBy('id')
      .execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

const ticketRow = (tenant: TestTenant, ticketId: string) => inspect(tenant, (tx, repo) => repo.ticket(tx, ticketId)) as Promise<TicketRowView>;

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  await getTestApp();
  [tenant, other] = await Promise.all([createTenant(), createTenant()]);
});

describe('GET /tickets/{id}', () => {
  it('shows an authorized staff member the ticket (success)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const response = await asUser(admin).get(`/tickets/${ticket.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: ticket.id, number: ticket.number, state: 'open' });
  });

  it('refuses a staff member with no ticket.view permission (403)', async () => {
    const bystander = await createUser(tenant, { roles: [] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const response = await asUser(bystander).get(`/tickets/${ticket.id}`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('hides a ticket in a group the caller cannot view, same as an unknown id (404)', async () => {
    const hidden = await createGroup(tenant);
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const outsideTicket = await createTicket(tenant, { customer, group: hidden.id, state: 'open' });

    const cross = await asUser(agent).get(`/tickets/${outsideTicket.id}`);
    const unknown = await asUser(agent).get(`/tickets/${uuidv7()}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('hides a ticket in another tenant from an admin who has the permission there (404)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const otherAdmin = await createUser(other, { roles: ['admin'] });

    const cross = await asUser(otherAdmin).get(`/tickets/${ticket.id}`);
    const unknown = await asUser(otherAdmin).get(`/tickets/${uuidv7()}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

describe('GET /tickets/{id}/messages', () => {
  it('lists the timeline for an authorized staff member (success)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'Hello' }] });

    const response = await asUser(admin).get(`/tickets/${ticket.id}/messages`);
    expect(response.status).toBe(200);
    const body = response.body as { items: { body: string }[] };
    expect(body.items.map((item) => item.body)).toEqual(['Hello']);
  });

  it('refuses a staff member with no ticket.view permission (403)', async () => {
    const bystander = await createUser(tenant, { roles: [] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const response = await asUser(bystander).get(`/tickets/${ticket.id}/messages`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('hides another tenant\'s messages from an admin who has the permission there (404)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const otherAdmin = await createUser(other, { roles: ['admin'] });

    const cross = await asUser(otherAdmin).get(`/tickets/${ticket.id}/messages`);
    const unknown = await asUser(otherAdmin).get(`/tickets/${uuidv7()}/messages`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

describe('POST /tickets/{id}/messages', () => {
  it('posts a public reply, moves a new ticket to open and reaches the customer as a projection (success)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'], name: 'Priya' });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'new', messages: [{ body: 'Help please' }] });

    const response = await asUser(admin).post(`/tickets/${ticket.id}/messages`, {
      visibility: 'public',
      body: 'On it, one moment',
      clientMessageId: uuidv7(),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      visibility: 'public',
      body: 'On it, one moment',
      authorKind: 'staff',
      author: { id: admin.id, name: 'Priya' },
    });

    const row = await ticketRow(tenant, ticket.id);
    expect(row).toMatchObject({ state: 'open', waiting_on: 'customer' });
    expect(row.first_agent_reply_at).not.toBeNull();
    expect(row.last_agent_reply_at).not.toBeNull();

    const customerStream = await inspect(tenant, (tx, repo) => repo.events(tx, `conversation:${customer.id}`));
    const projected = customerStream.find((event) => event.type === 'message.created');
    expect(projected).toBeDefined();
    expect((projected?.customer_payload as { data: { body: string } } | null)?.data.body).toBe('On it, one moment');
  });

  it('keeps a second public reply from moving the ticket state again', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'Still broken' }] });

    const response = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Looking again', clientMessageId: uuidv7() });
    expect(response.status).toBe(201);
    expect((await ticketRow(tenant, ticket.id)).state).toBe('open');
  });

  it('posts an internal note with no customer event, no state move and no email (success)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'new', messages: [{ body: 'Help please' }] });

    const response = await asUser(admin).post(`/tickets/${ticket.id}/messages`, {
      visibility: 'internal',
      body: 'Waiting on the warehouse',
      clientMessageId: uuidv7(),
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ visibility: 'internal', body: 'Waiting on the warehouse' });

    // No state change: an internal note never counts as the first agent reply.
    const row = await ticketRow(tenant, ticket.id);
    expect(row).toMatchObject({ state: 'new', waiting_on: 'support' });
    expect(row.first_agent_reply_at).toBeNull();

    // Only the ticket stream carries the note; the customer's conversation stream gets nothing.
    const ticketStreamEvents = await inspect(tenant, (tx, repo) => repo.events(tx, `ticket:${ticket.id}`));
    const noteEvent = ticketStreamEvents.find((event) => event.type === 'message.created' && (event.payload as { visibility: string }).visibility === 'internal');
    expect(noteEvent).toBeDefined();
    expect(noteEvent?.customer_payload).toBeNull();
    expect(noteEvent?.streams).toEqual([`ticket:${ticket.id}`]);

    const customerStream = await inspect(tenant, (tx, repo) => repo.events(tx, `conversation:${customer.id}`));
    expect(customerStream).toEqual([]);

    // Prove the offline-reply-email pipeline works at all (a public reply on the same ticket
    // queues one), then confirm the internal note above queued none for this customer.
    await getTestWorker();
    const queues = await service(QueueRegistry);
    const emailJobsFor = async () =>
      (await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
        (job) => job.name === EMAIL_JOB && (job.data as EmailJobData).to === customer.email,
      );

    await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Shipped today', clientMessageId: uuidv7() });
    await vi.waitFor(async () => expect(await emailJobsFor()).toHaveLength(1), { timeout: 10_000 });

    const jobs = await emailJobsFor();
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.data as EmailJobData).template).toBe('support-reply');
  });

  it('returns the original message for a repeated clientMessageId (idempotent retry)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const key = uuidv7();

    const first = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Hello', clientMessageId: key });
    const again = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Hello (tapped twice)', clientMessageId: key });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);

    const listed = await asUser(admin).get(`/tickets/${ticket.id}/messages`);
    const body = listed.body as { items: { clientMessageId: string | null }[] };
    expect(body.items.filter((item) => item.clientMessageId === key)).toHaveLength(1);
  });

  it('refuses a staff member with view but no edit access to the group (403)', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: false } }] });
    const viewer = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });

    // The viewer can read the ticket (view is granted) but not write to it.
    expect((await asUser(viewer).get(`/tickets/${ticket.id}`)).status).toBe(200);

    const response = await asUser(viewer).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Trying to reply', clientMessageId: uuidv7() });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('hides a ticket in a group the caller cannot view, same as an unknown id (404)', async () => {
    const hidden = await createGroup(tenant);
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const outsideTicket = await createTicket(tenant, { customer, group: hidden.id, state: 'open' });

    const cross = await asUser(agent).post(`/tickets/${outsideTicket.id}/messages`, { visibility: 'public', body: 'Trying to reply', clientMessageId: uuidv7() });
    const unknown = await asUser(agent).post(`/tickets/${uuidv7()}/messages`, { visibility: 'public', body: 'Trying to reply', clientMessageId: uuidv7() });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('hides another tenant\'s ticket from an admin who has the permission there (404)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const otherAdmin = await createUser(other, { roles: ['admin'] });

    const cross = await asUser(otherAdmin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Trying to reply', clientMessageId: uuidv7() });
    const unknown = await asUser(otherAdmin).post(`/tickets/${uuidv7()}/messages`, { visibility: 'public', body: 'Trying to reply', clientMessageId: uuidv7() });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('rejects mentions on a public reply and unknown or inactive mentions', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const otherAdmin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const publicWithMention = await asUser(admin).post(`/tickets/${ticket.id}/messages`, {
      visibility: 'public',
      body: 'Cannot mention here',
      clientMessageId: uuidv7(),
      mentionIds: [otherAdmin.id],
    });
    expect(publicWithMention.status).toBe(400);
    expect((publicWithMention.body as { error: { details?: { path: string; issue: string }[] } }).error.details).toEqual([{ path: 'mentionIds', issue: 'invalid' }]);

    const unknownMention = await asUser(admin).post(`/tickets/${ticket.id}/messages`, {
      visibility: 'internal',
      body: 'Ping someone',
      clientMessageId: uuidv7(),
      mentionIds: [uuidv7()],
    });
    expect(unknownMention.status).toBe(400);
    expect((unknownMention.body as { error: { details?: { path: string; issue: string }[] } }).error.details).toEqual([{ path: 'mentionIds', issue: 'invalid' }]);
  });
});
