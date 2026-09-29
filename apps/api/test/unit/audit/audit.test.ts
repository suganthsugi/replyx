import { describe, expect, it } from 'vitest';

import { AuditConsumer, auditEntriesFor, type AuditableEvent } from '../../../src/audit/audit.consumer.js';
import { sanitizeDetails } from '../../../src/audit/audit.service.js';

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
  const USER2 = '0192f3c4-0000-7000-8000-0000000000a2';
  const TICKET = '0192f3c4-0000-7000-8000-0000000000b1';
  const GROUP = '0192f3c4-0000-7000-8000-0000000000c1';

  const base = { id: 'e1', tenantId: 't', actor: { kind: 'user', id: USER }, customerPayload: null, streams: [], cause: null, occurredAt: new Date(), seq: '1' } as const;
  const summary = {
    id: TICKET,
    number: 42,
    title: 'Secret title',
    state: 'open',
    priority: 'normal',
    group: { id: GROUP, name: 'Billing' },
    owner: null,
  };
  const ev = (type: string, payload: unknown) => ({ ...base, type, payload }) as unknown as AuditableEvent;

  it('audits revoking sessions but not a single sign-out', () => {
    const revoked = (reason: string) => ev('session.revoked', { userId: USER, sessionIds: ['s1', 's2'], reason });
    expect(auditEntriesFor(revoked('sign_out'))).toEqual([]);
    expect(auditEntriesFor(revoked('sign_out_all'))).toEqual([
      { action: 'auth.sessions_revoked', resourceType: 'user', resourceId: USER, details: { reason: 'sign_out_all', sessionCount: 2 } },
    ]);
  });

  it('maps a created ticket without its title', () => {
    expect(auditEntriesFor(ev('ticket.created', { ticket: summary }))).toEqual([
      {
        action: 'ticket.created',
        resourceType: 'ticket',
        resourceId: TICKET,
        details: { number: 42, state: 'open', priority: 'normal', groupId: GROUP, ownerId: null },
      },
    ]);
  });

  it('maps state, priority and group changes and ignores other fields', () => {
    const entries = auditEntriesFor(
      ev('ticket.updated', {
        ticket: summary,
        changes: [
          { field: 'state', old: 'new', new: 'open' },
          { field: 'priority', old: 'normal', new: 'high' },
          { field: 'group_id', old: null, new: GROUP },
          { field: 'owner_id', old: null, new: USER2 },
          { field: 'title', old: 'a', new: 'b' },
          { field: 'last_customer_message_at', old: null, new: 'now' },
        ],
      }),
    );
    expect(entries.map((entry) => [entry.action, entry.details])).toEqual([
      ['ticket.state_changed', { number: 42, from: 'new', to: 'open' }],
      ['ticket.priority_changed', { number: 42, from: 'normal', to: 'high' }],
      ['ticket.group_changed', { number: 42, from: null, to: GROUP }],
    ]);
  });

  it('tells assigned, reassigned and unassigned apart', () => {
    const action = (previousOwnerId: string | null, ownerId: string | null) =>
      auditEntriesFor(ev('ticket.assigned', { ticketId: TICKET, previousOwnerId, ownerId })).map((entry) => entry.action);
    expect(action(null, USER)).toEqual(['ticket.assigned']);
    expect(action(USER, USER2)).toEqual(['ticket.reassigned']);
    expect(action(USER, null)).toEqual(['ticket.unassigned']);
    expect(action(USER, USER)).toEqual([]);
  });

  it('maps messages and internal notes to counts, never the body', () => {
    const message = (visibility: 'public' | 'internal') =>
      ev('message.created', {
        id: 'm1',
        ticketId: TICKET,
        authorKind: 'staff',
        visibility,
        body: 'Private words',
        mentions: [{ id: USER2 }],
        attachments: [],
      });
    const [note] = auditEntriesFor(message('internal'));
    expect(note).toEqual({
      action: 'ticket.note_added',
      resourceType: 'ticket',
      resourceId: TICKET,
      details: { messageId: 'm1', authorKind: 'staff', attachmentCount: 0, mentionCount: 1 },
    });
    expect(auditEntriesFor(message('public'))[0]?.action).toBe('ticket.message_added');
    expect(JSON.stringify(auditEntriesFor(message('public')))).not.toContain('Private words');
  });

  it('consumes its events from the audit queue', () => {
    const consumer = new AuditConsumer(null as never, null as never);
    expect([consumer.consumer, consumer.queue]).toEqual(['audit', 'audit']);
    expect(consumer.eventTypes).toEqual(['session.revoked', 'ticket.created', 'ticket.updated', 'ticket.assigned', 'message.created']);
  });
});
