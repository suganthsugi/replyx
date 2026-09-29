import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import {
  createGroup,
  createTenant,
  createTicket,
  createUser,
  setConversationSettings,
  type TestTenant,
} from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { sweeperJob } from '../../support/jobs.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';

/**
 * The customer-facing resolution lifecycle end to end (T185, US7 scenario 1: grace reopen, the
 * after-close fork, and the sweeper closing an expired resolved ticket): customer-message-router.ts,
 * sweeper.job.ts, state-machine.ts, tickets.service.ts PATCH and T182's announceResolved
 * (conversation-events.ts). The individual branches (router unit tests, staff-messages.test.ts,
 * access-loss-and-sweeper.test.ts) are covered elsewhere; this file is about the whole path a
 * customer lives through.
 */

interface Envelope {
  id: string;
  type: string;
  stream: string;
  data: Record<string, unknown>;
}

interface ThreadItem {
  type: 'message' | 'resolved_marker';
  marker?: { id: string; text: string };
  message?: { body: string };
}

interface ConversationPageBody {
  items: ThreadItem[];
  status: { code: string; text: string };
}

interface TicketBody {
  id: string;
  state: string;
  group: { id: string } | null;
  ownerId?: string | null;
  links: { kind: string; direction: string; ticket: { id: string } | null }[];
}

const envelope = (socket: Socket, match: (e: Envelope) => boolean, timeoutMs = 5_000) => waitForEvent<Envelope>(socket, 'event', match, timeoutMs);

class TicketRowRepository extends TenantRepository {
  ticket(tx: TenantTransaction, id: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.state', 'tickets.group_id', 'tickets.owner_id', 'tickets.auto_close_at', 'tickets.customer_id'])
      .where('tickets.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  ticketsForCustomer(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets').select(['tickets.id', 'tickets.state']).where('tickets.customer_id', '=', customerId).execute();
  }
}

async function inTenant<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: TicketRowRepository) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-resolution' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new TicketRowRepository(ctx)));
}

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant();
});

describe('the resolution lifecycle (US7)', () => {
  it('announces a resolution to the customer, then reopens it on a reply within grace, then closes it after grace and starts a follow-up', async () => {
    const group = await createGroup(tenant);
    const owner = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const { clock } = await getTestApp();
    const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'open', messages: [{ body: 'Where is my order?' }] });
    const socket = await connectSocket(customer);

    try {
      // 1. Resolving announces the marker, then idle, over the customer's socket, and
      // GET /customer/conversation shows the same marker id.
      const resolvedEnvelope = envelope(socket, (e) => e.type === 'conversation.resolved');
      const idleEnvelope = envelope(socket, (e) => e.type === 'conversation.status' && e.data.code === 'idle');
      const resolved = await asUser(owner).patch(`/tickets/${ticket.id}`, { state: 'resolved' });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ state: 'resolved' });

      const resolvedEvent = await resolvedEnvelope;
      expect(resolvedEvent.stream).toBe('conversation');
      const markerId = (resolvedEvent.data as { id: string }).id;
      expect(markerId).toEqual(expect.any(String));
      expect((await idleEnvelope).data).toEqual({ code: 'idle', text: "Send us a message and we'll get back to you" });

      const page = await asUser(customer).get('/customer/conversation');
      expect(page.status).toBe(200);
      const marker = (page.body as ConversationPageBody).items.find((item) => item.type === 'resolved_marker');
      expect(marker?.marker?.id).toBe(markerId);
      expect(marker?.marker?.text).toBe('Glad we could help, just reply if you need anything else');

      // 2. A reply within grace reopens the same ticket, keeping group and owner.
      const reopened = envelope(socket, (e) => e.type === 'conversation.message');
      const reply = await asUser(customer).post('/customer/messages', { body: 'thanks', clientMessageId: uuidv7() });
      expect(reply.status).toBe(201);
      await reopened;

      const afterReply = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
      expect(afterReply.state).toBe('open');
      expect(afterReply.group_id).toBe(group.id);
      expect(afterReply.owner_id).toBe(owner.id);

      // One PATCH re-resolves the very same ticket.
      const reResolved = await asUser(owner).patch(`/tickets/${ticket.id}`, { state: 'resolved' });
      expect(reResolved.status).toBe(200);
      const afterReResolve = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
      expect(afterReResolve.state).toBe('resolved');
      expect(afterReResolve.id).toBe(ticket.id);
      const autoCloseAt = afterReResolve.auto_close_at;
      expect(autoCloseAt).not.toBeNull();

      // 3. Advancing past auto_close_at and running the sweeper closes it.
      clock.set(new Date((autoCloseAt as Date).getTime() + 1_000));
      const job = await sweeperJob();
      await job.process();
      const afterSweep = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
      expect(afterSweep.state).toBe('closed');

      // 4. The next customer message starts a new, ungrouped ticket (no routing rule matches),
      // linked follow_up_of the closed one, while the customer still sees one continuous thread.
      const followUpMessage = envelope(socket, (e) => e.type === 'conversation.message');
      const nextClientId = uuidv7();
      const sent = await asUser(customer).post('/customer/messages', { body: 'Still there?', clientMessageId: nextClientId });
      expect(sent.status).toBe(201);
      await followUpMessage;

      const customerTickets = await inTenant(tenant, (tx, repo) => repo.ticketsForCustomer(tx, customer.id));
      expect(customerTickets).toHaveLength(2);
      const followUpTicketId = customerTickets.find((row) => row.id !== ticket.id)?.id;
      expect(followUpTicketId).toBeDefined();

      // A fresh staff session: the 72 h jump above outlived the 12 h staff idle window `owner`
      // signed in under (access-loss-and-sweeper.test.ts does the same after its own big jump).
      const freshOwner = await createUser(tenant, { roles: ['admin'] });

      // No GET /tickets/{id}: an empty PATCH round-trips the same ticket dto, links included.
      const followUpTicket = await asUser(freshOwner).patch(`/tickets/${followUpTicketId as string}`, {});
      expect(followUpTicket.status).toBe(200);
      const followUpBody = followUpTicket.body as TicketBody;
      expect(followUpBody.group).toBeNull();
      expect(followUpBody.links).toContainEqual(
        expect.objectContaining({ kind: 'follow_up_of', direction: 'outgoing', ticket: expect.objectContaining({ id: ticket.id }) as object }),
      );

      const continuedThread = await asUser(customer).get('/customer/conversation');
      const bodies = (continuedThread.body as ConversationPageBody).items.filter((item) => item.type === 'message').map((item) => item.message?.body);
      expect(bodies).toEqual(['Where is my order?', 'thanks', 'Still there?']);
    } finally {
      socket.close();
    }
  });

  it('reopens the previous ticket instead of a follow-up when after_close_behavior is reopen_previous', async () => {
    const group = await createGroup(tenant);
    const owner = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const { clock } = await getTestApp();
    await setConversationSettings(tenant, { afterCloseBehavior: 'reopen_previous' });

    const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'open', messages: [{ body: 'Hi' }] });
    const resolved = await asUser(owner).patch(`/tickets/${ticket.id}`, { state: 'resolved' });
    expect(resolved.status).toBe(200);

    const afterResolve = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    clock.set(new Date((afterResolve.auto_close_at as Date).getTime() + 1_000));
    const job = await sweeperJob();
    await job.process();
    const closed = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    expect(closed.state).toBe('closed');

    const sent = await asUser(customer).post('/customer/messages', { body: 'Are you still there?', clientMessageId: uuidv7() });
    expect(sent.status).toBe(201);

    const customerTickets = await inTenant(tenant, (tx, repo) => repo.ticketsForCustomer(tx, customer.id));
    expect(customerTickets).toHaveLength(1);
    const reopened = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    expect(reopened.state).toBe('open');
    expect(reopened.group_id).toBe(group.id);
    expect(reopened.owner_id).toBe(owner.id);
  });
});
