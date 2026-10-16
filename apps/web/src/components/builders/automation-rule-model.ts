import { formatDuration, isTreeComplete, parseDuration, type DurationUnit } from './filter-model';
import { ROUTING_PRIORITY_OPTIONS, emptyRuleForm, priorityLabel, type RuleConfig, type RuleFormValue, type RuleOption } from './rule-model';

import type {
  AutomationActions,
  AutomationRule,
  AutomationRuleInput,
  AutomationTrigger,
  AutomationTriggerEvent,
  AutomationTriggerSince,
  ConditionGroup,
  Priority,
  TicketState,
} from '../../api/generated/model';

/**
 * The automation rule form (US17, FR-088): `RuleBuilder`'s name, switch and actions, plus a trigger
 * and a view condition tree (or "every ticket"). The limits mirror
 * `apps/api/src/routing/automation/automation-rule-input.ts`; the API re-validates everything and
 * answers with the same paths (`trigger.after`, `conditions.items.0.value`, `actions.ownerId`).
 */

export const AUTOMATION_RULE_LIMIT = 100;
const MAX_LIST_ITEMS = 20;
export const AUTO_REPLY_MAX = 10_000;
const MIN_AFTER_MINUTES = 5;
const MAX_AFTER_MINUTES = 90 * 24 * 60;

/** The owner choice that clears the owner (`ownerId: null`). */
export const UNASSIGN_OWNER = 'unassigned';

export const TRIGGER_EVENT_OPTIONS: readonly { value: AutomationTriggerEvent; label: string }[] = [
  { value: 'ticket.created', label: 'A ticket is created' },
  { value: 'ticket.updated', label: 'A ticket is updated' },
  { value: 'message.created', label: 'The customer sends a message' },
  { value: 'time.elapsed', label: 'Time passes' },
];

export const TRIGGER_SINCE_OPTIONS: readonly { value: AutomationTriggerSince; label: string }[] = [
  { value: 'last_customer_message_at', label: "the customer's last message" },
  { value: 'last_agent_reply_at', label: 'the last agent reply' },
  { value: 'updated_at', label: 'the ticket last changed' },
  { value: 'created_at', label: 'the ticket was created' },
];

export const AUTOMATION_STATE_OPTIONS: readonly RuleOption[] = [
  { id: 'open', name: 'Open' },
  { id: 'pending_reminder', name: 'Pending (reminder)' },
  { id: 'pending_close', name: 'Pending (close)' },
  { id: 'resolved', name: 'Resolved' },
  { id: 'closed', name: 'Closed' },
];

const isPendingState = (state: string | undefined) => state === 'pending_reminder' || state === 'pending_close';

export const AUTOMATION_RULE_CONFIG: RuleConfig = {
  noun: 'automation rule',
  maxNameLength: 80,
  disabledLabel: 'Disabled: never runs',
  conditions: {
    title: 'Only for tickets that match',
    description: 'The ticket must match these conditions when the trigger fires.',
    fields: [],
  },
  actions: {
    title: 'Then',
    description: 'Fill in what the rule should do. Fields left as "Don\'t change" are not touched. Actions follow the same rules as a person making the change.',
    requireOne: true,
    requireOneMessage: 'Choose at least one action.',
    fields: [
      { key: 'groupId', label: 'Move to group', kind: 'single', lookup: 'groups', noneLabel: "Don't change", unknownLabel: 'Unknown group' },
      {
        key: 'ownerId',
        label: 'Set owner',
        kind: 'single',
        lookup: 'owners',
        noneLabel: "Don't change",
        unknownLabel: 'Unknown person',
        description: 'Skipped when the person cannot work on the ticket\'s group.',
      },
      { key: 'priority', label: 'Set priority', kind: 'single', options: ROUTING_PRIORITY_OPTIONS, noneLabel: "Don't change" },
      { key: 'state', label: 'Set state', kind: 'single', options: AUTOMATION_STATE_OPTIONS, noneLabel: "Don't change" },
      {
        key: 'pendingInHours',
        label: 'Pending for',
        kind: 'number',
        unit: 'hours',
        min: 1,
        max: 720,
        required: true,
        requiredMessage: 'Enter how many hours the ticket stays pending.',
        description: 'From 1 to 720 hours.',
        visibleWhen: (form) => isPendingState(form.actions.state?.[0]),
      },
      { key: 'addTagIds', label: 'Add tags', kind: 'multi', lookup: 'tags', maxItems: MAX_LIST_ITEMS, unknownLabel: 'Unknown tag', noOptionsText: 'No matching tags' },
      {
        key: 'autoReply',
        label: 'Send a reply to the customer',
        kind: 'text',
        maxLength: AUTO_REPLY_MAX,
        description: 'Sent once per ticket each time the rule runs, as a public reply.',
      },
      {
        key: 'notifyUserIds',
        label: 'Notify people',
        kind: 'multi',
        lookup: 'owners',
        maxItems: MAX_LIST_ITEMS,
        unknownLabel: 'Unknown person',
        noOptionsText: 'No matching people',
        description: 'They get an "Automation rule" notification on their usual channels.',
      },
    ],
  },
};

export interface AutomationTriggerForm {
  event: AutomationTriggerEvent;
  /** The wait of `time.elapsed`, as typed. */
  amount: string;
  unit: DurationUnit;
  since: AutomationTriggerSince;
}

export interface AutomationFormValue {
  /** Name, switch and actions; `conditions` is unused. */
  rule: RuleFormValue;
  trigger: AutomationTriggerForm;
  /** True: conditions are `null` (every ticket). */
  everyTicket: boolean;
  conditions: ConditionGroup;
}

const DEFAULT_TRIGGER: AutomationTriggerForm = { event: 'ticket.created', amount: '2', unit: 'days', since: 'last_customer_message_at' };

export function emptyAutomationForm(): AutomationFormValue {
  return {
    rule: emptyRuleForm(AUTOMATION_RULE_CONFIG),
    trigger: DEFAULT_TRIGGER,
    everyTicket: true,
    conditions: { op: 'and', items: [{ field: 'state', operator: 'is_not', value: ['closed'] }] },
  };
}

export function automationRuleToForm(rule: AutomationRule): AutomationFormValue {
  const { actions, trigger } = rule;
  const one = (value: string | number | null | undefined): string[] => (value === undefined ? [] : [value === null ? UNASSIGN_OWNER : String(value)]);
  const after = parseDuration(trigger.after);
  const empty = emptyAutomationForm();
  return {
    rule: {
      name: rule.name,
      enabled: rule.enabled,
      conditions: {},
      actions: {
        // A rule that clears the group shows as "Don't change": the form offers no "no group" choice.
        groupId: actions.groupId === undefined || actions.groupId === null ? [] : [actions.groupId],
        ownerId: one(actions.ownerId),
        priority: one(actions.priority),
        state: one(actions.state),
        pendingInHours: one(actions.pendingInHours),
        addTagIds: actions.addTagIds ?? [],
        autoReply: one(actions.autoReply),
        notifyUserIds: actions.notifyUserIds ?? [],
      },
    },
    trigger: {
      event: trigger.event,
      amount: after === null ? DEFAULT_TRIGGER.amount : String(after.amount),
      unit: after?.unit ?? DEFAULT_TRIGGER.unit,
      since: trigger.since ?? DEFAULT_TRIGGER.since,
    },
    everyTicket: rule.conditions === null,
    conditions: rule.conditions === null ? empty.conditions : 'op' in rule.conditions ? rule.conditions : { op: 'and', items: [rule.conditions] },
  };
}

function afterMinutes(trigger: AutomationTriggerForm): number | null {
  const amount = Number(trigger.amount);
  if (trigger.amount.trim() === '' || !Number.isInteger(amount) || amount <= 0) return null;
  const perUnit: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 1440, weeks: 10080 };
  return amount * perUnit[trigger.unit];
}

export function formToAutomationInput(form: AutomationFormValue): AutomationRuleInput {
  const { trigger } = form;
  const apiTrigger: AutomationTrigger =
    trigger.event === 'time.elapsed' ? { event: trigger.event, after: formatDuration(Number(trigger.amount), trigger.unit), since: trigger.since } : { event: trigger.event };

  const values = form.rule.actions;
  const first = (key: string) => {
    const value = values[key]?.[0];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const list = (key: string) => (values[key] !== undefined && values[key].length > 0 ? values[key] : undefined);
  const actions: AutomationActions = {};
  const groupId = first('groupId');
  if (groupId !== undefined) actions.groupId = groupId;
  const ownerId = first('ownerId');
  if (ownerId !== undefined) actions.ownerId = ownerId === UNASSIGN_OWNER ? null : ownerId;
  const priority = first('priority');
  if (priority !== undefined) actions.priority = priority as Priority;
  const state = first('state');
  if (state !== undefined) actions.state = state as TicketState;
  const hours = first('pendingInHours');
  if (hours !== undefined && isPendingState(state)) actions.pendingInHours = Number(hours);
  const tags = list('addTagIds');
  if (tags) actions.addTagIds = tags;
  const reply = first('autoReply');
  if (reply !== undefined) actions.autoReply = reply.trim();
  const notify = list('notifyUserIds');
  if (notify) actions.notifyUserIds = notify;

  return { name: form.rule.name.trim(), enabled: form.rule.enabled, trigger: apiTrigger, conditions: form.everyTicket ? null : form.conditions, actions };
}

/** Checks beyond `validateRuleForm`: the wait and the condition tree. Keys are API paths. */
export function validateAutomationExtras(form: AutomationFormValue): Record<string, string> {
  const found: Record<string, string> = {};
  if (form.trigger.event === 'time.elapsed') {
    const minutes = afterMinutes(form.trigger);
    if (minutes === null || minutes < MIN_AFTER_MINUTES || minutes > MAX_AFTER_MINUTES) found['trigger.after'] = 'Choose a wait between 5 minutes and 90 days.';
  }
  if (!form.everyTicket && !isTreeComplete(form.conditions)) {
    found.conditions = form.conditions.items.length === 0 ? 'Add a condition, or choose "Every ticket".' : 'Give every condition a value, or remove it.';
  }
  return found;
}

export function isAutomationFormEqual(a: AutomationFormValue, b: AutomationFormValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- summaries --------------------------------------------------------------------------------

const UNIT_SINGULAR: Record<DurationUnit, string> = { minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week' };

/** `When a ticket is created`, `2 days after the customer's last message`. */
export function summarizeTrigger(trigger: AutomationTrigger): string {
  if (trigger.event === 'time.elapsed') {
    const after = parseDuration(trigger.after);
    const since = TRIGGER_SINCE_OPTIONS.find((option) => option.value === trigger.since)?.label ?? 'the start';
    if (after === null) return `Some time after ${since}`;
    return `${after.amount} ${after.amount === 1 ? UNIT_SINGULAR[after.unit] : after.unit} after ${since}`;
  }
  const label = TRIGGER_EVENT_OPTIONS.find((option) => option.value === trigger.event)?.label ?? trigger.event;
  return `When ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

export function summarizeAutomationConditions(conditions: AutomationRule['conditions']): string {
  if (conditions === null) return 'Every ticket';
  const count = 'op' in conditions ? countLeaves(conditions) : 1;
  return `Tickets matching ${count} ${count === 1 ? 'condition' : 'conditions'}`;
}

function countLeaves(group: ConditionGroup): number {
  return group.items.reduce((sum, item) => sum + ('op' in item ? countLeaves(item) : 1), 0);
}

export function stateLabel(state: string): string {
  return AUTOMATION_STATE_OPTIONS.find((option) => option.id === state)?.name ?? state;
}

/** `Reply to the customer, state Pending (close) for 48 hours, notify Ada`. */
export function summarizeAutomationActions(
  actions: AutomationActions,
  names: { groups: ReadonlyMap<string, string>; people: ReadonlyMap<string, string>; tags: ReadonlyMap<string, string> },
): string {
  const parts: string[] = [];
  const list = (ids: readonly string[], map: ReadonlyMap<string, string>, unknown: string) => ids.map((id) => map.get(id) ?? unknown).join(', ');
  if (actions.autoReply !== undefined) parts.push('reply to the customer');
  if (actions.groupId !== undefined) parts.push(actions.groupId === null ? 'remove the group' : `move to ${names.groups.get(actions.groupId) ?? 'an unknown group'}`);
  if (actions.ownerId !== undefined) parts.push(actions.ownerId === null ? 'unassign' : `assign to ${names.people.get(actions.ownerId) ?? 'an unknown person'}`);
  if (actions.priority !== undefined) parts.push(`priority ${priorityLabel(actions.priority)}`);
  if (actions.state !== undefined) {
    parts.push(`state ${stateLabel(actions.state)}${actions.pendingInHours === undefined ? '' : ` for ${actions.pendingInHours} ${actions.pendingInHours === 1 ? 'hour' : 'hours'}`}`);
  }
  if (actions.addTagIds?.length) parts.push(`add tags ${list(actions.addTagIds, names.tags, 'unknown tag')}`);
  if (actions.notifyUserIds?.length) parts.push(`notify ${list(actions.notifyUserIds, names.people, 'unknown person')}`);
  if (parts.length === 0) return 'No actions';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
