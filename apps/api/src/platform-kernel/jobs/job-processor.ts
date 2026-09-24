import type { QueueName } from './queues.js';
import type { Job } from 'bullmq';

/**
 * A named job on a queue that is not a domain-event consumer: outgoing email (mail.service.ts)
 * and, later, sweeper timers. Producers enqueue these through their own service after commit;
 * the worker runs them with the same retries and dead-lettering as event consumers.
 * Subclasses are Nest providers; `jobName` shares one namespace with consumer names.
 */
export abstract class JobProcessor<D = unknown> {
  abstract readonly queue: QueueName;
  abstract readonly jobName: string;

  abstract process(data: D, job: Job<D>): Promise<unknown>;
}
