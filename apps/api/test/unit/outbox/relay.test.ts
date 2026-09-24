import { describe, expect, it } from 'vitest';

import { clientStream } from '../../../src/platform-kernel/outbox/event-types.js';
import {
  CUSTOMER_NAMESPACE,
  planDelivery,
  roomFor,
  STAFF_NAMESPACE,
  type RelayEvent,
} from '../../../src/platform-kernel/outbox/relay.js';

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';
const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const CUSTOMER = '0192f3c4-0000-7000-8000-0000000000c1';
const TICKET = '0192f3c4-0000-7000-8000-0000000000d1';
const OCCURRED = new Date('2026-09-24T10:15:02.113Z');

function event(partial: Partial<RelayEvent>): RelayEvent {
  return {
    id: '01a0d475-0000-7000-8000-000000000001',
    tenantId: TENANT,
    type: 'access.revoked',
    actor: { kind: 'user', id: USER, name: 'Priya' },
    payload: { ticketIds: [TICKET] },
    customerPayload: null,
    streams: [`user:${USER}`],
    occurredAt: OCCURRED,
    seq: 42,
    ...partial,
  };
}

describe('planDelivery', () => {
  it('emits the contract envelope to each tenant-qualified staff room', () => {
    const plan = planDelivery(event({ streams: [`user:${USER}`, `ticket:${TICKET}`] }), []);
    expect(plan.emits).toEqual([
      {
        namespace: STAFF_NAMESPACE,
        room: `t:${TENANT}:user:${USER}`,
        envelope: {
          id: '01a0d475-0000-7000-8000-000000000001',
          seq: 42,
          stream: 'user',
          type: 'access.revoked',
          occurredAt: '2026-09-24T10:15:02.113Z',
          actor: { kind: 'user', id: USER, name: 'Priya' },
          data: { ticketIds: [TICKET] },
        },
      },
      plan.emits[1],
    ]);
    expect(plan.emits[1]?.room).toBe(`t:${TENANT}:ticket:${TICKET}`);
    expect(plan.emits[1]?.envelope.stream).toBe(`ticket:${TICKET}`);
    expect(plan.control).toBeUndefined();
  });

  it('sends customer rooms only the customer projection, without staff actor details', () => {
    const plan = planDelivery(
      event({
        streams: [`user:${USER}`, `conversation:${CUSTOMER}`],
        customerPayload: { type: 'conversation.status', data: { status: 'waiting' } },
      }),
      [],
    );
    const customer = plan.emits.find((emit) => emit.namespace === CUSTOMER_NAMESPACE);
    expect(customer?.room).toBe(`t:${TENANT}:conversation:${CUSTOMER}`);
    expect(customer?.envelope).toMatchObject({
      stream: 'conversation',
      type: 'conversation.status',
      actor: { kind: 'user' },
      data: { status: 'waiting' },
    });
    expect(customer?.envelope.actor).toEqual({ kind: 'user' });
    expect(JSON.stringify(customer)).not.toContain(TICKET);
    expect(JSON.stringify(customer)).not.toContain('Priya');
  });

  it('never emits a customer stream without a projection', () => {
    const plan = planDelivery(event({ streams: [`conversation:${CUSTOMER}`], customerPayload: { leaked: true } }), []);
    expect(plan.emits).toEqual([]);
  });

  it('broadcasts control events and keeps the tenant stream out of rooms', () => {
    const plan = planDelivery(event({ type: 'access.changed', payload: { accessVersion: '3', reason: 'x' }, streams: ['tenant'] }), [
      { queue: 'audit', consumer: 'audit' },
    ]);
    expect(plan.emits).toEqual([]);
    expect(plan.jobs).toEqual([{ queue: 'audit', consumer: 'audit' }]);
    expect(plan.control).toEqual({
      id: '01a0d475-0000-7000-8000-000000000001',
      seq: 42,
      tenantId: TENANT,
      type: 'access.changed',
      occurredAt: '2026-09-24T10:15:02.113Z',
      payload: { accessVersion: '3', reason: 'x' },
    });
  });

  it('names rooms and client streams per the contract', () => {
    expect(roomFor(TENANT, `views:${USER}`)).toBe(`t:${TENANT}:views:${USER}`);
    expect(clientStream(`views:${USER}`)).toBe('views');
    expect(clientStream('tickets:group:ungrouped')).toBe('tickets');
    expect(clientStream(`conversation:${CUSTOMER}`)).toBe('conversation');
    expect(clientStream(`ticket:${TICKET}`)).toBe(`ticket:${TICKET}`);
  });
});
