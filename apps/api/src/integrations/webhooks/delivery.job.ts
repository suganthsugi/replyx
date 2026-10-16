import { Inject, Injectable, Logger } from '@nestjs/common';

import { Clock } from '../../platform-kernel/clock.js';
import { SecretBox } from '../../platform-kernel/crypto/secret-box.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { OutboundRefusedError, OutboundTimeoutError, outboundRequest } from '../../platform-kernel/http/outbound-guard.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

import { signatureHeader } from './webhook-signature.js';
import { WebhooksRepository, type AttemptOutcome, type DeliveryRow, type WebhookRow } from './webhooks.repository.js';

import type { Kysely } from 'kysely';

/**
 * Sends one webhook attempt (US18, FR-091, research D16, contracts/webhook-events.md), in the
 * worker.
 *
 * - Nothing is sent while the tenant is not active (FR-004): the attempt stays pending and the
 *   sweep sends it once the tenant is reactivated.
 * - The attempt is claimed with a short lease, then sent outside any transaction through the
 *   kernel's outbound guard: https only (http and private addresses only in development), every
 *   address the host resolves to is checked at connect time, so private, loopback, link-local and
 *   metadata addresses are refused even after a DNS change; no redirects; 10 s timeout.
 * - Signed `ReplyX-Signature: t=…,v1=…` with the endpoint's secret (sealed at rest).
 * - Any 2xx is `succeeded`. Anything else is `failed` with the next attempt written as pending and
 *   queued after 1 m, 5 m, 15 m, 1 h, 3 h, 6 h or 12 h (±10% jitter); the 8th failure is
 *   `gave_up`. An endpoint switched off gives up its pending attempts.
 */

export const WEBHOOK_DELIVERY_JOB = 'webhook_delivery';
export const MAX_ATTEMPTS = 8;
export const REQUEST_TIMEOUT_MS = 10_000;
/** Delay before attempt n + 1, for n = 1..7. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000] as const;
/** Longer than the request timeout, so a claimed attempt is never sent twice at once. */
const LEASE_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface WebhookDeliveryJobData {
  tenantId: string;
  deliveryId: string;
}

export type DeliveryResult = 'succeeded' | 'failed' | 'gave_up' | 'skipped' | 'paused';

/** The delay before the attempt after `attempt`, with ±10% jitter so retries don't arrive in waves. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1]!;
  return Math.round(base * (0.9 + random() * 0.2));
}

export async function enqueueDelivery(queues: QueueRegistry, data: WebhookDeliveryJobData, options: { delayMs?: number; jobId?: string } = {}): Promise<void> {
  await queues.get('webhooks').add(WEBHOOK_DELIVERY_JOB, data, {
    jobId: options.jobId ?? `${WEBHOOK_DELIVERY_JOB}.${data.deliveryId}`,
    ...(options.delayMs !== undefined && options.delayMs > 0 ? { delay: options.delayMs } : {}),
  });
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The HTTP side of a delivery; its own provider so tests can stand in for the receiving endpoint. */
@Injectable()
export class WebhookTransport {
  async send(request: WebhookRequest): Promise<{ status: number }> {
    const response = await outboundRequest({ url: request.url, method: 'POST', headers: request.headers, body: request.body, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
    return { status: response.status };
  }
}

/** What the delivery log shows for a request that got no response. Never includes the secret. */
export function describeFailure(error: unknown): string {
  if (error instanceof OutboundRefusedError) {
    const reasons: Record<OutboundRefusedError['reason'], string> = {
      invalid_url: 'Refused: the URL is not valid',
      not_https: 'Refused: the URL must use https',
      private_address: 'Refused: the host resolves to a private or reserved address',
      unresolvable: 'The host name could not be resolved',
    };
    return reasons[error.reason];
  }
  if (error instanceof OutboundTimeoutError) return `No response within ${REQUEST_TIMEOUT_MS / 1000} s`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return `Connection failed (${code})`;
  return error instanceof Error ? error.message.slice(0, 200) : 'Request failed';
}

@Injectable()
export class WebhookDeliveryJob extends JobProcessor<WebhookDeliveryJobData> {
  readonly queue = 'webhooks' as const;
  readonly jobName = WEBHOOK_DELIVERY_JOB;
  private readonly logger = new Logger('WebhookDeliveryJob');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
    private readonly transport: WebhookTransport,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {
    super();
  }

  async process(data: WebhookDeliveryJobData): Promise<DeliveryResult> {
    const tenant = await this.platformDb.selectFrom('tenants').select('status').where('id', '=', data.tenantId).executeTakeFirst();
    if (tenant?.status !== 'active') return 'paused';

    const ctx = TenantContext.create({ tenantId: data.tenantId, actor: { kind: 'system' }, requestId: `webhook:${data.deliveryId}` });
    const repo = new WebhooksRepository(ctx);
    const claimedAt = this.clock.now();
    const claimed = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const delivery = await repo.claim(tx, data.deliveryId, claimedAt, LEASE_MS);
      if (delivery === undefined) return undefined;
      const webhook = await repo.byId(tx, delivery.webhookId);
      if (webhook === undefined) return undefined;
      if (!webhook.enabled) {
        await repo.complete(tx, delivery.id, { status: 'gave_up', responseCode: null, durationMs: null, error: 'Not sent: the endpoint is switched off', attemptedAt: claimedAt, nextAttemptAt: null });
        return undefined;
      }
      return { delivery, webhook };
    });
    if (claimed === undefined) return 'skipped';

    const outcome = await this.send(claimed.webhook, claimed.delivery);
    const next = await this.unitOfWork.withTenant(ctx, async (tx) => {
      await repo.complete(tx, claimed.delivery.id, outcome);
      if (outcome.status !== 'failed' || outcome.nextAttemptAt === null) return undefined;
      const id = await repo.insertAttempt(tx, {
        webhookId: claimed.delivery.webhookId,
        eventId: claimed.delivery.eventId,
        eventType: claimed.delivery.eventType,
        attempt: claimed.delivery.attempt + 1,
        body: claimed.delivery.body,
        dueAt: outcome.nextAttemptAt,
      });
      return id === undefined ? undefined : { id, dueAt: outcome.nextAttemptAt };
    });
    if (next !== undefined) {
      await enqueueDelivery(this.queues, { tenantId: data.tenantId, deliveryId: next.id }, { delayMs: next.dueAt.getTime() - this.clock.nowMs() });
    }
    if (outcome.status !== 'succeeded') {
      this.logger.warn(`Webhook ${claimed.webhook.id} attempt ${claimed.delivery.attempt} ${outcome.status}: ${outcome.error ?? `HTTP ${outcome.responseCode}`}`);
    }
    return outcome.status;
  }

  private async send(webhook: WebhookRow, delivery: DeliveryRow): Promise<AttemptOutcome> {
    const attemptedAt = this.clock.now();
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ReplyX-Webhooks/1',
      'ReplyX-Event-Id': delivery.eventId,
      'ReplyX-Event-Type': delivery.eventType,
      'ReplyX-Delivery-Attempt': String(delivery.attempt),
      'ReplyX-Signature': signatureHeader(this.secrets.open(webhook.secretEncrypted), Math.floor(attemptedAt.getTime() / 1000), delivery.body),
    };
    const started = performance.now();
    let responseCode: number | null = null;
    let error: string | null = null;
    try {
      responseCode = (await this.transport.send({ url: webhook.url, headers, body: delivery.body })).status;
      if (responseCode < 200 || responseCode >= 300) error = `HTTP ${responseCode}`;
    } catch (caught) {
      error = describeFailure(caught);
    }
    const durationMs = Math.round(performance.now() - started);
    if (error === null) return { status: 'succeeded', responseCode, durationMs, error: null, attemptedAt, nextAttemptAt: null };
    if (delivery.attempt >= MAX_ATTEMPTS) return { status: 'gave_up', responseCode, durationMs, error, attemptedAt, nextAttemptAt: null };
    return { status: 'failed', responseCode, durationMs, error, attemptedAt, nextAttemptAt: new Date(this.clock.nowMs() + retryDelayMs(delivery.attempt)) };
  }
}
