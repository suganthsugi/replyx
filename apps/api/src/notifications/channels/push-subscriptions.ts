import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/**
 * A user's browser push subscriptions (`notification_preferences.push_subscriptions`, data-model.md,
 * contracts/operations.yaml `/notification-preferences/push-subscriptions`). One entry per browser,
 * keyed by its endpoint; registering the same endpoint again replaces its keys. The newest
 * `MAX_PUSH_SUBSCRIPTIONS` are kept, so a user who signs in on many browsers never grows the row
 * without bound. Expired endpoints are removed by the push channel (push.channel.ts).
 */

export const MAX_PUSH_SUBSCRIPTIONS = 10;

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Keeps only well-formed entries from the stored jsonb value. */
export function toPushSubscriptions(value: JsonValue | undefined): PushSubscription[] {
  if (!Array.isArray(value)) return [];
  const result: PushSubscription[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const { endpoint, keys } = entry;
    if (typeof endpoint !== 'string' || typeof keys !== 'object' || keys === null || Array.isArray(keys)) continue;
    const { p256dh, auth } = keys;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') continue;
    result.push({ endpoint, keys: { p256dh, auth } });
  }
  return result;
}

export class PushSubscriptionsRepository extends TenantRepository {
  async forUser(tx: TenantTransaction, userId: string): Promise<PushSubscription[]> {
    const row = await this.selectFrom(tx, 'notification_preferences')
      .select('notification_preferences.push_subscriptions')
      .where('notification_preferences.user_id', '=', userId)
      .executeTakeFirst();
    return toPushSubscriptions(row?.push_subscriptions);
  }

  async add(tx: TenantTransaction, userId: string, subscription: PushSubscription): Promise<void> {
    const current = await this.lockedForUser(tx, userId);
    const kept = [...current.filter((entry) => entry.endpoint !== subscription.endpoint), subscription].slice(-MAX_PUSH_SUBSCRIPTIONS);
    await this.write(tx, userId, kept);
  }

  /** Drops the given endpoints (expired or refused by the push service). */
  async remove(tx: TenantTransaction, userId: string, endpoints: readonly string[]): Promise<void> {
    if (endpoints.length === 0) return;
    const gone = new Set(endpoints);
    const current = await this.lockedForUser(tx, userId);
    const kept = current.filter((entry) => !gone.has(entry.endpoint));
    if (kept.length !== current.length) await this.write(tx, userId, kept);
  }

  private async lockedForUser(tx: TenantTransaction, userId: string): Promise<PushSubscription[]> {
    const row = await this.selectFrom(tx, 'notification_preferences')
      .select('notification_preferences.push_subscriptions')
      .where('notification_preferences.user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    return toPushSubscriptions(row?.push_subscriptions);
  }

  private async write(tx: TenantTransaction, userId: string, subscriptions: readonly PushSubscription[]): Promise<void> {
    // jsonb: send JSON text, not an object (default-views.contributor.ts).
    const value = JSON.stringify(subscriptions);
    await this.insertInto(tx, 'notification_preferences', { user_id: userId, push_subscriptions: value })
      .onConflict((oc) => oc.columns(['tenant_id', 'user_id']).doUpdateSet({ push_subscriptions: value }))
      .execute();
  }
}
