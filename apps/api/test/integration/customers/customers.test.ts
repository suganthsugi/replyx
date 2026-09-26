import { beforeAll, describe, expect, it } from 'vitest';

import { getTestApp } from '../../support/app.js';
import { createCustomer } from '../../support/customer-profiles.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Test } from 'supertest';

/**
 * `/customers/{id}` (T146; contracts/tickets.yaml `CustomerProfile`, customers.service.ts). Every
 * endpoint gets the triad: success, 403 without the permission, cross-tenant 404 equal to the
 * unknown-id body (testing-conventions rule 6).
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';

interface TicketSummaryBody {
  id: string;
  state: string;
}
interface CustomerBody {
  id: string;
  name: string;
  email: string;
  status: string;
  phone: string | null;
  company: string | null;
  tags: { id: string; name: string }[];
  openTickets: TicketSummaryBody[];
  closedTickets: TicketSummaryBody[];
}

const body = <T>(response: { body: unknown }) => response.body as T;

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
}

let a: TestTenant;
let b: TestTenant;
// The system Manager role has user.view but not user.edit; Agent has neither (data-model default seed).
let viewer: TestUser;
let bystander: TestUser;
let adminA: TestUser;
let adminB: TestUser;

beforeAll(async () => {
  await getTestApp();
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  [viewer, bystander, adminA, adminB] = await Promise.all([
    createUser(a, { roles: ['manager'] }),
    createUser(a, { roles: ['agent'] }),
    createUser(a, { roles: ['admin'] }),
    createUser(b, { roles: ['admin'] }),
  ]);
});

describe('GET /customers/{id}', () => {
  it('shows contact details, tags and tickets limited to the caller\'s access (success)', async () => {
    const customer = await createCustomer(a, { name: 'Ada Customer', phone: '555-0100', company: 'Acme' });
    const group = await createGroup(a, { access: [{ role: 'manager', flags: { view: true } }] });
    const hidden = await createGroup(a);
    await createTicket(a, { customer, group: group.id, state: 'open' });
    await createTicket(a, { customer, group: group.id, state: 'closed' });
    const invisible = await createTicket(a, { customer, group: hidden.id, state: 'open' });

    const response = await asUser(viewer).get(`/customers/${customer.id}`);
    expect(response.status).toBe(200);
    const profile = body<CustomerBody>(response);
    expect(profile).toMatchObject({ id: customer.id, name: 'Ada Customer', phone: '555-0100', company: 'Acme', tags: [] });
    expect(profile.openTickets).toHaveLength(1);
    expect(profile.closedTickets).toHaveLength(1);
    expect(JSON.stringify(profile)).not.toContain(invisible.id);
  });

  it('needs user.view (403)', async () => {
    const customer = await createCustomer(a);
    expect((await asUser(bystander).get(`/customers/${customer.id}`)).status).toBe(403);
  });

  it('is a 404 for another tenant\'s customer (cross-tenant)', async () => {
    const customer = await createCustomer(a);
    await expectCrossTenant404((id) => asUser(adminB).get(`/customers/${id}`), customer.id);
  });
});

describe('PATCH /customers/{id}', () => {
  it('changes contact details and the tag set (success)', async () => {
    const customer = await createCustomer(a, { name: 'Original name' });
    const tag = await asUser(adminA).post('/tags', { name: 'Escalated' });

    const response = await asUser(adminA).patch(`/customers/${customer.id}`, {
      name: 'Updated name',
      phone: '555-0199',
      company: 'New co',
      tagIds: [(tag.body as { id: string }).id],
    });
    expect(response.status).toBe(200);
    const profile = body<CustomerBody>(response);
    expect(profile).toMatchObject({ name: 'Updated name', phone: '555-0199', company: 'New co' });
    expect(profile.tags.map((t) => t.name)).toEqual(['Escalated']);
  });

  it('treats an unknown tag id as 404 TAG_NOT_FOUND', async () => {
    const customer = await createCustomer(a);
    const response = await asUser(adminA).patch(`/customers/${customer.id}`, { tagIds: [UNKNOWN_ID] });
    expect(response.status).toBe(404);
  });

  it('needs user.edit (403 — a viewer with only user.view is refused)', async () => {
    const customer = await createCustomer(a);
    expect((await asUser(viewer).patch(`/customers/${customer.id}`, { name: 'Nope' })).status).toBe(403);
  });

  it('is a 404 for another tenant\'s customer (cross-tenant)', async () => {
    const customer = await createCustomer(a);
    await expectCrossTenant404((id) => asUser(adminB).patch(`/customers/${id}`, { name: 'x' }), customer.id);
  });
});
