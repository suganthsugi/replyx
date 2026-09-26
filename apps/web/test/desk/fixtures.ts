import { http, HttpResponse } from 'msw';

import { API, errorResponse } from '../msw/handlers';

import type {
  CustomerProfile,
  EligibleOwner,
  Group,
  ListTicketHistory200,
  ListTickets200,
  ListTicketMessages200,
  Me,
  Message,
  TagRef,
  Ticket,
  TicketSummary,
  User,
  View,
} from '../../src/api/generated/model';

/**
 * Shared fixtures and MSW handler builders for T156's desk component tests. Bodies are typed with
 * the orval-generated models (web-testing rule 5); each `*Handler` answers one endpoint the
 * `data/*` hooks under test call, so a story only wires the endpoints it needs.
 */

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    id: 'agent-1',
    email: 'agent@acme.test',
    name: 'Ada Agent',
    kind: 'staff',
    roles: [{ id: 'role-agent', name: 'Agent' }],
    permissions: ['ticket.view', 'ticket.edit', 'tag.create', 'user.edit'],
    groupAccess: [{ groupId: 'group-1', view: true, create: true, edit: true, delete: true }],
    accessVersion: 1,
    ...overrides,
  };
}

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1',
    number: 1234,
    title: 'Cannot reset my password',
    state: 'open',
    priority: 'normal',
    waitingOn: 'support',
    group: { id: 'group-1', name: 'Support' },
    owner: { id: 'agent-1', name: 'Ada Agent' },
    customer: { id: 'customer-1', name: 'Cara Customer' },
    tags: [],
    sla: { status: 'ok' },
    lastCustomerMessageAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    pendingUntil: null,
    autoCloseAt: null,
    resolvedAt: null,
    closedAt: null,
    lastAgentReplyAt: null,
    origin: 'customer_message',
    mergedInto: null,
    links: [],
    csat: null,
    allowedActions: ['reply', 'note', 'edit', 'change_group', 'assign', 'delete'],
    ...overrides,
  };
}

export function makeTicketSummary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 'ticket-1',
    number: 1234,
    title: 'Cannot reset my password',
    state: 'open',
    priority: 'normal',
    waitingOn: 'support',
    group: { id: 'group-1', name: 'Support' },
    owner: { id: 'agent-1', name: 'Ada Agent' },
    customer: { id: 'customer-1', name: 'Cara Customer' },
    tags: [],
    sla: { status: 'ok' },
    lastCustomerMessageAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    ticketId: 'ticket-1',
    author: { id: 'customer-1', name: 'Cara Customer' },
    authorKind: 'customer',
    visibility: 'public',
    body: 'My password reset link expired.',
    mentions: [],
    attachments: [],
    clientMessageId: null,
    deliveredAt: null,
    readAt: null,
    movedFromTicketId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeView(overrides: Partial<View> = {}): View {
  return {
    id: 'view-1',
    name: 'My open tickets',
    description: null,
    visibility: 'all_staff',
    sharedRoleIds: [],
    sharedGroupIds: [],
    conditions: { op: 'and', items: [] },
    sort: [],
    columns: [],
    system: null,
    count: 3,
    position: 0,
    hidden: false,
    editable: true,
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<Group> = {}): Group {
  return { id: 'group-1', name: 'Support', status: 'active', openTicketCount: 2, ...overrides };
}

export function makeEligibleOwner(overrides: Partial<EligibleOwner> = {}): EligibleOwner {
  return { id: 'agent-1', name: 'Ada Agent', availability: 'online', openTicketCount: 2, ...overrides };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return { id: 'customer-1', email: 'cara@customer.test', name: 'Cara Customer', kind: 'customer', status: 'active', roles: [], ...overrides };
}

export function makeTag(overrides: Partial<TagRef> = {}): TagRef {
  return { id: 'tag-1', name: 'billing', ...overrides };
}

export function makeCustomerProfile(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return {
    id: 'customer-1',
    name: 'Cara Customer',
    email: 'cara@customer.test',
    status: 'active',
    phone: null,
    company: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: null,
    openTickets: [],
    closedTickets: [],
    ...overrides,
  };
}

export function meHandler(me: Me) {
  return http.get(`${API}/me`, () => HttpResponse.json<Me>(me));
}

export function ticketHandler(ticket: Ticket) {
  return http.get(`${API}/tickets/${ticket.id}`, () => HttpResponse.json<Ticket>(ticket));
}

export function messagesHandler(ticketId: string, items: Message[]) {
  return http.get(`${API}/tickets/${ticketId}/messages`, () =>
    HttpResponse.json<ListTicketMessages200>({ items, nextCursor: null }),
  );
}

export function historyHandler(ticketId: string, items: ListTicketHistory200['items'] = []) {
  return http.get(`${API}/tickets/${ticketId}/history`, () => HttpResponse.json<ListTicketHistory200>({ items, nextCursor: null }));
}

export function groupsHandler(groups: Group[]) {
  return http.get(`${API}/groups`, () => HttpResponse.json<{ items: Group[] }>({ items: groups }));
}

export function eligibleOwnersHandler(groupId: string, owners: EligibleOwner[]) {
  return http.get(`${API}/groups/${groupId}/eligible-owners`, () => HttpResponse.json<{ items: EligibleOwner[] }>({ items: owners }));
}

export function tagsHandler(tags: TagRef[]) {
  return http.get(`${API}/tags`, () => HttpResponse.json<{ items: TagRef[] }>({ items: tags }));
}

export function usersHandler(users: User[]) {
  return http.get(`${API}/users`, () => HttpResponse.json<{ items: User[]; nextCursor: string | null }>({ items: users, nextCursor: null }));
}

export function viewsHandler(views: View[]) {
  return http.get(`${API}/views`, () => HttpResponse.json<{ items: View[] }>({ items: views }));
}

export function ticketsHandler(items: TicketSummary[]) {
  return http.get(`${API}/tickets`, () => HttpResponse.json<ListTickets200>({ items, nextCursor: null }));
}

export function customerHandler(profile: CustomerProfile) {
  return http.get(`${API}/customers/${profile.id}`, () => HttpResponse.json<CustomerProfile>(profile));
}

export { errorResponse };
