import { describe, expect, it, vi } from 'vitest';

import { Clock } from '../../../src/platform-kernel/clock.js';
import { IdempotentHandler, toDomainEvent } from '../../../src/platform-kernel/jobs/idempotent-handler.js';
import { JobRouter, JobWorkers } from '../../../src/platform-kernel/jobs/jobs.module.js';
import { DEAD_LETTER_QUEUE, DEFAULT_JOB_OPTIONS, eventJobId, type EventJobData } from '../../../src/platform-kernel/jobs/queues.js';

import type { Job } from 'bullmq';

class FixedClock extends Clock {
  now(): Date {
    return new Date('2026-09-24T12:00:00Z');
  }
}

function handler(consumer: string, queue: 'audit' | 'notifications', eventTypes: ('access.changed' | 'session.revoked')[]) {
  return new (class extends IdempotentHandler {
    readonly consumer = consumer;
    readonly queue = queue;
    readonly eventTypes = eventTypes;
    protected handle(): Promise<void> {
      return Promise.resolve();
    }
  })(null as never);
}

describe('JobRouter', () => {
  it('routes each event type to every interested consumer', () => {
    const router = new JobRouter(null as never);
    router.register([
      handler('audit', 'audit', ['access.changed', 'session.revoked']),
      handler('notify', 'notifications', ['session.revoked']),
    ]);
    expect(router.routesFor('session.revoked')).toEqual([
      { queue: 'audit', consumer: 'audit' },
      { queue: 'notifications', consumer: 'notify' },
    ]);
    expect(router.routesFor('tenant.suspended')).toEqual([]);
    expect(router.queuesInUse()).toEqual(['notifications', 'audit']);
    expect(router.handler('notify')?.queue).toBe('notifications');
  });

  it('rejects two consumers with the same name', () => {
    const router = new JobRouter(null as never);
    expect(() => router.register([handler('a', 'audit', []), handler('a', 'notifications', [])])).toThrow('registered twice');
  });
});

describe('JobWorkers', () => {
  function workers() {
    const add = vi.fn(() => Promise.resolve());
    const queues = { get: vi.fn(() => ({ add })) };
    return { workers: new JobWorkers(new JobRouter(null as never), queues as never, {} as never, new FixedClock()), add, queues };
  }
  const job = (attemptsMade: number) =>
    ({ id: 'audit.e1', name: 'audit', attemptsMade, opts: { attempts: 5 }, data: { tenantId: 't', eventId: 'e1' } }) as Job<EventJobData>;

  it('dead-letters a job only after its last attempt', async () => {
    const { workers: w, add, queues } = workers();
    await w.onFailed('audit', job(4), new Error('boom'));
    expect(add).not.toHaveBeenCalled();
    await w.onFailed('audit', job(5), new Error('boom'));
    expect(queues.get).toHaveBeenCalledWith(DEAD_LETTER_QUEUE);
    expect(add).toHaveBeenCalledWith(
      'audit',
      {
        queue: 'audit',
        consumer: 'audit',
        data: { tenantId: 't', eventId: 'e1' },
        attempts: 5,
        error: 'boom',
        failedAt: '2026-09-24T12:00:00.000Z',
      },
      { jobId: 'audit.e1', attempts: 1 },
    );
  });

  it('refuses a job for an unknown consumer', async () => {
    await expect(workers().workers.run({ name: 'nobody', data: { tenantId: 't', eventId: 'e' } } as Job<EventJobData>)).rejects.toThrow('No consumer nobody');
  });
});

describe('queue defaults', () => {
  it('retries 5 times with exponential backoff and ids jobs per consumer and event', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 1_000 });
    expect(eventJobId('audit', 'e1')).toBe('audit.e1');
  });

  it('maps outbox rows to domain events', () => {
    const created = new Date();
    expect(
      toDomainEvent({
        id: 'e1',
        tenant_id: 't',
        type: 'access.changed',
        actor: { kind: 'system' },
        payload: { accessVersion: '2', reason: 'x' },
        customer_payload: null,
        streams: ['tenant'],
        cause: null,
        created_at: created,
        seq: '7',
      }),
    ).toEqual({
      id: 'e1',
      tenantId: 't',
      type: 'access.changed',
      actor: { kind: 'system' },
      payload: { accessVersion: '2', reason: 'x' },
      customerPayload: null,
      streams: ['tenant'],
      cause: null,
      occurredAt: created,
      seq: '7',
    });
  });
});
