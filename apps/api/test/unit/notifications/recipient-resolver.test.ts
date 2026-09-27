import { describe, expect, it } from 'vitest';

import { BUILT_IN_DEFAULTS } from '../../../src/notifications/notification-preferences.js';
import { resolveRecipients, type NotificationTarget, type RecipientSources } from '../../../src/notifications/recipient-resolver.js';

import type { NotificationEventType } from '../../../src/platform-kernel/db/tables/notifications.js';
import type { ResolvedPreferences } from '../../../src/notifications/notification-preferences.js';

/**
 * T166: `resolveRecipients` over fake `RecipientSources` (research D20, T162) - no database.
 * Covers candidate selection for every event type, actor exclusion, view-access exclusion
 * (including customers on mentions), and preferences.
 */

const OWNER = 'owner-1';
const ACTOR = 'actor-1';
const GROUP = 'group-1';
const VIEWER_A = 'viewer-a';
const VIEWER_B = 'viewer-b';
const CUSTOMER = 'customer-1';

function allow(...ids: string[]): ResolvedPreferences {
  void ids;
  return { enabled: true, events: BUILT_IN_DEFAULTS };
}

function target(eventType: NotificationEventType, overrides: Partial<NotificationTarget> = {}): NotificationTarget {
  return {
    eventType,
    ticket: { groupId: GROUP, ownerId: OWNER },
    actorUserId: ACTOR,
    ...overrides,
  };
}

/** Every candidate can view and wants every event by default; override per test. */
function fakeSources(overrides: Partial<RecipientSources> = {}): RecipientSources {
  return {
    groupViewers: async (groupId) => (groupId === null ? [VIEWER_A, VIEWER_B] : [VIEWER_A, VIEWER_B]),
    canView: async () => true,
    preferences: async (userIds) => new Map(userIds.map((id) => [id, allow()])),
    ...overrides,
  };
}

describe('resolveRecipients', () => {
  it.each<[NotificationEventType, string[]]>([
    ['message.customer_on_my_ticket', [OWNER]],
    ['ticket.assigned_to_me', [OWNER]],
    ['ticket.my_ticket_changed', [OWNER]],
    ['ticket.reminder_reached', [OWNER]],
  ])('%s notifies the owner', async (eventType, expected) => {
    const recipients = await resolveRecipients(target(eventType), fakeSources(), 'in_app');
    expect(recipients).toEqual(expected);
  });

  it.each<[NotificationEventType, string[]]>([
    ['message.customer_on_my_ticket', []],
    ['ticket.my_ticket_changed', []],
    ['ticket.reminder_reached', []],
  ])('%s notifies nobody when the ticket has no owner', async (eventType) => {
    const recipients = await resolveRecipients(target(eventType, { ticket: { groupId: GROUP, ownerId: null } }), fakeSources(), 'in_app');
    expect(recipients).toEqual([]);
  });

  it('ticket.ungrouped_created notifies Ungrouped viewers (groupId null)', async () => {
    let queriedGroupId: string | null | undefined;
    const sources = fakeSources({
      groupViewers: async (groupId) => {
        queriedGroupId = groupId;
        return [VIEWER_A, VIEWER_B];
      },
    });
    const recipients = await resolveRecipients(target('ticket.ungrouped_created', { ticket: { groupId: null, ownerId: null } }), sources, 'in_app');
    expect(queriedGroupId).toBeNull();
    expect(recipients.sort()).toEqual([VIEWER_A, VIEWER_B].sort());
  });

  it.each<NotificationEventType>(['ticket.arrived_in_group', 'message.customer_on_unassigned'])(
    '%s notifies the group viewers',
    async (eventType) => {
      let queriedGroupId: string | null | undefined;
      const sources = fakeSources({
        groupViewers: async (groupId) => {
          queriedGroupId = groupId;
          return [VIEWER_A, VIEWER_B];
        },
      });
      const recipients = await resolveRecipients(target(eventType), sources, 'in_app');
      expect(queriedGroupId).toBe(GROUP);
      expect(recipients.sort()).toEqual([VIEWER_A, VIEWER_B].sort());
    },
  );

  it.each<NotificationEventType>(['ticket.arrived_in_group', 'message.customer_on_unassigned'])(
    '%s notifies nobody for an ungrouped ticket',
    async (eventType) => {
      const recipients = await resolveRecipients(target(eventType, { ticket: { groupId: null, ownerId: null } }), fakeSources(), 'in_app');
      expect(recipients).toEqual([]);
    },
  );

  it('mention notifies exactly the mentioned users, deduplicated', async () => {
    const recipients = await resolveRecipients(
      target('mention', { mentionedUserIds: [VIEWER_A, VIEWER_B, VIEWER_A] }),
      fakeSources(),
      'in_app',
    );
    expect(recipients.sort()).toEqual([VIEWER_A, VIEWER_B].sort());
  });

  it('mention notifies nobody when mentionedUserIds is absent', async () => {
    const recipients = await resolveRecipients(target('mention'), fakeSources(), 'in_app');
    expect(recipients).toEqual([]);
  });

  it.each<NotificationEventType>(['sla.warning', 'sla.breached'])('%s notifies the owner when the ticket is assigned', async (eventType) => {
    const recipients = await resolveRecipients(target(eventType), fakeSources(), 'in_app');
    expect(recipients).toEqual([OWNER]);
  });

  it.each<NotificationEventType>(['sla.warning', 'sla.breached'])('%s notifies the group viewers when the ticket is unassigned', async (eventType) => {
    const recipients = await resolveRecipients(target(eventType, { ticket: { groupId: GROUP, ownerId: null } }), fakeSources(), 'in_app');
    expect(recipients.sort()).toEqual([VIEWER_A, VIEWER_B].sort());
  });

  it('drops the actor from the candidates', async () => {
    const sources = fakeSources({ groupViewers: async () => [VIEWER_A, ACTOR] });
    const recipients = await resolveRecipients(target('ticket.arrived_in_group', { actorUserId: ACTOR }), sources, 'in_app');
    expect(recipients).toEqual([VIEWER_A]);
  });

  it('drops the owner as a recipient when the owner is the actor', async () => {
    const recipients = await resolveRecipients(target('ticket.assigned_to_me', { actorUserId: OWNER }), fakeSources(), 'in_app');
    expect(recipients).toEqual([]);
  });

  it('drops candidates who can no longer view the ticket', async () => {
    const sources = fakeSources({
      groupViewers: async () => [VIEWER_A, VIEWER_B],
      canView: async (userId) => userId === VIEWER_A,
    });
    const recipients = await resolveRecipients(target('ticket.arrived_in_group'), sources, 'in_app');
    expect(recipients).toEqual([VIEWER_A]);
  });

  it('customers never receive internal-note (or any) mentions: canView false drops them', async () => {
    const sources = fakeSources({
      canView: async (userId) => userId !== CUSTOMER,
    });
    const recipients = await resolveRecipients(target('mention', { mentionedUserIds: [VIEWER_A, CUSTOMER] }), sources, 'in_app');
    expect(recipients).toEqual([VIEWER_A]);
    expect(recipients).not.toContain(CUSTOMER);
  });

  it('applies preferences: the master switch off drops the recipient', async () => {
    const sources = fakeSources({
      preferences: async (userIds) => new Map(userIds.map((id) => [id, { enabled: false, events: BUILT_IN_DEFAULTS }])),
    });
    const recipients = await resolveRecipients(target('ticket.assigned_to_me'), sources, 'in_app');
    expect(recipients).toEqual([]);
  });

  it('applies preferences: the event/channel toggle off drops the recipient for that channel only', async () => {
    const preferencesOff: ResolvedPreferences = {
      enabled: true,
      events: { ...BUILT_IN_DEFAULTS, 'ticket.assigned_to_me': { inApp: false, push: true, email: false } },
    };
    const sources = fakeSources({ preferences: async (userIds) => new Map(userIds.map((id) => [id, preferencesOff])) });
    const inApp = await resolveRecipients(target('ticket.assigned_to_me'), sources, 'in_app');
    const push = await resolveRecipients(target('ticket.assigned_to_me'), sources, 'push');
    expect(inApp).toEqual([]);
    expect(push).toEqual([OWNER]);
  });

  it('drops a recipient with no resolved preferences entry at all', async () => {
    const sources = fakeSources({ preferences: async () => new Map() });
    const recipients = await resolveRecipients(target('ticket.assigned_to_me'), sources, 'in_app');
    expect(recipients).toEqual([]);
  });
});
