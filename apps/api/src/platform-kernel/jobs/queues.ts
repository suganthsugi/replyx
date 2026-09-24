import { Global, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

import { redisUrl } from '../redis/redis.module.js';

/**
 * BullMQ queues, one per concern (research D12). Jobs are enqueued only by the outbox relay
 * (domain events) and the sweeper (timers), never by services or controllers (constitution V).
 * Consumers run in the worker process (idempotent-handler.ts, jobs.module.ts).
 */
export const QUEUE_NAMES = [
  'notifications',
  'email',
  'push',
  'webhooks',
  'sla',
  'automation',
  'search-index',
  'attachments',
  'analytics',
  'retention',
  'sweeper',
  'audit',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Jobs that failed every attempt land here with their origin and last error. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

/** Every event job carries the tenant and event; the handler loads the event row itself. */
export interface EventJobData {
  tenantId: string;
  eventId: string;
}

export interface DeadLetterData {
  queue: QueueName;
  consumer: string;
  /** Only ids: processor jobs (email) may carry link tokens, which must not linger here. */
  data: Partial<EventJobData>;
  attempts: number;
  error: string;
  failedAt: string;
}

export const DEFAULT_ATTEMPTS = 5;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: DEFAULT_ATTEMPTS,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  // Failed jobs are copied to the dead-letter queue; the originals are kept a week for debugging.
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * One job per consumer and event; BullMQ ignores an add whose id already exists, so a relay
 * that republishes an event after a crash does not run a consumer twice (processed_events
 * guards anything older than the job retention).
 */
export function eventJobId(consumer: string, eventId: string): string {
  return `${consumer}.${eventId}`;
}

/**
 * BullMQ connections: blocking commands need `maxRetriesPerRequest: null`, so queues and
 * workers never share the app's main Redis client.
 */
export function createBullConnection(name: string): Redis {
  return new Redis(redisUrl(), { maxRetriesPerRequest: null, connectionName: `replyx-bull-${name}` });
}

@Injectable()
export class QueueRegistry implements OnApplicationShutdown {
  private readonly queues = new Map<string, Queue>();
  private connection?: Redis;

  get(name: QueueName | typeof DEAD_LETTER_QUEUE): Queue {
    let queue = this.queues.get(name);
    if (queue === undefined) {
      this.connection ??= createBullConnection('queues');
      queue = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Adds the event job for one consumer (idempotent by job id). */
  async enqueueEvent(queue: QueueName, consumer: string, data: EventJobData): Promise<void> {
    await this.get(queue).add(consumer, data, { jobId: eventJobId(consumer, data.eventId) });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection?.quit().catch(() => this.connection?.disconnect());
  }
}

/** Shared by both processes: the api enqueues emails, the worker's relay enqueues event jobs. */
@Global()
@Module({ providers: [QueueRegistry], exports: [QueueRegistry] })
export class QueuesModule {}
