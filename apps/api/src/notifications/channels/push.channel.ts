import { Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';

import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';

import { PushSubscriptionsRepository, type PushSubscription } from './push-subscriptions.js';

import type { ChannelMessage } from './channel-message.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/**
 * Browser push (Web Push with VAPID, research D20, `VAPID_*` in .env). Sends one message to each
 * of the recipient's registered browsers; the service worker (apps/web/public/sw.js) shows it and
 * opens the ticket on click.
 *
 * - A 404 or 410 from the push service means the subscription expired or was revoked: it is
 *   removed, and nothing is retried for it.
 * - Any other failure on one browser is logged; the job is retried only when every browser failed,
 *   so a retry never repeats a message to a browser that already got it.
 * - Without VAPID keys (development without push set up) nothing is sent.
 *
 * Nothing here logs endpoints, keys, titles or bodies.
 */

export type PushTransport = (subscription: PushSubscription, payload: string) => Promise<void>;

/** Seconds a push service keeps an undelivered message (the browser is offline). */
const PUSH_TTL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;

export function vapidPublicKey(): string | null {
  const key = process.env.VAPID_PUBLIC_KEY ?? '';
  return key === '' || (process.env.VAPID_PRIVATE_KEY ?? '') === '' ? null : key;
}

function vapidSubject(): string {
  const subject = process.env.VAPID_SUBJECT ?? '';
  if (subject !== '') return subject;
  return `mailto:support@${process.env.BASE_DOMAIN ?? 'localhost'}`;
}

const webPushTransport: PushTransport = async (subscription, payload) => {
  await webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: vapidSubject(), publicKey: process.env.VAPID_PUBLIC_KEY ?? '', privateKey: process.env.VAPID_PRIVATE_KEY ?? '' },
    TTL: PUSH_TTL_SECONDS,
    timeout: PUSH_TIMEOUT_MS,
  });
};

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

@Injectable()
export class PushChannel {
  private readonly logger = new Logger('PushChannel');
  /** Replaced in tests; the real one posts to the browser's push service. */
  transport: PushTransport = webPushTransport;
  private warnedUnconfigured = false;

  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** `true` when a configured transport exists (VAPID keys set, or a test transport). */
  configured(): boolean {
    return this.transport !== webPushTransport || vapidPublicKey() !== null;
  }

  async send(ctx: TenantContext, userId: string, message: ChannelMessage): Promise<void> {
    if (!this.configured()) {
      if (!this.warnedUnconfigured) this.logger.warn('VAPID keys are not set: push notifications are not sent');
      this.warnedUnconfigured = true;
      return;
    }
    const subscriptions = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new PushSubscriptionsRepository(ctx).forUser(tx, userId));
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify(message);
    const expired: string[] = [];
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await this.transport(subscription, payload);
      } catch (error) {
        const status = statusCodeOf(error);
        if (status === 404 || status === 410) {
          expired.push(subscription.endpoint);
        } else {
          failed += 1;
          this.logger.warn(`Push delivery failed (status ${status ?? 'none'})`);
        }
      }
    }
    if (expired.length > 0) {
      await this.unitOfWork.withTenant(ctx, (tx) => new PushSubscriptionsRepository(ctx).remove(tx, userId, expired));
    }
    if (failed === subscriptions.length) {
      throw new Error('Push delivery failed for every browser');
    }
  }
}
