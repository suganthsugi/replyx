import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';

import { Clock } from '../clock.js';
import { MetricsService } from '../observability/metrics.js';

import { IdempotentHandler } from './idempotent-handler.js';
import {
  createBullConnection,
  DEAD_LETTER_QUEUE,
  DEFAULT_ATTEMPTS,
  QUEUE_NAMES,
  QueueRegistry,
  type DeadLetterData,
  type EventJobData,
  type QueueName,
} from './queues.js';

import type { Redis } from 'ioredis';

export interface EventRoute {
  queue: QueueName;
  consumer: string;
}

/** Every `IdempotentHandler` provider in the app, indexed by consumer and by event type. */
@Injectable()
export class JobRouter implements OnModuleInit {
  private readonly handlers = new Map<string, IdempotentHandler>();
  private readonly routes = new Map<string, EventRoute[]>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const handlers = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter((instance): instance is IdempotentHandler => instance instanceof IdempotentHandler);
    this.register(handlers);
  }

  register(handlers: readonly IdempotentHandler[]): void {
    for (const handler of handlers) {
      if (this.handlers.has(handler.consumer)) {
        throw new Error(`Consumer ${handler.consumer} is registered twice`);
      }
      this.handlers.set(handler.consumer, handler);
      for (const type of handler.eventTypes) {
        const list = this.routes.get(type) ?? [];
        list.push({ queue: handler.queue, consumer: handler.consumer });
        this.routes.set(type, list);
      }
    }
  }

  /** The consumer jobs the relay adds for one event type (possibly none). */
  routesFor(type: string): readonly EventRoute[] {
    return this.routes.get(type) ?? [];
  }

  handler(consumer: string): IdempotentHandler | undefined {
    return this.handlers.get(consumer);
  }

  queuesInUse(): QueueName[] {
    return QUEUE_NAMES.filter((queue) => [...this.handlers.values()].some((h) => h.queue === queue));
  }
}

const WORKER_CONCURRENCY = 5;
const METRICS_INTERVAL_MS = 15_000;

/**
 * Runs the consumers (worker process only): one BullMQ worker per queue that has handlers, with
 * 5 attempts and exponential backoff (queues.ts). A job that fails its last attempt is copied to
 * the dead-letter queue. `queue_depth` and `dead_letter_count` are refreshed every 15 s.
 */
@Injectable()
export class JobWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('JobWorkers');
  private readonly workers: Worker[] = [];
  private connection?: Redis;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly router: JobRouter,
    private readonly queues: QueueRegistry,
    private readonly metrics: MetricsService,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    const queues = this.router.queuesInUse();
    if (queues.length > 0) this.connection = createBullConnection('workers');
    for (const queue of queues) {
      const worker = new Worker<EventJobData>(queue, (job) => this.run(job), {
        connection: this.connection as Redis,
        concurrency: WORKER_CONCURRENCY,
      });
      worker.on('failed', (job, error) => void this.onFailed(queue, job, error));
      worker.on('error', (error) => this.logger.error(`Worker ${queue} error: ${error.message}`));
      this.workers.push(worker);
    }
    this.timer = setInterval(() => void this.refreshMetrics(), METRICS_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Consuming ${queues.length} queue(s)`);
  }

  async run(job: Job<EventJobData>): Promise<string> {
    const handler = this.router.handler(job.name);
    if (handler === undefined) throw new Error(`No consumer ${job.name}`);
    return handler.process(job.data, job.id);
  }

  async onFailed(queue: QueueName, job: Job<EventJobData> | undefined, error: Error): Promise<void> {
    if (job === undefined) return;
    const attempts = job.opts.attempts ?? DEFAULT_ATTEMPTS;
    if (job.attemptsMade < attempts) return;
    const entry: DeadLetterData = {
      queue,
      consumer: job.name,
      data: job.data,
      attempts: job.attemptsMade,
      error: error.message.slice(0, 500),
      failedAt: this.clock.now().toISOString(),
    };
    this.logger.error(`Job ${job.id ?? '?'} (${queue}/${job.name}) dead-lettered: ${entry.error}`);
    try {
      await this.queues.get(DEAD_LETTER_QUEUE).add(job.name, entry, { jobId: job.id, attempts: 1 });
    } catch (dlqError) {
      this.logger.error(`Dead-letter enqueue failed: ${dlqError instanceof Error ? dlqError.message : 'unknown'}`);
    }
  }

  async refreshMetrics(): Promise<void> {
    try {
      for (const name of QUEUE_NAMES) {
        this.metrics.queueDepth.record(await this.queues.get(name).getWaitingCount(), { queue: name });
      }
      this.metrics.deadLetterCount.record(await this.queues.get(DEAD_LETTER_QUEUE).getWaitingCount());
    } catch (error) {
      this.logger.warn(`Queue metrics failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.connection?.quit().catch(() => this.connection?.disconnect());
  }
}

/** Queues and consumers for the worker process (the relay enqueues through `QueueRegistry`). */
@Module({
  imports: [DiscoveryModule],
  providers: [QueueRegistry, JobRouter, JobWorkers],
  exports: [QueueRegistry, JobRouter],
})
export class JobsModule {}
