import type { Priority, RoutingActions, RoutingConditions, RoutingRule, RoutingRuleInput } from '../../api/generated/model';

/**
 * The shape behind `RuleBuilder`: a rule is a name, an enabled switch, a set of condition lists and
 * a set of actions. The fields of each set come from a `RuleConfig`, so routing rules (US11) and
 * automation rules (US17) share the form and differ only in configuration. Every list value is a
 * `string[]`: phrases, ids, or a single chosen id (`[]` when nothing is chosen).
 */

export type RuleFieldKind = 'phrases' | 'multi' | 'single' | 'text' | 'number';

export interface RuleOption {
  id: string;
  name: string;
  /** Shown but not choosable, e.g. an inactive group. */
  disabled?: boolean;
}

export interface RuleFieldConfig {
  /** Key in `conditions` / `actions`, equal to the API property name (`tagIds`, `groupId`, ...). */
  key: string;
  label: string;
  kind: RuleFieldKind;
  description?: string;
  /** `multi` and `single` fields: the key in the builder's `lookups`, unless `options` is given. */
  lookup?: string;
  /** Fixed choices (priority). */
  options?: readonly RuleOption[];
  /** `single`: a choice is required (no "None" item). */
  required?: boolean;
  maxItems?: number;
  /** `phrases`: cleans one typed entry (trim, lower-case). Empty results are dropped. */
  normalize?: (raw: string) => string;
  /** Name shown for a chosen id the lookup no longer has (a deleted group or tag). */
  unknownLabel?: string;
  noOptionsText?: string;
  /** Required field left empty. */
  requiredMessage?: string;
  /** `single`: label of the empty choice. Default "None". */
  noneLabel?: string;
  /** `text`: longest value. */
  maxLength?: number;
  /** `number`: whole-number bounds and the unit shown after the box ("hours"). */
  min?: number;
  max?: number;
  unit?: string;
  /** Shown (and validated) only while this returns true, e.g. pending hours for a pending state. */
  visibleWhen?: (form: RuleFormValue) => boolean;
}

export interface RuleSectionConfig {
  title: string;
  description?: string;
  fields: readonly RuleFieldConfig[];
  /** Conditions: at least one field must have a value. */
  requireOne?: boolean;
  requireOneMessage?: string;
}

export interface RuleConfig {
  /** "routing rule", "automation rule": used in labels and messages. */
  noun: string;
  maxNameLength: number;
  /** Switch label while the rule is disabled. */
  disabledLabel?: string;
  conditions: RuleSectionConfig;
  actions: RuleSectionConfig;
}

export interface RuleFormValue {
  name: string;
  enabled: boolean;
  conditions: Record<string, string[]>;
  actions: Record<string, string[]>;
}

/** Field errors keyed like the API paths: `name`, `conditions`, `actions.groupId`, `actions.tagIds.3`. */
export type RuleIssues = Readonly<Record<string, string>>;

export type RuleLookups = Readonly<Record<string, readonly RuleOption[]>>;

// ---- routing configuration --------------------------------------------------------------------

export const ROUTING_PRIORITY_OPTIONS: readonly RuleOption[] = [
  { id: 'low', name: 'Low' },
  { id: 'normal', name: 'Normal' },
  { id: 'high', name: 'High' },
  { id: 'urgent', name: 'Urgent' },
];

export const ROUTING_RULE_LIMIT = 100;
const MAX_LIST_ITEMS = 20;

export const ROUTING_RULE_CONFIG: RuleConfig = {
  noun: 'routing rule',
  maxNameLength: 80,
  conditions: {
    title: 'When a new ticket starts',
    description: 'Every list you fill in must match. Leave the others empty.',
    requireOne: true,
    requireOneMessage: 'Fill in at least one condition.',
    fields: [
      {
        key: 'messageContainsAny',
        label: 'First message contains any of',
        kind: 'phrases',
        description: 'Whole words or phrases, not case sensitive. Press Enter after each one.',
        maxItems: MAX_LIST_ITEMS,
        normalize: (raw) => raw.trim(),
      },
      {
        key: 'messageContainsAll',
        label: 'First message contains all of',
        kind: 'phrases',
        description: 'Every phrase has to appear. Press Enter after each one.',
        maxItems: MAX_LIST_ITEMS,
        normalize: (raw) => raw.trim(),
      },
      {
        key: 'customerTagIds',
        label: 'Customer has any of the tags',
        kind: 'multi',
        lookup: 'tags',
        maxItems: MAX_LIST_ITEMS,
        unknownLabel: 'Unknown tag',
        noOptionsText: 'No matching tags',
      },
      {
        key: 'emailDomains',
        label: 'Customer email domain is',
        kind: 'phrases',
        description: 'For example example.com. Subdomains are not matched. Press Enter after each one.',
        maxItems: MAX_LIST_ITEMS,
        normalize: (raw) => raw.trim().replace(/^@/, '').toLowerCase(),
      },
    ],
  },
  actions: {
    title: 'Then',
    description: 'What happens to the ticket when this rule is the first to match.',
    fields: [
      {
        key: 'groupId',
        label: 'Assign to group',
        kind: 'single',
        lookup: 'groups',
        required: true,
        unknownLabel: 'Unknown group',
        requiredMessage: 'Choose the group that gets these tickets.',
        description: 'Only active groups can be chosen.',
      },
      { key: 'priority', label: 'Set priority', kind: 'single', options: ROUTING_PRIORITY_OPTIONS, description: 'Optional. Leave as None to keep the default.' },
      {
        key: 'tagIds',
        label: 'Add tags',
        kind: 'multi',
        lookup: 'tags',
        maxItems: MAX_LIST_ITEMS,
        unknownLabel: 'Unknown tag',
        noOptionsText: 'No matching tags',
      },
    ],
  },
};

// ---- form value helpers -----------------------------------------------------------------------

export function emptyRuleForm(config: RuleConfig): RuleFormValue {
  const empty = (fields: readonly RuleFieldConfig[]) => Object.fromEntries(fields.map((field) => [field.key, [] as string[]]));
  return { name: '', enabled: true, conditions: empty(config.conditions.fields), actions: empty(config.actions.fields) };
}

export function routingRuleToForm(rule: RoutingRule): RuleFormValue {
  const { conditions, actions } = rule;
  return {
    name: rule.name,
    enabled: rule.enabled,
    conditions: {
      messageContainsAny: conditions.messageContainsAny ?? [],
      messageContainsAll: conditions.messageContainsAll ?? [],
      customerTagIds: conditions.customerTagIds ?? [],
      emailDomains: conditions.emailDomains ?? [],
    },
    actions: {
      groupId: [actions.groupId],
      priority: actions.priority === undefined ? [] : [actions.priority],
      tagIds: actions.tagIds ?? [],
    },
  };
}

/** The API body for a routing rule form. Empty lists are left out. */
export function formToRoutingInput(form: RuleFormValue): RoutingRuleInput {
  const list = (values: string[] | undefined): string[] | undefined => (values === undefined || values.length === 0 ? undefined : values);
  const conditions: RoutingConditions = {};
  const any = list(form.conditions.messageContainsAny);
  const all = list(form.conditions.messageContainsAll);
  const tags = list(form.conditions.customerTagIds);
  const domains = list(form.conditions.emailDomains);
  if (any) conditions.messageContainsAny = any;
  if (all) conditions.messageContainsAll = all;
  if (tags) conditions.customerTagIds = tags;
  if (domains) conditions.emailDomains = domains;

  const actions: RoutingActions = { groupId: form.actions.groupId?.[0] ?? '' };
  const priority = form.actions.priority?.[0];
  if (priority !== undefined) actions.priority = priority as Priority;
  const actionTags = list(form.actions.tagIds);
  if (actionTags) actions.tagIds = actionTags;

  return { name: form.name.trim(), enabled: form.enabled, conditions, actions };
}

export function isRuleFormEqual(a: RuleFormValue, b: RuleFormValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Client-side checks before saving; the API repeats them and answers with the same paths. */
export function validateRuleForm(config: RuleConfig, form: RuleFormValue): Record<string, string> {
  const found: Record<string, string> = {};
  if (form.name.trim() === '') found.name = `Enter a name for the ${config.noun}.`;
  if (config.conditions.requireOne === true && config.conditions.fields.every((field) => (form.conditions[field.key] ?? []).length === 0)) {
    found.conditions = config.conditions.requireOneMessage ?? 'Fill in at least one condition.';
  }
  const shown = (field: RuleFieldConfig) => field.visibleWhen === undefined || field.visibleWhen(form);
  const filled = (field: RuleFieldConfig) => (form.actions[field.key] ?? []).some((value) => value.trim() !== '');
  if (config.actions.requireOne === true && !config.actions.fields.some((field) => shown(field) && filled(field))) {
    found.actions = config.actions.requireOneMessage ?? 'Choose at least one action.';
  }
  for (const field of config.actions.fields) {
    if (!shown(field)) continue;
    if (field.required === true && !filled(field)) {
      found[`actions.${field.key}`] = field.requiredMessage ?? `${field.label} is required.`;
    } else if (field.kind === 'number' && filled(field)) {
      const number = Number(form.actions[field.key]?.[0]);
      if (!Number.isInteger(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) {
        found[`actions.${field.key}`] = `Enter a whole number from ${field.min ?? 0} to ${field.max ?? 'any'}.`;
      }
    }
  }
  return found;
}

// ---- API issues -> messages -------------------------------------------------------------------

const ISSUE_MESSAGES: Record<string, string> = {
  required: 'This field is required.',
  too_small: 'This field is required.',
  too_long: 'This is too long.',
  too_big: 'There are too many entries.',
  invalid: 'This value is not valid.',
  invalid_type: 'This value is not valid.',
  invalid_value: 'Pick one of the available options.',
  invalid_format: 'This value is not valid.',
  unrecognized_key: 'This field is not supported.',
  conditions_required: 'Fill in at least one condition.',
  invalid_duration: 'Choose a wait between 5 minutes and 90 days.',
  owner_me_not_allowed: 'A rule has no viewer, so "owner is me" cannot be used.',
};

/** API issue code (`invalid_value`) -> sentence. Unknown codes are spelled out from the code. */
export function ruleIssueMessage(issue: string): string {
  return ISSUE_MESSAGES[issue] ?? `${issue.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}.`;
}

/** The message for a field: its own path, or the first indexed path under it (`actions.tagIds.2`). */
export function fieldIssue(issues: RuleIssues | undefined, section: 'conditions' | 'actions', key: string): string | undefined {
  if (issues === undefined) return undefined;
  const base = `${section}.${key}`;
  const direct = issues[base];
  if (direct !== undefined) return direct;
  const indexed = Object.keys(issues).find((path) => path.startsWith(`${base}.`));
  return indexed === undefined ? undefined : issues[indexed];
}

// ---- summaries --------------------------------------------------------------------------------

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

function nameList(ids: readonly string[], names: ReadonlyMap<string, string>, unknown: string): string {
  return ids.map((id) => names.get(id) ?? unknown).join(', ');
}

export function toNameMap(options: readonly { id: string; name: string }[]): Map<string, string> {
  return new Map(options.map((option) => [option.id, option.name]));
}

/** One line for the list: `Message contains any of "refund", "invoice"; customer tagged VIP`. */
export function summarizeConditions(conditions: RoutingConditions, tagNames: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  if (conditions.messageContainsAny?.length) parts.push(`message contains any of ${quoteList(conditions.messageContainsAny)}`);
  if (conditions.messageContainsAll?.length) parts.push(`message contains all of ${quoteList(conditions.messageContainsAll)}`);
  if (conditions.customerTagIds?.length) parts.push(`customer has any of the tags ${nameList(conditions.customerTagIds, tagNames, 'unknown tag')}`);
  if (conditions.emailDomains?.length) parts.push(`customer email domain is ${conditions.emailDomains.join(' or ')}`);
  if (parts.length === 0) return 'No conditions';
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function priorityLabel(priority: string): string {
  return ROUTING_PRIORITY_OPTIONS.find((option) => option.id === priority)?.name ?? priority;
}

/** `Assign to Billing, priority High, tags refund, vip`. */
export function summarizeActions(
  actions: { groupId: string; priority?: string; tagIds?: readonly string[] },
  groupNames: ReadonlyMap<string, string>,
  tagNames: ReadonlyMap<string, string>,
): string {
  const parts = [`Assign to ${groupNames.get(actions.groupId) ?? 'an unknown group'}`];
  if (actions.priority !== undefined) parts.push(`priority ${priorityLabel(actions.priority)}`);
  if (actions.tagIds !== undefined && actions.tagIds.length > 0) parts.push(`tags ${nameList(actions.tagIds, tagNames, 'unknown tag')}`);
  return parts.join(', ');
}
