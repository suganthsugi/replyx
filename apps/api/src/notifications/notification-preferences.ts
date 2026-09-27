import { NOTIFICATION_EVENT_TYPES, type NotificationChannel, type NotificationEventType } from '../platform-kernel/db/tables/notifications.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Notification preferences (FR-080, research D20, contracts/operations.yaml
 * `NotificationPreferences`): a master switch plus per-event, per-channel toggles.
 *
 * A user's row stores only what they changed. Each toggle resolves as: the user's choice, else
 * the tenant default (`tenant_settings.notification_defaults`, written at provisioning by
 * notification-defaults.contributor.ts and later editable by admins), else the built-in default
 * below. In-app is on for every event. Push and email are stored now and delivered from US15.
 */

export interface ChannelToggles {
  inApp: boolean;
  push: boolean;
  email: boolean;
}

export interface ResolvedPreferences {
  enabled: boolean;
  events: Record<NotificationEventType, ChannelToggles>;
}

/** What the user (or the tenant) set: any subset of events and channels. */
export type PartialEvents = Partial<Record<NotificationEventType, Partial<ChannelToggles>>>;

/** Push for what needs attention now; email off until US15 adds digests. */
const PUSH_BY_DEFAULT: ReadonlySet<NotificationEventType> = new Set([
  'ticket.assigned_to_me',
  'message.customer_on_my_ticket',
  'mention',
  'sla.breached',
]);

export const BUILT_IN_DEFAULTS: Readonly<Record<NotificationEventType, ChannelToggles>> = Object.fromEntries(
  NOTIFICATION_EVENT_TYPES.map((event) => [event, { inApp: true, push: PUSH_BY_DEFAULT.has(event), email: false }]),
) as Record<NotificationEventType, ChannelToggles>;

const CHANNEL_KEYS: Readonly<Record<NotificationChannel, keyof ChannelToggles>> = { in_app: 'inApp', push: 'push', email: 'email' };

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Keeps only known events and boolean toggles from a stored jsonb value. */
export function toPartialEvents(value: JsonValue | undefined): PartialEvents {
  const result: PartialEvents = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result;
  for (const [event, toggles] of Object.entries(value)) {
    if (!isNotificationEventType(event) || typeof toggles !== 'object' || toggles === null || Array.isArray(toggles)) continue;
    const kept: Partial<ChannelToggles> = {};
    for (const key of ['inApp', 'push', 'email'] as const) {
      const toggle = toggles[key];
      if (typeof toggle === 'boolean') kept[key] = toggle;
    }
    result[event] = kept;
  }
  return result;
}

export function resolvePreferences(user: { enabled: boolean; events: PartialEvents } | undefined, tenantDefaults: PartialEvents): ResolvedPreferences {
  const events = {} as Record<NotificationEventType, ChannelToggles>;
  for (const event of NOTIFICATION_EVENT_TYPES) {
    events[event] = { ...BUILT_IN_DEFAULTS[event], ...tenantDefaults[event], ...user?.events[event] };
  }
  return { enabled: user?.enabled ?? true, events };
}

export function wants(preferences: ResolvedPreferences, event: NotificationEventType, channel: NotificationChannel): boolean {
  return preferences.enabled && preferences.events[event][CHANNEL_KEYS[channel]];
}

export class NotificationPreferencesRepository extends TenantRepository {
  async tenantDefaults(tx: TenantTransaction): Promise<PartialEvents> {
    const row = await this.selectFrom(tx, 'tenant_settings').select('tenant_settings.notification_defaults').executeTakeFirst();
    return toPartialEvents(row?.notification_defaults);
  }

  async forUsers(tx: TenantTransaction, userIds: readonly string[]): Promise<Map<string, ResolvedPreferences>> {
    const defaults = await this.tenantDefaults(tx);
    const rows =
      userIds.length === 0
        ? []
        : await this.selectFrom(tx, 'notification_preferences')
            .select(['notification_preferences.user_id', 'notification_preferences.enabled', 'notification_preferences.events'])
            .where('notification_preferences.user_id', 'in', userIds)
            .execute();
    const stored = new Map(rows.map((row) => [row.user_id, { enabled: row.enabled, events: toPartialEvents(row.events) }]));
    return new Map(userIds.map((id) => [id, resolvePreferences(stored.get(id), defaults)]));
  }

  async save(tx: TenantTransaction, userId: string, enabled: boolean, events: PartialEvents): Promise<void> {
    // jsonb: send JSON text, not an object (default-views.contributor.ts).
    const value = JSON.stringify(events);
    await this.insertInto(tx, 'notification_preferences', { user_id: userId, enabled, events: value })
      .onConflict((oc) => oc.columns(['tenant_id', 'user_id']).doUpdateSet({ enabled, events: value }))
      .execute();
  }
}
