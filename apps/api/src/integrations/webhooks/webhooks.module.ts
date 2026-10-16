import { Module } from '@nestjs/common';

import { SecretBox } from '../../platform-kernel/crypto/secret-box.js';

import { WebhookDeliveryJob, WebhookTransport } from './delivery.job.js';
import { WebhookSweepJob } from './webhook-sweep.job.js';
import { WebhooksConsumer } from './webhooks.consumer.js';

/**
 * Webhook delivery (worker only; jobs.module.ts discovers the consumer and both processors).
 * Secrets are opened with the kernel `SecretBox` (`REPLYX_SECRETS_KEY`).
 */
@Module({
  providers: [WebhooksConsumer, WebhookDeliveryJob, WebhookSweepJob, WebhookTransport, { provide: SecretBox, useFactory: () => new SecretBox() }],
})
export class WebhooksJobsModule {}

