import { describe, expect, it, vi } from 'vitest';

import { Clock } from '../../../src/platform-kernel/clock.js';
import { PRESENCE_TTL_MS, PresenceService } from '../../../src/platform-kernel/realtime/presence.service.js';

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';

class FixedClock extends Clock {
  now(): Date {
    return new Date(1_000_000);
  }
}

describe('PresenceService', () => {
  it('reads members seen within the last 30 s from tenant-scoped keys', async () => {
    const redis = { zrangebyscore: vi.fn(() => Promise.resolve(['u1'])) };
    const presence = new PresenceService(new FixedClock(), redis as never);
    await expect(presence.ticket(TENANT, 'k1')).resolves.toEqual({ viewers: ['u1'], typing: ['u1'] });
    expect(redis.zrangebyscore).toHaveBeenCalledWith(`presence:${TENANT}:ticket:k1:viewing`, `(${1_000_000 - PRESENCE_TTL_MS}`, '+inf');
  });

  it('maps availability heartbeats and defaults to offline', async () => {
    const redis = { mget: vi.fn(() => Promise.resolve(['away', null, 'bogus'])) };
    const presence = new PresenceService(new FixedClock(), redis as never);
    await expect(presence.availability(TENANT, ['a', 'b', 'c'])).resolves.toEqual(
      new Map([
        ['a', 'away'],
        ['b', 'offline'],
        ['c', 'offline'],
      ]),
    );
    expect(redis.mget).toHaveBeenCalledWith(`presence:${TENANT}:availability:a`, `presence:${TENANT}:availability:b`, `presence:${TENANT}:availability:c`);
  });

  it('degrades to nobody present when Redis fails', async () => {
    const failing = () => Promise.reject(new Error('down'));
    const redis = { zrangebyscore: failing, mget: failing, set: failing, del: failing, multi: () => ({ zremrangebyscore: () => ({ zadd: () => ({ pexpire: () => ({ exec: failing }) }) }) }) };
    const presence = new PresenceService(new FixedClock(), redis as never);
    await expect(presence.viewing(TENANT, 'k1', 'u1', 'enter')).resolves.toEqual({ viewers: [], typing: [] });
    await expect(presence.availability(TENANT, ['a'])).resolves.toEqual(new Map([['a', 'offline']]));
    await expect(presence.setAvailability(TENANT, 'a', 'online')).resolves.toBeUndefined();
  });
});
