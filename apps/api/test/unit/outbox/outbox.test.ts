import { describe, expect, it } from 'vitest';

import { uuidv7, UUID_PATTERN } from '../../../src/platform-kernel/ids.js';
import { isCustomerStream, isStreamKey } from '../../../src/platform-kernel/outbox/event-types.js';
import { OutboxService } from '../../../src/platform-kernel/outbox/outbox.service.js';

import type { TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';

const ID = '0192f3c4-0000-7000-8000-000000000001';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 ids that sort by creation', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    for (const id of ids) {
      expect(id).toMatch(UUID_PATTERN);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const ms = Date.UTC(2030, 0, 1);
    const id = uuidv7(ms);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBeGreaterThanOrEqual(ms);
  });
});

describe('stream keys', () => {
  it('accepts the contract stream shapes only', () => {
    for (const key of [`user:${ID}`, `views:${ID}`, `ticket:${ID}`, `tickets:group:${ID}`, 'tickets:group:ungrouped', `conversation:${ID}`, 'tenant']) {
      expect(isStreamKey(key)).toBe(true);
    }
    for (const key of [`t:${ID}:ticket:${ID}`, 'ticket:1', 'tickets:group:all', `user:${ID}:x`, '', 'views']) {
      expect(isStreamKey(key)).toBe(false);
    }
    expect(isCustomerStream(`conversation:${ID}`)).toBe(true);
    expect(isCustomerStream(`ticket:${ID}`)).toBe(false);
  });
});

describe('OutboxService.append guard rails', () => {
  const outbox = new OutboxService();
  const notATenantTx = {} as TenantTransaction;

  it('refuses to run outside withTenant', async () => {
    await expect(
      outbox.append(notATenantTx, { type: 'tenant.suspended', payload: {}, streams: ['tenant'] }),
    ).rejects.toThrow('inside withTenant');
  });
});
