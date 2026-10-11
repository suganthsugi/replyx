import { beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { ratingOfferId } from '../../../src/satisfaction/rating-offer.js';
import { getTestApp } from '../../support/app.js';
import { createCustomer } from '../../support/customer-profiles.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * T250 (US16): satisfaction ratings and the full customer profile.
 *
 * - A resolved conversation offers an opaque `pendingRating` in the customer's chat; rating it
 *   shows on the ticket, in the customer profile and in the dashboard; skipping hides the offer.
 * - One rating per ticket (rating again changes it); only the ticket's own customer can rate;
 *   the id never reaches another customer's ticket (404); scores outside 1–5 are 400.
 * - The profile's figure, the history and the dashboard only count tickets the caller can view.
 * - `GET /customers/{id}/messages`: newest first, paged, internal notes for staff with access,
 *   success / 403 / 404 and cross-tenant 404.
 */

interface ConversationBody {
  pendingRating: { ratingId: string } | null;
}

interface DashboardBody {
  satisfaction: { average: number | null; responses: number };
}

interface ProfileBody {
  satisfaction: { average: number | null; responses: number };
}

interface HistoryBody {
  items: { id: string; body: string; visibility: string; ticketId: string; ticketNumber: number }[];
  nextCursor: string | null;
}

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  await getTestApp();
  [tenant, other] = await Promise.all([createTenant(), createTenant()]);
});

async function pendingRating(customer: Awaited<ReturnType<typeof createCustomer>>) {
  const response = await asUser(customer).get('/customer/conversation');
  expect(response.status).toBe(200);
  return (response.body as ConversationBody).pendingRating;
}

describe('satisfaction ratings (FR-087)', () => {
  it('a resolved conversation offers a rating; the rating shows on the ticket, the profile and the dashboard (independent test)', async () => {
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const customer = await createCustomer(t);
    const ticket = await createTicket(t, { customer, state: 'resolved', messages: [{ body: 'Where is my order?' }] });

    const offer = await pendingRating(customer);
    expect(offer).not.toBeNull();
    // Opaque: never the ticket's id.
    expect(offer!.ratingId).not.toBe(ticket.id);
    expect(offer!.ratingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const rated = await asUser(customer).put(`/customer/ratings/${offer!.ratingId}`, { score: 4, comment: 'Quick and kind' });
    expect(rated.status).toBe(204);
    expect(await pendingRating(customer)).toBeNull();

    const detail = await asUser(admin).get(`/tickets/${ticket.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as { csat: unknown }).csat).toMatchObject({ score: 4, comment: 'Quick and kind' });

    const profile = await asUser(admin).get(`/customers/${customer.id}`);
    expect((profile.body as ProfileBody).satisfaction).toEqual({ average: 4, responses: 1 });

    const dashboard = await asUser(admin).get('/dashboard');
    expect((dashboard.body as DashboardBody).satisfaction).toEqual({ average: 4, responses: 1 });
  });

  it('rating again changes the one rating for the ticket; the dashboard averages across tickets', async () => {
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const first = await createCustomer(t);
    const second = await createCustomer(t);
    const ticketA = await createTicket(t, { customer: first, state: 'resolved' });
    const ticketB = await createTicket(t, { customer: second, state: 'closed' });

    const idA = ratingOfferId(t.id, ticketA.id);
    expect((await asUser(first).put(`/customer/ratings/${idA}`, { score: 2 })).status).toBe(204);
    expect((await asUser(first).put(`/customer/ratings/${idA}`, { score: 5 })).status).toBe(204);
    // A closed conversation can still be rated with its id.
    expect((await asUser(second).put(`/customer/ratings/${ratingOfferId(t.id, ticketB.id)}`, { score: 4 })).status).toBe(204);

    expect(((await asUser(admin).get(`/tickets/${ticketA.id}`)).body as { csat: { score: number } }).csat.score).toBe(5);
    expect(((await asUser(admin).get('/dashboard')).body as DashboardBody).satisfaction).toEqual({ average: 4.5, responses: 2 });
  });

  it('skipping hides the offer, leaves the ticket unrated and never counts; a later rating still works', async () => {
    const customer = await createCustomer(tenant);
    const admin = await createUser(tenant, { roles: ['admin'] });
    const ticket = await createTicket(tenant, { customer, state: 'resolved' });

    const offer = await pendingRating(customer);
    expect((await asUser(customer).put(`/customer/ratings/${offer!.ratingId}`, { skip: true })).status).toBe(204);
    expect(await pendingRating(customer)).toBeNull();
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as { csat: unknown }).csat).toBeNull();

    expect((await asUser(customer).put(`/customer/ratings/${offer!.ratingId}`, { score: 3 })).status).toBe(204);
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as { csat: { score: number } }).csat.score).toBe(3);
    // Skipping after rating keeps the rating.
    expect((await asUser(customer).put(`/customer/ratings/${offer!.ratingId}`, { skip: true })).status).toBe(204);
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as { csat: { score: number } }).csat.score).toBe(3);
  });

  it('offers nothing while a newer conversation is active or the latest one was never resolved', async () => {
    const customer = await createCustomer(tenant);
    await createTicket(tenant, { customer, state: 'resolved' });
    await createTicket(tenant, { customer, state: 'open' });
    expect(await pendingRating(customer)).toBeNull();

    const fresh = await createCustomer(tenant);
    await createTicket(tenant, { customer: fresh, state: 'new' });
    expect(await pendingRating(fresh)).toBeNull();
  });

  it("only the ticket's own customer can rate: another customer, another tenant's customer and a staff session get 404", async () => {
    const owner = await createCustomer(tenant);
    const stranger = await createCustomer(tenant);
    const ticket = await createTicket(tenant, { customer: owner, state: 'resolved' });
    const id = ratingOfferId(tenant.id, ticket.id);

    const asStranger = await asUser(stranger).put(`/customer/ratings/${id}`, { score: 1 });
    const unknown = await asUser(stranger).put(`/customer/ratings/${uuidv7()}`, { score: 1 });
    expect(asStranger.status).toBe(404);
    expect(asStranger.body).toEqual(unknown.body);

    const elsewhere = await createCustomer(other);
    expect((await asUser(elsewhere).put(`/customer/ratings/${id}`, { score: 1 })).status).toBe(404);

    const admin = await createUser(tenant, { roles: ['admin'] });
    expect((await asUser(admin).put(`/customer/ratings/${id}`, { score: 1 })).status).toBe(404);
    expect(await pendingRating(owner)).not.toBeNull();
  });

  it('refuses scores outside 1–5, long comments and unknown keys (400)', async () => {
    const customer = await createCustomer(tenant);
    const ticket = await createTicket(tenant, { customer, state: 'resolved' });
    const id = ratingOfferId(tenant.id, ticket.id);
    for (const body of [{ score: 0 }, { score: 6 }, { score: 2.5 }, { score: 3, comment: 'x'.repeat(1001) }, { score: 3, extra: true }, { skip: false }, {}]) {
      expect((await asUser(customer).put(`/customer/ratings/${id}`, body)).status).toBe(400);
    }
  });
});

describe('customer profile limited by access (US16 scenario 2)', () => {
  it('the profile figure, the history and the dashboard count only tickets in groups the caller can view', async () => {
    const t = await createTenant();
    const [billing, shipping] = await Promise.all([createGroup(t, { name: 'Billing' }), createGroup(t, { name: 'Shipping' })]);
    const role = await createRole(t, { permissions: ['ticket.view', 'user.view', 'dashboard.view'], groups: [{ group: billing.id, flags: { view: true, edit: false } }] });
    const agent = await createUser(t, { roles: [{ id: role.id }] });
    const admin = await createUser(t, { roles: ['admin'] });
    const customer = await createCustomer(t);

    const visible = await createTicket(t, { customer, group: billing.id, state: 'closed', messages: [{ body: 'Billing question' }] });
    const hidden = await createTicket(t, { customer, group: shipping.id, state: 'closed', messages: [{ body: 'Shipping question' }] });
    await asUser(customer).put(`/customer/ratings/${ratingOfferId(t.id, visible.id)}`, { score: 5 });
    await asUser(customer).put(`/customer/ratings/${ratingOfferId(t.id, hidden.id)}`, { score: 1 });

    const asAgent = (await asUser(agent).get(`/customers/${customer.id}`)).body as ProfileBody;
    expect(asAgent.satisfaction).toEqual({ average: 5, responses: 1 });
    const asAdmin = (await asUser(admin).get(`/customers/${customer.id}`)).body as ProfileBody;
    expect(asAdmin.satisfaction).toEqual({ average: 3, responses: 2 });

    const history = (await asUser(agent).get(`/customers/${customer.id}/messages`)).body as HistoryBody;
    expect(history.items.map((item) => item.body)).toEqual(['Billing question']);
    expect(history.items[0]).toMatchObject({ ticketId: visible.id, ticketNumber: visible.number });

    expect(((await asUser(agent).get('/dashboard')).body as DashboardBody).satisfaction).toEqual({ average: 5, responses: 1 });
  });
});

describe('GET /customers/{id}/messages', () => {
  it('pages the full history newest first, including internal notes, across tickets', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createCustomer(tenant);
    const now = (await getTestApp()).clock.now();
    await createTicket(tenant, { customer, state: 'closed', now: new Date(now.getTime() - 60_000), messages: [{ body: 'First ticket' }] });
    await createTicket(tenant, {
      customer,
      state: 'open',
      messages: [{ body: 'Second ticket' }, { body: 'A note', staff: admin, visibility: 'internal' }, { body: 'Our reply', staff: admin }],
    });

    const first = await asUser(admin).get(`/customers/${customer.id}/messages?limit=2`);
    expect(first.status).toBe(200);
    const page1 = first.body as HistoryBody;
    expect(page1.items.map((item) => item.body)).toEqual(['Our reply', 'A note']);
    expect(page1.items[1]?.visibility).toBe('internal');
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await asUser(admin).get(`/customers/${customer.id}/messages?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)).body as HistoryBody;
    expect(page2.items.map((item) => item.body)).toEqual(['Second ticket', 'First ticket']);
    expect(page2.nextCursor).toBeNull();
  });

  it('403 without user.view, 404 for an unknown or staff id, 404 from another tenant', async () => {
    const customer = await createCustomer(tenant);
    const noView = await createRole(tenant, { permissions: ['ticket.view'] });
    const agent = await createUser(tenant, { roles: [{ id: noView.id }] });
    expect((await asUser(agent).get(`/customers/${customer.id}/messages`)).status).toBe(403);

    const admin = await createUser(tenant, { roles: ['admin'] });
    expect((await asUser(admin).get(`/customers/${uuidv7()}/messages`)).status).toBe(404);
    expect((await asUser(admin).get(`/customers/${admin.id}/messages`)).status).toBe(404);

    const otherAdmin = await createUser(other, { roles: ['admin'] });
    const cross = await asUser(otherAdmin).get(`/customers/${customer.id}/messages`);
    const unknown = await asUser(otherAdmin).get(`/customers/${uuidv7()}/messages`);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
  });
});
