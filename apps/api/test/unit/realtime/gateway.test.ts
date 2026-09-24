import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/platform-kernel/http/app-error.js';
import { CustomerGateway, RealtimeAuth, StaffGateway } from '../../../src/platform-kernel/realtime/gateway.js';
import {
  errorAck,
  sessionRoom,
  tenantRoom,
  type RealtimeSocket,
} from '../../../src/platform-kernel/realtime/socket-context.js';
import { StreamAccess } from '../../../src/platform-kernel/realtime/stream-access.js';

import type { EffectiveAccess, GroupFlags } from '../../../src/authorization/policy.service.js';

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';
const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const SUPPORT = '0192f3c4-0000-7000-8000-0000000000b1';
const TICKET = '0192f3c4-0000-7000-8000-0000000000d1';
const TOKEN = 'a'.repeat(43);

const tenant = { id: TENANT, slug: 'acme', status: 'active' as const };
const principal = { sessionId: 's1', tenantId: TENANT, userId: USER, kind: 'staff' as const, trustedDevice: false, expiresAt: 0 };

function auth(resolution: unknown, result: unknown = principal) {
  const tenants = { resolve: vi.fn(() => (resolution instanceof Error ? Promise.reject(resolution) : Promise.resolve(resolution))) };
  const sessions = { authenticate: vi.fn(() => Promise.resolve(result)) };
  return { auth: new RealtimeAuth(tenants as never, sessions as never), sessions };
}
const handshake = (cookie?: string) => ({ headers: { host: 'acme.localhost', ...(cookie === undefined ? {} : { cookie }) } });

describe('RealtimeAuth', () => {
  it('authenticates the session against the host tenant and audience', async () => {
    const { auth: a, sessions } = auth({ kind: 'tenant', tenant });
    await expect(a.authenticate(handshake(`rx_session=${TOKEN}`), 'staff')).resolves.toEqual({
      tenantId: TENANT,
      userId: USER,
      sessionId: 's1',
      kind: 'staff',
    });
    expect(sessions.authenticate).toHaveBeenCalledWith(TENANT, TOKEN);
  });

  it('rejects the wrong audience, unknown hosts, the console host and missing sessions', async () => {
    const cases: (() => Promise<unknown>)[] = [
      () => auth({ kind: 'tenant', tenant }).auth.authenticate(handshake(`rx_session=${TOKEN}`), 'customer'),
      () => auth(new Error('unknown')).auth.authenticate(handshake(`rx_session=${TOKEN}`), 'staff'),
      () => auth({ kind: 'console' }).auth.authenticate(handshake(`rx_session=${TOKEN}`), 'staff'),
      () => auth({ kind: 'tenant', tenant }, null).auth.authenticate(handshake(), 'staff'),
      () => auth({ kind: 'tenant', tenant }, { ...principal, tenantId: 'other' }).auth.authenticate(handshake(`rx_session=${TOKEN}`), 'staff'),
    ];
    for (const attempt of cases) {
      await expect(attempt()).rejects.toMatchObject({ data: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('refuses suspended tenants with TENANT_SUSPENDED', async () => {
    const { auth: a } = auth({ kind: 'tenant', tenant: { ...tenant, status: 'suspended' } });
    await expect(a.authenticate(handshake(`rx_session=${TOKEN}`), 'staff')).rejects.toMatchObject({
      data: { code: 'TENANT_SUSPENDED' },
    });
  });
});

function access(groups: [string | null, Partial<GroupFlags>][]): EffectiveAccess {
  const none = { view: false, create: false, edit: false, delete: false };
  return {
    userId: USER,
    accessVersion: '0',
    permissions: new Set(['ticket.view']),
    groups: new Map(groups.map(([id, f]) => [id, { ...none, ...f }])),
  };
}

function staffGateway(groupOf?: (id: string) => Promise<string | null | undefined>, groups: [string | null, Partial<GroupFlags>][] = []) {
  const policy = { effectiveAccess: vi.fn(() => Promise.resolve(access(groups))) };
  const tickets = groupOf === undefined ? undefined : { groupOf: vi.fn((_ctx: unknown, id: string) => groupOf(id)) };
  const streams = new StreamAccess(policy as never, tickets);
  return new StaffGateway({} as never, policy as never, {} as never, { wsConnections: { add: vi.fn() } } as never, streams, {} as never, {} as never);
}

function socket(kind: 'staff' | 'customer' = 'staff') {
  const joined: string[] = [];
  const s = {
    id: 'sock1',
    data: { tenantId: TENANT, userId: USER, sessionId: 's1', kind },
    join: vi.fn((rooms: string | string[]) => {
      joined.push(...(Array.isArray(rooms) ? rooms : [rooms]));
      return Promise.resolve();
    }),
    leave: vi.fn(() => Promise.resolve()),
  };
  return { socket: s as unknown as RealtimeSocket, joined, raw: s };
}

describe('StaffGateway', () => {
  it('joins control, user, views and viewable group rooms on connect', async () => {
    const { socket: s, joined } = socket();
    await staffGateway(undefined, [[SUPPORT, { view: true }], [null, { view: true }]]).handleConnection(s);
    expect(joined).toEqual([
      tenantRoom(TENANT),
      sessionRoom(TENANT, 's1'),
      `t:${TENANT}:user:${USER}`,
      `t:${TENANT}:views:${USER}`,
      `t:${TENANT}:tickets:group:${SUPPORT}`,
      `t:${TENANT}:tickets:group:ungrouped`,
    ]);
  });

  it('joins a ticket room only when the ticket is viewable, else NOT_FOUND', async () => {
    const gateway = staffGateway((id) => Promise.resolve(id === TICKET ? SUPPORT : undefined), [[SUPPORT, { view: true }]]);
    const { socket: s, joined } = socket();
    await expect(gateway.subscribe(s, { stream: `ticket:${TICKET}` })).resolves.toEqual({ ok: true });
    expect(joined).toEqual([`t:${TENANT}:ticket:${TICKET}`]);

    const hidden = staffGateway(() => Promise.resolve(null), [[SUPPORT, { view: true }]]);
    const notFound = { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } };
    await expect(hidden.subscribe(socket().socket, { stream: `ticket:${TICKET}` })).resolves.toEqual(notFound);
    await expect(gateway.subscribe(socket().socket, { stream: 'ticket:0192f3c4-0000-7000-8000-0000000000d2' })).resolves.toEqual(notFound);
    await expect(staffGateway().subscribe(socket().socket, { stream: `ticket:${TICKET}` })).resolves.toEqual(notFound);
    await expect(gateway.subscribe(socket().socket, { stream: `conversation:${USER}` })).resolves.toEqual(notFound);
    await expect(gateway.subscribe(socket().socket, 'garbage')).resolves.toEqual(notFound);
  });

  it('treats user and views as already joined', async () => {
    await expect(staffGateway().subscribe(socket().socket, { stream: 'views' })).resolves.toEqual({ ok: true });
  });
});

describe('CustomerGateway', () => {
  it('joins only the own conversation and refuses other streams', async () => {
    const gateway = new CustomerGateway({} as never, { wsConnections: { add: vi.fn() } } as never, {} as never);
    const { socket: s, joined } = socket('customer');
    await gateway.handleConnection(s);
    expect(joined).toEqual([tenantRoom(TENANT), sessionRoom(TENANT, 's1'), `t:${TENANT}:conversation:${USER}`]);
    expect(gateway.subscribe({ stream: 'conversation' })).toEqual({ ok: true });
    expect(gateway.subscribe({ stream: `ticket:${TICKET}` })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('errorAck', () => {
  it('maps AppError codes and hides anything else', () => {
    expect(errorAck(new AppError('RATE_LIMITED', 429, 'Slow down'))).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Slow down' },
    });
    expect(errorAck(new Error('SELECT secret'))).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
});
