import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { EMAIL_JOB, type EmailJobData } from '../../../src/platform-kernel/mail/mail.service.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createTenant, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * `POST /tickets` starting a ticket for an existing customer (staff-started-ticket.service.ts,
 * FR-038a, T136/T147): the first message reaches the customer's conversation like any public
 * reply, a follow-up from the customer lands on the same ticket, the offline reply email fires
 * when the customer has no socket, and the create/group-status conflicts.
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

interface ConversationBody {
  items: ({ type: 'message'; message: Record<string, unknown> & { id: string; body: string } } | { type: 'resolved_marker'; marker: { id: string } })[];
}

class Inspect extends TenantRepository {
  ticketsOf(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets').select(['id', 'title', 'origin', 'state', 'waiting_on']).where('customer_id', '=', customerId).orderBy('created_at').execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

const ticketsOf = (tenant: TestTenant, customerId: string) => inspect(tenant, (tx, repo) => repo.ticketsOf(tx, customerId));

function createBody(customerId: string, groupId: string, overrides: Partial<{ title: string; body: string }> = {}) {
  return {
    customerId,
    groupId,
    title: overrides.title ?? 'Welcome aboard',
    message: { body: overrides.body ?? 'Hi, following up on your order', attachmentIds: [] },
  };
}

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant();
});

describe('POST /tickets (staff-started)', () => {
  it('reaches the customer conversation as a support message with no ticket fields (success)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const admin = await createUser(tenant, { roles: ['admin'], name: 'Priya' });

    const created = await asUser(admin).post('/tickets', createBody(customer.id, group.id, { body: 'Hi, following up on your order' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Welcome aboard', state: 'open', origin: 'staff_started' });

    const conversation = await asUser(customer).get('/customer/conversation');
    expect(conversation.status).toBe(200);
    const page = conversation.body as ConversationBody;
    const messages = page.items.filter((item): item is { type: 'message'; message: Record<string, unknown> & { id: string; body: string } } => item.type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.body).toBe('Hi, following up on your order');
    expect(messages[0]?.message.from).toEqual({ kind: 'support', name: 'Priya', avatarUrl: null });
    const keys = Object.keys(messages[0]?.message ?? {});
    for (const forbidden of ['ticketId', 'ticket_id', 'number', 'state', 'group', 'groupId', 'owner', 'ownerId', 'priority', 'sla', 'visibility', 'internal']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("appends the customer's next message to the staff-started ticket, not a new one", async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const admin = await createUser(tenant, { roles: ['admin'] });
    const created = await asUser(admin).post('/tickets', createBody(customer.id, group.id));
    const ticketId = (created.body as { id: string }).id;

    const reply = await asUser(customer).post('/customer/messages', { body: 'Thanks, that helps', clientMessageId: uuidv7() });
    expect(reply.status).toBe(201);

    const rows = await ticketsOf(tenant, customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ticketId, state: 'open' });
  });

  it('queues an offline reply email when the customer has no socket connected', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const admin = await createUser(tenant, { roles: ['admin'] });

    const queues = await service(QueueRegistry);
    const emailJobsFor = async () =>
      (await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
        (job) => job.name === EMAIL_JOB && (job.data as EmailJobData).to === customer.email,
      );

    await asUser(admin).post('/tickets', createBody(customer.id, group.id, { body: 'Checking in on your order' }));
    await vi.waitFor(async () => expect(await emailJobsFor()).toHaveLength(1), { timeout: 10_000 });
    const jobs = await emailJobsFor();
    expect((jobs[0]!.data as EmailJobData).template).toBe('support-reply');
  });

  it('refuses a staff member with view/edit but no create access on the group (403)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, create: false, edit: true } }] });
    const agent = await createUser(tenant, { roles: ['agent'] });

    const response = await asUser(agent).post('/tickets', createBody(customer.id, group.id));
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('refuses an inactive customer (409 CUSTOMER_INACTIVE)', async () => {
    const inactive = await createUser(tenant, { roles: ['customer'], status: 'deactivated' });
    const group = await createGroup(tenant);
    const admin = await createUser(tenant, { roles: ['admin'] });

    const response = await asUser(admin).post('/tickets', createBody(inactive.id, group.id));
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('CUSTOMER_INACTIVE'));
  });

  it('refuses an inactive group (409 GROUP_INACTIVE)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant, { status: 'inactive' });
    const admin = await createUser(tenant, { roles: ['admin'] });

    const response = await asUser(admin).post('/tickets', createBody(customer.id, group.id));
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('GROUP_INACTIVE'));
  });

  it('hides a group belonging to another tenant, same as an unknown one (404)', async () => {
    const other = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const foreignGroup = await createGroup(other);
    const admin = await createUser(tenant, { roles: ['admin'] });

    const response = await asUser(admin).post('/tickets', createBody(customer.id, foreignGroup.id));
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody('GROUP_NOT_FOUND'));
  });
});
