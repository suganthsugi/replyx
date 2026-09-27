import { Injectable } from '@nestjs/common';

import { AccessRepository, decide, PolicyService } from '../authorization/policy.service.js';

import { NotificationPreferencesRepository, wants, type ResolvedPreferences } from './notification-preferences.js';

import type { NotificationChannel, NotificationEventType } from '../platform-kernel/db/tables/notifications.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Who receives a notification (FR-079 to FR-081, research D20, T162).
 *
 * 1. Candidates by event: the owner for their own tickets (`message.customer_on_my_ticket`,
 *    `ticket.assigned_to_me`, `ticket.my_ticket_changed`, `ticket.reminder_reached`); everyone
 *    with view on the group for `ticket.arrived_in_group` and `message.customer_on_unassigned`, and
 *    on Ungrouped for `ticket.ungrouped_created`; the mentioned users for `mention`; for SLA
 *    events, the owner, or the group's viewers while the ticket is unassigned. Ticket
 *    subscriptions don't exist yet (no table in data-model.md), so they add nobody.
 * 2. The actor is dropped: nobody is notified about their own action (FR-081).
 * 3. Anyone who can't view the ticket now is dropped (the policy service). Customers hold no
 *    staff access, so they never receive these, internal-note mentions included (FR-081).
 * 4. Preferences: the master switch and the event's toggle for the channel (FR-080).
 *
 * `resolveRecipients` is the whole rule over injectable lookups, so unit tests can drive it
 * without a database.
 */

export interface NotificationTarget {
  eventType: NotificationEventType;
  ticket: { groupId: string | null; ownerId: string | null };
  /** The user who caused it; `null` for the system, routing or a customer. */
  actorUserId: string | null;
  /** `mention` only. */
  mentionedUserIds?: readonly string[];
}

export interface RecipientSources {
  groupViewers(groupId: string | null): Promise<readonly string[]>;
  canView(userId: string, groupId: string | null): Promise<boolean>;
  preferences(userIds: readonly string[]): Promise<ReadonlyMap<string, ResolvedPreferences>>;
}

async function candidatesFor(target: NotificationTarget, sources: RecipientSources): Promise<readonly string[]> {
  const { eventType, ticket } = target;
  switch (eventType) {
    case 'message.customer_on_my_ticket':
    case 'ticket.assigned_to_me':
    case 'ticket.my_ticket_changed':
    case 'ticket.reminder_reached':
      return ticket.ownerId === null ? [] : [ticket.ownerId];
    case 'ticket.ungrouped_created':
      return sources.groupViewers(null);
    case 'ticket.arrived_in_group':
    case 'message.customer_on_unassigned':
      return ticket.groupId === null ? [] : sources.groupViewers(ticket.groupId);
    case 'mention':
      return target.mentionedUserIds ?? [];
    case 'sla.warning':
    case 'sla.breached':
      return ticket.ownerId === null ? sources.groupViewers(ticket.groupId) : [ticket.ownerId];
  }
}

export async function resolveRecipients(target: NotificationTarget, sources: RecipientSources, channel: NotificationChannel): Promise<string[]> {
  const candidates = [...new Set(await candidatesFor(target, sources))].filter((id) => id !== target.actorUserId);
  const visible: string[] = [];
  for (const id of candidates) {
    if (await sources.canView(id, target.ticket.groupId)) visible.push(id);
  }
  const preferences = await sources.preferences(visible);
  return visible.filter((id) => {
    const resolved = preferences.get(id);
    return resolved !== undefined && wants(resolved, target.eventType, channel);
  });
}

@Injectable()
export class RecipientResolver {
  constructor(private readonly policy: PolicyService) {}

  resolve(ctx: TenantContext, tx: TenantTransaction, target: NotificationTarget, channel: NotificationChannel): Promise<string[]> {
    return resolveRecipients(target, this.sources(ctx, tx), channel);
  }

  private sources(ctx: TenantContext, tx: TenantTransaction): RecipientSources {
    return {
      groupViewers: (groupId) => new AccessRepository(ctx).groupViewerIds(tx, groupId),
      canView: async (userId, groupId) =>
        decide(await this.policy.effectiveAccessIn(ctx, tx, userId), 'ticket.view', { type: 'ticket', groupId }) === 'allow',
      preferences: (userIds) => new NotificationPreferencesRepository(ctx).forUsers(tx, userIds),
    };
  }
}
