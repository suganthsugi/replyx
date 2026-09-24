import { describe, expect, it } from 'vitest';

import { AuditConsumer, auditEntryFor } from '../../../src/audit/audit.consumer.js';
import { sanitizeDetails } from '../../../src/audit/audit.service.js';

import type { DomainEvent } from '../../../src/platform-kernel/jobs/idempotent-handler.js';

const USER = '0192f3c4-0000-7000-8000-0000000000a1';

describe('sanitizeDetails', () => {
  it('drops keys that may carry message bodies or secrets, at any depth', () => {
    const { details, dropped } = sanitizeDetails({
      field: 'state',
      old: 'open',
      new: 'pending',
      body: 'Customer text',
      nested: { token: 'abc', password: 'x', keep: 1, list: [{ secret: 's', ok: true }] },
      Authorization: 'Bearer x',
      newPassword: 'y',
    });
    expect(details).toEqual({ field: 'state', old: 'open', new: 'pending', nested: { keep: 1, list: [{ ok: true }] } });
    expect(dropped.sort()).toEqual(['Authorization', 'body', 'nested.list.0.secret', 'nested.password', 'nested.token', 'newPassword']);
  });

  it('truncates oversized details', () => {
    expect(sanitizeDetails({ big: 'x'.repeat(10_000) }).details).toEqual({ truncated: true });
  });
});

describe('audit mapping', () => {
  const event = (reason: 'sign_out' | 'sign_out_all' | 'deactivated'): DomainEvent<'session.revoked'> => ({
    id: 'e1',
    tenantId: 't',
    type: 'session.revoked',
    actor: { kind: 'user', id: USER },
    payload: { userId: USER, sessionIds: ['s1', 's2'], reason },
    customerPayload: null,
    streams: [`user:${USER}`],
    cause: null,
    occurredAt: new Date(),
    seq: '1',
  });

  it('audits revoking sessions but not a single sign-out', () => {
    expect(auditEntryFor(event('sign_out'))).toBeUndefined();
    expect(auditEntryFor(event('sign_out_all'))).toEqual({
      action: 'auth.sessions_revoked',
      resourceType: 'user',
      resourceId: USER,
      details: { reason: 'sign_out_all', sessionCount: 2 },
    });
  });

  it('consumes session.revoked from the audit queue', () => {
    const consumer = new AuditConsumer(null as never, null as never);
    expect([consumer.consumer, consumer.queue, consumer.eventTypes]).toEqual(['audit', 'audit', ['session.revoked']]);
  });
});
