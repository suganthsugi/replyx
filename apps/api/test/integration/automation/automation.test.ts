import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { AutomationSweepJob } from '../../../src/routing/automation/automation-sweep.job.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * T256 (US17, FR-088, FR-089): automation rules.
 *
 * - CRUD with success / 403 / 404 and validation (the generated cross-tenant suite covers the
 *   `automation_rule` fixture).
 * - Each trigger: ticket created, ticket updated, a customer's message, and time elapsed (once per
 *   waiting period — the independent test).
 * - Loop guard: a rule never runs on its own changes; a chain of rules stops after three links.
 * - Actions respect owner eligibility (a refused run is recorded as failed and changes nothing),
 *   and notified users must be able to view the ticket.
 * - History credits the rule by name.
 */

const WAIT = { timeout: 20_000, interval: 200 };

interface TicketBody {
  priority: string;
  state: string;
  ownerId?: string | null;
  owner: { id: string } | null;
  tags: { id: string }[];
}

let tenant: TestTenant;
let admin: TestUser;

class AutomationRows extends TenantRepository {
  runs(tx: TenantTransaction, ruleId: string) {
    return this.selectFrom(tx, 'automation_runs').select(['automation_runs.status', 'automation_runs.error', 'automation_runs.trigger_key']).where('automation_runs.rule_id', '=', ruleId).execute();
  }

  setReplied(tx: TenantTransaction, ticketId: string, at: Date) {
    return this.updateTable(tx, 'tickets').set({ last_agent_reply_at: at, first_agent_reply_at: at, waiting_on: 'customer' }).where('tickets.id', '=', ticketId).execute();
  }

  ticketTags(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_tags').select(['ticket_tags.tag_id']).where('ticket_tags.ticket_id', '=', ticketId).execute();
  }

  automationMessages(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['ticket_messages.body']).where('ticket_messages.ticket_id', '=', ticketId).where('ticket_messages.author_kind', '=', 'automation').execute();
  }
}

async function rows<T>(t: TestTenant, run: (repo: AutomationRows, tx: TenantTransaction) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: t.id, actor: { kind: 'system' }, requestId: 'test-automation' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => run(new AutomationRows(ctx), tx));
}

async function createRule(user: TestUser, body: Record<string, unknown>): Promise<string> {
  const response = await asUser(user).post('/automation-rules', { enabled: true, conditions: null, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body as { id: string }).id;
}

const ticketOf = async (user: TestUser, id: string) => (await asUser(user).get(`/tickets/${id}`)).body as TicketBody;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant();
  admin = await createUser(tenant, { roles: ['admin'] });
});

describe('/automation-rules CRUD', () => {
  it('creates, lists, replaces and deletes a rule; audited', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const id = await createRule(owner, { name: 'Urgent VIPs', trigger: { event: 'ticket.created' }, actions: { priority: 'urgent' } });

    const list = await asUser(owner).get('/automation-rules');
    expect(list.status).toBe(200);
    expect((list.body as { items: { id: string; position: number }[] }).items).toEqual([expect.objectContaining({ id, position: 0 })]);

    const replaced = await asUser(owner).put(`/automation-rules/${id}`, {
      name: 'Renamed',
      enabled: false,
      trigger: { event: 'time.elapsed', after: 'P2D', since: 'last_agent_reply_at' },
      conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }] },
      actions: { state: 'pending_close', pendingInHours: 24, autoReply: 'Just checking in!' },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: 'Renamed', enabled: false, position: 0, actions: { state: 'pending_close', pendingInHours: 24 } });

    expect((await asUser(owner).delete(`/automation-rules/${id}`)).status).toBe(204);
    expect((await asUser(owner).delete(`/automation-rules/${id}`)).status).toBe(404);

    const audit = (await asUser(owner).get('/audit-logs?resourceType=automation_rule')).body as { items: { action: string }[] };
    expect(audit.items.map((entry) => entry.action).sort()).toEqual(['automation_rule.created', 'automation_rule.deleted', 'automation_rule.updated']);
  });

  it('403 without the automation_rule permissions; 404 for an unknown id', async () => {
    const agent = await createUser(tenant, { roles: ['agent'] });
    expect((await asUser(agent).get('/automation-rules')).status).toBe(403);
    expect((await asUser(agent).post('/automation-rules', { name: 'x', enabled: true, trigger: { event: 'ticket.created' }, conditions: null, actions: { priority: 'low' } })).status).toBe(403);
    const unknown = uuidv7();
    expect((await asUser(admin).put(`/automation-rules/${unknown}`, { name: 'x', enabled: true, trigger: { event: 'ticket.created' }, conditions: null, actions: { priority: 'low' } })).status).toBe(404);
    expect((await asUser(admin).delete(`/automation-rules/${unknown}`)).status).toBe(404);
  });

  it('refuses invalid rules (400)', async () => {
    const base = { name: 'Bad', enabled: true, conditions: null };
    const bodies = [
      { ...base, trigger: { event: 'time.elapsed', after: 'P2D' }, actions: { priority: 'low' } },
      { ...base, trigger: { event: 'time.elapsed', after: 'PT1M', since: 'created_at' }, actions: { priority: 'low' } },
      { ...base, trigger: { event: 'time.elapsed', after: 'soon', since: 'created_at' }, actions: { priority: 'low' } },
      { ...base, trigger: { event: 'ticket.created' }, actions: {} },
      { ...base, trigger: { event: 'ticket.created' }, actions: { state: 'pending_close' } },
      { ...base, trigger: { event: 'ticket.created' }, actions: { priority: 'low' }, conditions: { op: 'and', items: [{ field: 'owner', operator: 'is', value: 'me' }] } },
      { ...base, trigger: { event: 'ticket.created' }, actions: { groupId: uuidv7() } },
      { ...base, trigger: { event: 'ticket.created' }, actions: { notifyUserIds: [uuidv7()] } },
      { ...base, trigger: { event: 'ticket.created' }, actions: { priority: 'low' }, extra: true },
    ];
    for (const body of bodies) {
      const response = await asUser(admin).post('/automation-rules', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('automation triggers and actions', () => {
  it('ticket.created: a matching new ticket gets the actions, credited to the rule in its history', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const tag = (await asUser(owner).post('/tags', { name: 'auto' })).body as { id: string };
    await createRule(owner, { name: 'New tickets are high', trigger: { event: 'ticket.created' }, actions: { priority: 'high', addTagIds: [tag.id] } });
    const customer = await createUser(t, { roles: ['customer'] });

    expect((await asUser(customer).post('/customer/messages', { body: 'Help please', clientMessageId: uuidv7() })).status).toBe(201);
    const ticketId = await vi.waitFor(async () => {
      const list = (await asUser(owner).get('/tickets')).body as { items: { id: string; priority: string }[] };
      expect(list.items[0]?.priority).toBe('high');
      return list.items[0]!.id;
    }, WAIT);

    expect((await ticketOf(owner, ticketId)).tags.map((t2) => t2.id)).toEqual([tag.id]);
    const history = (await asUser(owner).get(`/tickets/${ticketId}/history`)).body as { items: { field: string; actor: { kind: string; ruleName?: string } }[] };
    expect(history.items.find((entry) => entry.field === 'priority')?.actor).toEqual({ kind: 'automation', ruleName: 'New tickets are high' });
  });

  it('message.created: a customer message on an open ticket gets one auto-reply, from "Support" in the chat', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const ruleId = await createRule(owner, {
      name: 'Acknowledge',
      trigger: { event: 'message.created' },
      conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }] },
      actions: { autoReply: 'Thanks, we got your message.' },
    });
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, state: 'open' });

    expect((await asUser(customer).post('/customer/messages', { body: 'Any news?', clientMessageId: uuidv7() })).status).toBe(201);
    await vi.waitFor(async () => expect(await rows(t, (repo, tx) => repo.automationMessages(tx, ticket.id))).toHaveLength(1), WAIT);

    const conversation = (await asUser(customer).get('/customer/conversation')).body as { items: { type: string; message?: { body: string; from: { kind: string; name?: string } } }[] };
    const reply = conversation.items.find((item) => item.message?.body === 'Thanks, we got your message.');
    expect(reply?.message?.from).toEqual({ kind: 'support', name: 'Support', avatarUrl: null });
    expect(await rows(t, (repo, tx) => repo.runs(tx, ruleId))).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it("ticket.updated: a rule's own change never triggers it again", async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const ruleId = await createRule(owner, {
      name: 'Open tickets go urgent',
      trigger: { event: 'ticket.updated' },
      conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }] },
      actions: { priority: 'urgent' },
    });
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, state: 'open' });

    expect((await asUser(owner).patch(`/tickets/${ticket.id}`, { title: 'Renamed' })).status).toBe(200);
    await vi.waitFor(async () => expect((await ticketOf(owner, ticket.id)).priority).toBe('urgent'), WAIT);
    // Its own ticket.updated would match again; give the worker time to (not) act on it.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await rows(t, (repo, tx) => repo.runs(tx, ruleId))).toHaveLength(1);
  });

  it('a chain of rules triggering each other stops after three links (FR-089)', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const step = (from: string, to: string) =>
      createRule(owner, {
        name: `${from} to ${to}`,
        trigger: { event: 'ticket.updated' },
        conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: from }] },
        actions: { priority: to },
      });
    const a = await step('low', 'normal');
    const b = await step('normal', 'high');
    const c = await step('high', 'urgent');
    // Would close the loop back to the start: it must never run.
    const d = await step('urgent', 'low');
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, state: 'open' });

    expect((await asUser(owner).patch(`/tickets/${ticket.id}`, { priority: 'low' })).status).toBe(200);
    await vi.waitFor(async () => expect((await ticketOf(owner, ticket.id)).priority).toBe('urgent'), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await ticketOf(owner, ticket.id)).priority).toBe('urgent');
    for (const ruleId of [a, b, c]) expect(await rows(t, (repo, tx) => repo.runs(tx, ruleId))).toHaveLength(1);
    expect(await rows(t, (repo, tx) => repo.runs(tx, d))).toHaveLength(0);
  });

  it('time.elapsed: "waiting on the customer for 2 days → reminder and pending close" runs both actions exactly once (independent test)', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const ruleId = await createRule(owner, {
      name: 'Nudge quiet customers',
      trigger: { event: 'time.elapsed', after: 'P2D', since: 'last_agent_reply_at' },
      conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }, { field: 'waiting_on', operator: 'is', value: 'customer' }] },
      actions: { autoReply: 'Do you still need help?', state: 'pending_close', pendingInHours: 24 },
    });
    const customer = await createUser(t, { roles: ['customer'] });
    const waiting = await createTicket(t, { customer, state: 'open' });
    const recent = await createTicket(t, { customer: await createUser(t, { roles: ['customer'] }), state: 'open' });
    const now = new Date();
    await rows(t, (repo, tx) => repo.setReplied(tx, waiting.id, new Date(now.getTime() - 3 * 86_400_000)));
    await rows(t, (repo, tx) => repo.setReplied(tx, recent.id, new Date(now.getTime() - 86_400_000)));

    const sweeper = (await getTestWorker()).module.get(AutomationSweepJob);
    const queued = await sweeper.sweepTenant(t.id, now);
    expect(queued.map((run) => run.ticketId)).toEqual([waiting.id]);

    await vi.waitFor(async () => expect((await ticketOf(owner, waiting.id)).state).toBe('pending_close'), WAIT);
    expect(await rows(t, (repo, tx) => repo.automationMessages(tx, waiting.id))).toEqual([{ body: 'Do you still need help?' }]);

    // Later sweeps find nothing more for this waiting period.
    expect(await sweeper.sweepTenant(t.id, new Date(now.getTime() + 3_600_000))).toEqual([]);
    expect(await rows(t, (repo, tx) => repo.runs(tx, ruleId))).toHaveLength(1);
    expect((await ticketOf(owner, recent.id)).state).toBe('open');
  });

  it('actions respect owner eligibility: a refused run is recorded as failed and changes nothing', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const billing = await createGroup(t, { name: 'Billing' });
    const viewerRole = await createRole(t, { permissions: ['ticket.view'], groups: [{ group: billing.id, flags: { view: true, edit: false } }] });
    const viewOnly = await createUser(t, { roles: [{ id: viewerRole.id }] });
    const ruleId = await createRule(owner, { name: 'Assign to a viewer', trigger: { event: 'ticket.updated' }, actions: { ownerId: viewOnly.id, priority: 'urgent' } });
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, group: billing.id, state: 'open' });

    expect((await asUser(owner).patch(`/tickets/${ticket.id}`, { title: 'Touch' })).status).toBe(200);
    await vi.waitFor(async () => expect(await rows(t, (repo, tx) => repo.runs(tx, ruleId))).toEqual([expect.objectContaining({ status: 'failed', error: 'OWNER_NOT_ELIGIBLE' })]), WAIT);
    const after = await ticketOf(owner, ticket.id);
    expect(after.owner).toBeNull();
    expect(after.priority).toBe('normal');
  });

  it('notifies only the listed users who can view the ticket', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['admin'] });
    const billing = await createGroup(t, { name: 'Billing' });
    const shipping = await createGroup(t, { name: 'Shipping' });
    const billingRole = await createRole(t, { permissions: ['ticket.view'], groups: [{ group: billing.id, flags: { view: true, edit: false } }] });
    const shippingRole = await createRole(t, { permissions: ['ticket.view'], groups: [{ group: shipping.id, flags: { view: true, edit: false } }] });
    const canSee = await createUser(t, { roles: [{ id: billingRole.id }] });
    const cannotSee = await createUser(t, { roles: [{ id: shippingRole.id }] });
    await createRule(owner, { name: 'Tell the leads', trigger: { event: 'ticket.updated' }, actions: { notifyUserIds: [canSee.id, cannotSee.id] } });
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, group: billing.id, state: 'open' });

    expect((await asUser(owner).patch(`/tickets/${ticket.id}`, { title: 'Touch' })).status).toBe(200);
    await vi.waitFor(async () => {
      const list = (await asUser(canSee).get('/notifications')).body as { items: { eventType: string; title: string; ticketId: string | null }[] };
      expect(list.items).toEqual([expect.objectContaining({ eventType: 'automation.rule', ticketId: ticket.id, title: `Tell the leads: #${ticket.number}` })]);
    }, WAIT);
    expect(((await asUser(cannotSee).get('/notifications')).body as { items: unknown[] }).items).toEqual([]);
  });
});
