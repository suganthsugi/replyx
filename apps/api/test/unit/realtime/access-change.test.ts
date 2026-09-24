import { describe, expect, it, vi } from 'vitest';

import { AccessChangeHandler } from '../../../src/platform-kernel/realtime/access-change.handler.js';
import { StreamAccess } from '../../../src/platform-kernel/realtime/stream-access.js';

import type { EffectiveAccess } from '../../../src/authorization/policy.service.js';
import type { ControlMessage } from '../../../src/platform-kernel/outbox/relay.js';

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';
const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const SUPPORT = '0192f3c4-0000-7000-8000-0000000000b1';
const BILLING = '0192f3c4-0000-7000-8000-0000000000b2';
const T_SUPPORT = '0192f3c4-0000-7000-8000-0000000000d1';
const T_BILLING = '0192f3c4-0000-7000-8000-0000000000d2';

const room = (stream: string) => `t:${TENANT}:${stream}`;
const flags = { view: true, create: false, edit: false, delete: false };

const message: ControlMessage = {
  id: '01a0d475-0000-7000-8000-000000000009',
  seq: 77,
  tenantId: TENANT,
  type: 'access.changed',
  occurredAt: '2026-09-24T10:00:00.000Z',
  payload: { accessVersion: '5', reason: 'role_changed' },
};

function setup(groups: [string | null, typeof flags][]) {
  const access: EffectiveAccess = {
    userId: USER,
    accessVersion: '5',
    permissions: new Set(['ticket.view']),
    groups: new Map(groups),
  };
  const policy = { effectiveAccess: vi.fn(() => Promise.resolve(access)) };
  const lookup = { groupOf: (_ctx: unknown, id: string) => Promise.resolve(id === T_SUPPORT ? SUPPORT : id === T_BILLING ? BILLING : undefined) };
  const handler = new AccessChangeHandler(policy as never, new StreamAccess(policy as never, lookup));
  const rooms = new Set([
    'sock1',
    room('tenant'),
    room(`user:${USER}`),
    room(`tickets:group:${SUPPORT}`),
    room(`tickets:group:${BILLING}`),
    room('tickets:group:ungrouped'),
    room(`ticket:${T_SUPPORT}`),
    room(`ticket:${T_BILLING}`),
  ]);
  const emitted: unknown[] = [];
  const socket = {
    id: 'sock1',
    data: { tenantId: TENANT, userId: USER, sessionId: 's1', kind: 'staff' as const },
    rooms,
    leave: vi.fn((r: string) => {
      rooms.delete(r);
      return Promise.resolve();
    }),
    join: vi.fn((r: string[]) => {
      for (const x of r) rooms.add(x);
      return Promise.resolve();
    }),
    emit: vi.fn((_event: string, envelope: unknown) => emitted.push(envelope)),
  };
  return { handler, socket, rooms, emitted };
}

describe('AccessChangeHandler.recompute', () => {
  it('leaves rooms that are no longer allowed and reports them', async () => {
    const { handler, socket, rooms, emitted } = setup([[SUPPORT, flags]]);
    await handler.recompute(socket as never, message, '5');

    expect([...rooms].filter((r) => r.includes('ticket'))).toEqual([room(`tickets:group:${SUPPORT}`), room(`ticket:${T_SUPPORT}`)]);
    expect(emitted).toEqual([
      {
        id: message.id,
        seq: 77,
        stream: 'user',
        type: 'access.changed',
        occurredAt: '2026-09-24T10:00:00.000Z',
        actor: { kind: 'system' },
        data: { accessVersion: '5' },
      },
      expect.objectContaining({ type: 'access.revoked', stream: 'user', data: { ticketIds: [T_BILLING], groupIds: [BILLING, null] } }),
    ]);
  });

  it('joins newly granted groups and sends only access.changed when nothing was lost', async () => {
    const { handler, socket, rooms, emitted } = setup([
      [SUPPORT, flags],
      [BILLING, flags],
      [null, flags],
      ['0192f3c4-0000-7000-8000-0000000000b3', flags],
    ]);
    await handler.recompute(socket as never, message, '5');
    expect(rooms.has(room('tickets:group:0192f3c4-0000-7000-8000-0000000000b3'))).toBe(true);
    expect(emitted).toHaveLength(1);
  });
});
