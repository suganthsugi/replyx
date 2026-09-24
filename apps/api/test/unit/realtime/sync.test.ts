import { describe, expect, it, vi } from 'vitest';

import { StreamAccess } from '../../../src/platform-kernel/realtime/stream-access.js';
import { MAX_SYNC_STREAMS, parseSyncRequest } from '../../../src/platform-kernel/realtime/sync.handler.js';

import type { EffectiveAccess } from '../../../src/authorization/policy.service.js';
import type { RealtimeSocket } from '../../../src/platform-kernel/realtime/socket-context.js';

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';
const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const SUPPORT = '0192f3c4-0000-7000-8000-0000000000b1';
const TICKET = '0192f3c4-0000-7000-8000-0000000000d1';

describe('parseSyncRequest', () => {
  it('accepts stream cursors as numbers or digit strings', () => {
    expect(parseSyncRequest({ streams: [{ stream: 'user', afterSeq: 5 }, { stream: 'tickets', afterSeq: '12' }] })).toEqual({
      streams: [
        { stream: 'user', afterSeq: 5 },
        { stream: 'tickets', afterSeq: 12 },
      ],
    });
  });

  it('rejects malformed requests with VALIDATION_FAILED', () => {
    const bad: unknown[] = [
      null,
      {},
      { streams: [] },
      { streams: Array.from({ length: MAX_SYNC_STREAMS + 1 }, () => ({ stream: 'user', afterSeq: 0 })) },
      { streams: [{ stream: '', afterSeq: 0 }] },
      { streams: [{ stream: 'user', afterSeq: -1 }] },
      { streams: [{ stream: 'user', afterSeq: 1.5 }] },
      { streams: [{ stream: 'user', afterSeq: '1e3' }] },
    ];
    for (const body of bad) {
      expect(() => parseSyncRequest(body)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error);
    }
  });
});

describe('StreamAccess', () => {
  const access: EffectiveAccess = {
    userId: USER,
    accessVersion: '0',
    permissions: new Set(['ticket.view']),
    groups: new Map([
      [SUPPORT, { view: true, create: false, edit: false, delete: false }],
      [null, { view: true, create: false, edit: false, delete: false }],
    ]),
  };
  const policy = { effectiveAccess: vi.fn(() => Promise.resolve(access)) };
  const lookup = { groupOf: vi.fn((_ctx: unknown, id: string) => Promise.resolve(id === TICKET ? SUPPORT : undefined)) };
  const socket = (kind: 'staff' | 'customer') =>
    ({ id: 's', data: { tenantId: TENANT, userId: USER, sessionId: 'x', kind } }) as unknown as RealtimeSocket;

  it('maps staff client streams to their current internal keys', async () => {
    const streams = new StreamAccess(policy as never, lookup);
    await expect(streams.keysFor(socket('staff'), 'user')).resolves.toEqual([`user:${USER}`]);
    await expect(streams.keysFor(socket('staff'), 'views')).resolves.toEqual([`views:${USER}`]);
    await expect(streams.keysFor(socket('staff'), 'tickets')).resolves.toEqual([`tickets:group:${SUPPORT}`, 'tickets:group:ungrouped']);
    await expect(streams.keysFor(socket('staff'), `ticket:${TICKET}`)).resolves.toEqual([`ticket:${TICKET}`]);
    await expect(streams.keysFor(socket('staff'), 'ticket:0192f3c4-0000-7000-8000-0000000000d2')).resolves.toEqual([]);
    await expect(streams.keysFor(socket('staff'), 'conversation')).resolves.toEqual([]);
  });

  it('gives customers their own conversation only', async () => {
    const streams = new StreamAccess(policy as never, lookup);
    await expect(streams.keysFor(socket('customer'), 'conversation')).resolves.toEqual([`conversation:${USER}`]);
    await expect(streams.keysFor(socket('customer'), 'user')).resolves.toEqual([]);
    await expect(streams.keysFor(socket('customer'), `ticket:${TICKET}`)).resolves.toEqual([]);
  });

  it('sees no tickets without a ticket lookup', async () => {
    await expect(new StreamAccess(policy as never).keysFor(socket('staff'), `ticket:${TICKET}`)).resolves.toEqual([]);
  });
});
