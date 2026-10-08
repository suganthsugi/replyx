import { describe, expect, it } from 'vitest';

import { createCustomer } from '../../support/customer-profiles.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * `GET /search` (T232; contracts/tickets.yaml, search.service.ts, migration 0015). Triad first, then
 * each matching field, access limits, internal notes, paging and validation.
 */

interface TicketHit {
  type: 'ticket';
  ticket: { id: string; number: number; title: string };
  highlight?: string;
}
interface CustomerHit {
  type: 'customer';
  customer: { id: string; name: string };
  email: string;
}
type Hit = TicketHit | CustomerHit;
interface SearchBody {
  items: Hit[];
  nextCursor: string | null;
}

const failure = (response: { body: unknown }) => response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

async function search(user: TestUser, query: string): Promise<{ status: number; body: SearchBody }> {
  const response = await asUser(user).get(`/search?${query}`);
  return { status: response.status, body: response.body as SearchBody };
}

const q = (text: string, extra = '') => `q=${encodeURIComponent(text)}${extra}`;
const ticketIds = (body: SearchBody) => body.items.filter((hit): hit is TicketHit => hit.type === 'ticket').map((hit) => hit.ticket.id);
const customerIds = (body: SearchBody) => body.items.filter((hit): hit is CustomerHit => hit.type === 'customer').map((hit) => hit.customer.id);

async function setup(): Promise<{ tenant: TestTenant; admin: TestUser; customer: TestUser }> {
  const tenant = await createTenant();
  const admin = await createUser(tenant, { roles: ['admin'] });
  const customer = await createUser(tenant, { roles: ['customer'] });
  return { tenant, admin, customer };
}

describe('GET /search triad', () => {
  it('returns matching tickets with a highlight (success)', async () => {
    const { tenant, admin, customer } = await setup();
    const ticket = await createTicket(tenant, { customer, title: 'Zebrafish invoice', messages: [{ body: 'hello' }] });
    const response = await search(admin, q('zebrafish'));
    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      type: 'ticket',
      ticket: { id: ticket.id, number: ticket.number, title: 'Zebrafish invoice' },
      highlight: '⟦Zebrafish⟧ invoice',
    });
  });

  it('is PERMISSION_DENIED without ticket.view (403)', async () => {
    const { tenant } = await setup();
    const role = await createRole(tenant, { permissions: ['tag.view'] });
    const nobody = await createUser(tenant, { roles: [{ id: role.id }] });
    const response = await asUser(nobody).get('/search?q=anything');
    expect(response.status).toBe(403);
    expect(failure(response).error.code).toBe('PERMISSION_DENIED');
  });

  it('never returns tenant A rows to a tenant B user who has the permission', async () => {
    const { tenant, customer } = await setup();
    const ticket = await createTicket(tenant, { customer, title: 'Zebrafish invoice', messages: [{ body: 'zebrafish body' }] });
    const other = await createTenant();
    const otherAdmin = await createUser(other, { roles: ['admin'] });
    const otherCustomer = await createUser(other, { roles: ['customer'] });
    const own = await createTicket(other, { customer: otherCustomer, title: 'Zebrafish elsewhere' });

    for (const query of [q('zebrafish'), q(String(ticket.number)), q(customer.email), q(customer.name)]) {
      const response = await search(otherAdmin, query);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(ticket.id);
      expect(JSON.stringify(response.body)).not.toContain(customer.id);
    }
    expect(ticketIds((await search(otherAdmin, q('zebrafish'))).body)).toEqual([own.id]);
  });

  it('is not available to customers (404)', async () => {
    const { customer } = await setup();
    const response = await asUser(customer).get('/search?q=anything');
    expect(response.status).toBe(404);
    expect(failure(response).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /search matching', () => {
  it('finds a ticket by number with and without #', async () => {
    const { tenant, admin, customer } = await setup();
    const ticket = await createTicket(tenant, { customer, title: 'Unrelated words' });
    for (const text of [String(ticket.number), `#${ticket.number}`]) {
      expect(ticketIds((await search(admin, q(text))).body), text).toContain(ticket.id);
    }
  });

  it('finds title words and prefixes, case-insensitively', async () => {
    const { tenant, admin, customer } = await setup();
    const ticket = await createTicket(tenant, { customer, title: 'Printer Spooler crashes' });
    for (const text of ['spooler', 'PRINTER', 'spool', 'print crash']) {
      expect(ticketIds((await search(admin, q(text))).body), text).toEqual([ticket.id]);
    }
    expect(ticketIds((await search(admin, q('scanner'))).body)).toEqual([]);
  });

  it('matches without regard to accents, in both directions', async () => {
    const { tenant, admin, customer } = await setup();
    const cafe = await createTicket(tenant, { customer, title: 'Café refund' });
    const plain = await createTicket(tenant, { customer, title: 'Resume upload' });
    const jose = await createCustomer(tenant, { name: 'José Álvarez' });
    expect(ticketIds((await search(admin, q('cafe'))).body)).toEqual([cafe.id]);
    expect(ticketIds((await search(admin, q('café'))).body)).toEqual([cafe.id]);
    expect(ticketIds((await search(admin, q('résumé'))).body)).toEqual([plain.id]);
    expect(customerIds((await search(admin, q('jose alvarez', '&type=customers'))).body)).toEqual([jose.id]);
  });

  it('finds message bodies and highlights the match', async () => {
    const { tenant, admin, customer } = await setup();
    const staff = await createUser(tenant, { roles: ['agent'] });
    const ticket = await createTicket(tenant, {
      customer,
      title: 'Plain title',
      messages: [{ body: 'My router keeps rebooting overnight' }, { body: 'Please try firmware 2.1', staff }],
    });
    const response = await search(admin, q('rebooting'));
    expect(ticketIds(response.body)).toEqual([ticket.id]);
    expect((response.body.items[0] as TicketHit).highlight).toContain('⟦rebooting⟧');
    expect(ticketIds((await search(admin, q('firmw'))).body)).toEqual([ticket.id]);
  });

  it('finds tickets by tag name and the customers carrying the tag', async () => {
    const { tenant, admin, customer } = await setup();
    const tagged = await createTicket(tenant, { customer, title: 'Tagged ticket' });
    await createTicket(tenant, { customer, title: 'Untagged ticket' });
    const tag = (await asUser(admin).post('/tags', { name: 'Enterprise' })).body as { id: string };
    expect((await asUser(admin).patch(`/tickets/${tagged.id}`, { tagIds: [tag.id] })).status).toBe(200);
    const tagCustomer = await createCustomer(tenant, { name: 'Tagged Person' });
    expect((await asUser(admin).patch(`/customers/${tagCustomer.id}`, { tagIds: [tag.id] })).status).toBe(200);

    const response = await search(admin, q('enterprise'));
    expect(ticketIds(response.body)).toEqual([tagged.id]);
    expect(customerIds(response.body)).toEqual([tagCustomer.id]);
  });

  it('finds tickets by customer name and email, and customers by name and email', async () => {
    const { tenant, admin } = await setup();
    const alice = await createCustomer(tenant, { name: 'Alicia Wonderland', email: 'alicia.w@wonder.test' });
    const bob = await createCustomer(tenant, { name: 'Bob Builder', email: 'bob@builder.test' });
    const aliceTicket = await createTicket(tenant, { customer: alice, title: 'Something' });
    await createTicket(tenant, { customer: bob, title: 'Something else' });

    for (const text of ['wonderland', 'alicia.w@wonder']) {
      const response = await search(admin, q(text));
      expect(ticketIds(response.body), text).toEqual([aliceTicket.id]);
      expect(customerIds(response.body), text).toEqual([alice.id]);
    }
    const onlyCustomers = await search(admin, q('builder', '&type=customers'));
    expect(onlyCustomers.body.items).toHaveLength(1);
    expect(onlyCustomers.body.items[0]).toMatchObject({ type: 'customer', customer: { id: bob.id, name: 'Bob Builder' }, email: 'bob@builder.test' });
    const onlyTickets = await search(admin, q('builder', '&type=tickets'));
    expect(ticketIds(onlyTickets.body)).toHaveLength(1);
    expect(customerIds(onlyTickets.body)).toEqual([]);
  });

  it('treats LIKE wildcards in the query as plain text', async () => {
    const { tenant, admin } = await setup();
    await createCustomer(tenant, { name: 'Percent Person' });
    expect((await search(admin, q('%', '&type=customers'))).body.items).toEqual([]);
    expect((await search(admin, q('_', '&type=customers'))).body.items).toEqual([]);
  });
});

describe('GET /search access', () => {
  it('leaves out tickets in groups the caller cannot view', async () => {
    const { tenant, customer } = await setup();
    const visible = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true } }] });
    const hidden = await createGroup(tenant);
    const agent = await createUser(tenant, { roles: ['agent'] });
    const inVisible = await createTicket(tenant, { customer, group: visible.id, title: 'Quokka in visible group' });
    await createTicket(tenant, { customer, group: hidden.id, title: 'Quokka in hidden group' });
    await createTicket(tenant, { customer, title: 'Quokka ungrouped' });

    expect(ticketIds((await search(agent, q('quokka'))).body)).toEqual([inVisible.id]);
  });

  it('shows internal note text only to staff with access to that ticket group', async () => {
    const { tenant, admin, customer } = await setup();
    const noteGroup = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true } }] });
    const otherGroup = await createGroup(tenant);
    const withAccess = await createUser(tenant, { roles: ['agent'] });
    const restricted = await createRole(tenant, { permissions: ['ticket.view'], groups: [{ group: otherGroup.id, flags: { view: true } }] });
    const withoutAccess = await createUser(tenant, { roles: [{ id: restricted.id }] });

    const noted = await createTicket(tenant, {
      customer,
      group: noteGroup.id,
      title: 'Plain subject',
      messages: [{ body: 'Hi there' }, { body: 'secret wombat remark', staff: admin, visibility: 'internal' }],
    });

    expect(ticketIds((await search(admin, q('wombat'))).body)).toEqual([noted.id]);
    expect(ticketIds((await search(withAccess, q('wombat'))).body)).toEqual([noted.id]);
    expect((await search(withoutAccess, q('wombat'))).body.items).toEqual([]);
  });

  it('returns customers only to callers with user.view', async () => {
    const { tenant, admin, customer } = await setup();
    const agent = await createUser(tenant, { roles: ['agent'] });

    expect(customerIds((await search(admin, q(customer.email))).body)).toEqual([customer.id]);
    const asAgent = await search(agent, q(customer.email));
    expect(asAgent.status).toBe(200);
    expect(customerIds(asAgent.body)).toEqual([]);
    expect((await search(agent, q(customer.email, '&type=customers'))).body.items).toEqual([]);
  });

  it('excludes staff users from customer results', async () => {
    const { tenant, admin } = await setup();
    const staff = await createUser(tenant, { roles: ['agent'], name: 'Unique Staffer Name' });
    expect(customerIds((await search(admin, q('Unique Staffer Name', '&type=customers'))).body)).not.toContain(staff.id);
  });
});

describe('GET /search paging', () => {
  it('pages tickets then customers with a cursor, without gaps or repeats', async () => {
    const { tenant, admin, customer } = await setup();
    const created: string[] = [];
    for (let i = 0; i < 4; i += 1) created.push((await createTicket(tenant, { customer, title: `Narwhal report ${i}` })).id);
    const people = [await createCustomer(tenant, { name: 'Narwhal One' }), await createCustomer(tenant, { name: 'Narwhal Two' })];

    const seen: Hit[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const extra: string = `&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await search(admin, q('narwhal', extra));
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items);
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(cursor).toBeNull();
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen.map((hit) => hit.type)).toEqual(['ticket', 'ticket', 'ticket', 'ticket', 'customer', 'customer']);
    expect(seen.filter((hit): hit is TicketHit => hit.type === 'ticket').map((hit) => hit.ticket.id)).toEqual([...created].reverse());
    expect(new Set(seen.filter((hit): hit is CustomerHit => hit.type === 'customer').map((hit) => hit.customer.id))).toEqual(new Set(people.map((p) => p.id)));
  });

  it('pages customers alone', async () => {
    const { tenant, admin } = await setup();
    for (const n of ['A', 'B', 'C']) await createCustomer(tenant, { name: `Platypus ${n}` });
    const first = await search(admin, q('platypus', '&type=customers&limit=2'));
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await search(admin, q('platypus', `&type=customers&limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`));
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...customerIds(first.body), ...customerIds(second.body)]).size).toBe(3);
  });
});

describe('GET /search validation', () => {
  it.each([
    ['missing q', ''],
    ['empty q', 'q='],
    ['blank q', 'q=%20%20'],
    ['too long q', `q=${'a'.repeat(201)}`],
    ['unknown type', 'q=a&type=users'],
    ['limit zero', 'q=a&limit=0'],
    ['unknown parameter', 'q=a&sort=asc'],
  ])('rejects %s with 400 VALIDATION_FAILED', async (_name, query) => {
    const { admin } = await setup();
    const response = await asUser(admin).get(`/search?${query}`);
    expect(response.status).toBe(400);
    expect(failure(response).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed cursor with 400', async () => {
    const { admin } = await setup();
    const response = await asUser(admin).get('/search?q=a&cursor=not-a-cursor');
    expect(response.status).toBe(400);
  });

  it('answers punctuation-only text with an empty page instead of an error', async () => {
    const { admin } = await setup();
    const response = await search(admin, q('&&&'));
    expect(response.status).toBe(200);
  });
});

describe('GET /search query text that unaccent turns into tsquery syntax', () => {
  it.each([
    ['one-half', '½'],
    ['parenthesised digit', '⑴'],
    ['modifier apostrophe', 'ʼ'],
    ['mixed with a word', 'invoice ½ ⑴'],
  ])('answers %s with 200 instead of a 500', async (_name, text) => {
    const { admin } = await setup();
    const response = await search(admin, q(text));
    expect(response.status).toBe(200);
  });

  it('finds a title containing such characters', async () => {
    const { tenant, admin, customer } = await setup();
    const ticket = await createTicket(tenant, { customer, title: 'Quokka ½ shipment' });
    expect(ticketIds((await search(admin, q('quokka ½'))).body)).toEqual([ticket.id]);
  });

  it('does not substring-match customers on a single character', async () => {
    const { tenant, admin } = await setup();
    await createCustomer(tenant, { name: 'Xavier Single' });
    expect((await search(admin, q('x', '&type=customers'))).body.items).toEqual([]);
  });

  it('rejects a cursor from the customers phase on a tickets-only search with 400', async () => {
    const { tenant, admin } = await setup();
    for (const n of ['A', 'B', 'C']) await createCustomer(tenant, { name: `Wombat ${n}` });
    const first = await search(admin, q('wombat', '&type=customers&limit=2'));
    const cursor = first.body.nextCursor as string;
    const response = await asUser(admin).get(`/search?${q('wombat', `&type=tickets&cursor=${encodeURIComponent(cursor)}`)}`);
    expect(response.status).toBe(400);
    expect(failure(response).error.details).toEqual([{ path: 'cursor', issue: 'invalid_cursor' }]);
  });
});
