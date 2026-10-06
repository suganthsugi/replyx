import { formatDurationShort } from '../data-display/duration';

import type { ConditionGroup } from '../../api/generated/model';

/**
 * The shape behind `SlaPolicyBuilder` (US12, FR-084): a policy is a name, conditions on the
 * ticket's priority and group, a business-hours calendar, three optional targets in business
 * minutes and the warning threshold. The API's condition tree is a `ConditionGroup` limited to the
 * `priority` and `group` fields with `is` / `is_not`; the form shows one clause per field.
 *
 * Why "every ticket" is sent as "priority is any of the four": the API needs at least one
 * condition, and a clause naming every priority matches everything. `parseSlaConditions` folds that
 * back into "no condition", so an empty clause always means "any".
 *
 * These types stand in for the generated `SlaPolicy` / `BusinessHours` models; they are
 * structurally the same, so the hooks' types assign to them.
 */

export const PRIORITY_OPTIONS = [
  { id: 'low', name: 'Low' },
  { id: 'normal', name: 'Normal' },
  { id: 'high', name: 'High' },
  { id: 'urgent', name: 'Urgent' },
] as const;

export const UNGROUPED_ID = 'ungrouped';
export const MAX_TARGET_MINUTES = 525_600;
export const MIN_WARNING_PERCENT = 50;
export const MAX_WARNING_PERCENT = 99;
export const DEFAULT_WARNING_PERCENT = 80;
export const MAX_POLICY_NAME_LENGTH = 80;

export type SlaOperator = 'is' | 'is_not';

export interface SlaPolicyRecord {
  id: string;
  name: string;
  position: number;
  conditions: ConditionGroup;
  businessHoursId: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

/** The request body (create and replace). */
export interface SlaPolicyBody {
  name: string;
  position?: number;
  conditions: ConditionGroup;
  businessHoursId: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

/** A calendar as the policy screens need it. */
export interface CalendarOption {
  id: string;
  name: string;
}

export interface SlaClause {
  operator: SlaOperator;
  /** `[]` = the field is not constrained. */
  values: string[];
}

export interface SlaPolicyFormValue {
  name: string;
  priority: SlaClause;
  group: SlaClause;
  businessHoursId: string;
  /** Text as typed; `''` = no target. */
  firstResponseMinutes: string;
  nextResponseMinutes: string;
  resolutionMinutes: string;
  warningPercent: string;
  /** Conditions the form cannot show (set outside this editor); sent back unchanged until reset. */
  foreignConditions: ConditionGroup | null;
}

/** Messages keyed like the API paths: `name`, `conditions`, `businessHoursId`, `firstResponseMinutes`, ... */
export type SlaPolicyIssues = Readonly<Record<string, string>>;

export const TARGET_FIELDS = [
  { key: 'firstResponseMinutes', label: 'First response', description: 'From the ticket being created to the first public reply.' },
  { key: 'nextResponseMinutes', label: 'Next response', description: 'From a customer message that has no reply yet to the next public reply.' },
  { key: 'resolutionMinutes', label: 'Resolution', description: 'From the ticket being created to resolved or closed. Pending states pause the clock.' },
] as const;

export type TargetKey = (typeof TARGET_FIELDS)[number]['key'];

const emptyClause = (): SlaClause => ({ operator: 'is', values: [] });

export function emptySlaPolicyForm(businessHoursId = ''): SlaPolicyFormValue {
  return {
    name: '',
    priority: emptyClause(),
    group: emptyClause(),
    businessHoursId,
    firstResponseMinutes: '',
    nextResponseMinutes: '',
    resolutionMinutes: '',
    warningPercent: String(DEFAULT_WARNING_PERCENT),
    foreignConditions: null,
  };
}

// ---- conditions ---------------------------------------------------------------------------------

type ParsedConditions = { supported: true; priority: SlaClause; group: SlaClause } | { supported: false };

function valuesOf(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) return value;
  return undefined;
}

/** Reads a stored tree into clauses; `supported: false` when it uses anything beyond one `is` / `is_not` per field joined by "and". */
export function parseSlaConditions(conditions: ConditionGroup): ParsedConditions {
  if (conditions.op !== 'and') return { supported: false };
  let priority: SlaClause | undefined;
  let group: SlaClause | undefined;
  for (const item of conditions.items) {
    if ('items' in item) return { supported: false };
    const operator = item.operator;
    const values = valuesOf(item.value);
    if ((operator !== 'is' && operator !== 'is_not') || values === undefined) return { supported: false };
    if (item.field === 'priority' && priority === undefined) priority = { operator, values };
    else if (item.field === 'group' && group === undefined) group = { operator, values };
    else return { supported: false };
  }
  const everyPriority = priority !== undefined && priority.operator === 'is' && PRIORITY_OPTIONS.every((option) => priority.values.includes(option.id));
  return {
    supported: true,
    priority: priority === undefined || everyPriority ? emptyClause() : priority,
    group: group ?? emptyClause(),
  };
}

/** Builds the tree. No clause at all becomes "priority is any of the four", which matches every ticket. */
export function buildSlaConditions(priority: SlaClause, group: SlaClause): ConditionGroup {
  const items: ConditionGroup['items'] = [];
  if (priority.values.length > 0) items.push({ field: 'priority', operator: priority.operator, value: priority.values });
  if (group.values.length > 0) items.push({ field: 'group', operator: group.operator, value: group.values });
  if (items.length === 0) items.push({ field: 'priority', operator: 'is', value: PRIORITY_OPTIONS.map((option) => option.id) });
  return { op: 'and', items };
}

// ---- record <-> form ----------------------------------------------------------------------------

const minutesText = (minutes: number | null): string => (minutes === null ? '' : String(minutes));

export function slaPolicyToForm(policy: SlaPolicyRecord): SlaPolicyFormValue {
  const parsed = parseSlaConditions(policy.conditions);
  return {
    name: policy.name,
    priority: parsed.supported ? parsed.priority : emptyClause(),
    group: parsed.supported ? parsed.group : emptyClause(),
    businessHoursId: policy.businessHoursId,
    firstResponseMinutes: minutesText(policy.firstResponseMinutes),
    nextResponseMinutes: minutesText(policy.nextResponseMinutes),
    resolutionMinutes: minutesText(policy.resolutionMinutes),
    warningPercent: String(policy.warningPercent),
    foreignConditions: parsed.supported ? null : policy.conditions,
  };
}

function toMinutes(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The request body for a validated form. `position` is left out so an edit keeps the policy's place. */
export function formToSlaPolicyBody(form: SlaPolicyFormValue): SlaPolicyBody {
  return {
    name: form.name.trim(),
    conditions: form.foreignConditions ?? buildSlaConditions(form.priority, form.group),
    businessHoursId: form.businessHoursId,
    firstResponseMinutes: toMinutes(form.firstResponseMinutes),
    nextResponseMinutes: toMinutes(form.nextResponseMinutes),
    resolutionMinutes: toMinutes(form.resolutionMinutes),
    warningPercent: Number(form.warningPercent),
  };
}

/** The body of an existing policy, to resend it with one thing changed (its position). */
export function slaPolicyToBody(policy: SlaPolicyRecord, position: number): SlaPolicyBody {
  return {
    name: policy.name,
    position,
    conditions: policy.conditions,
    businessHoursId: policy.businessHoursId,
    firstResponseMinutes: policy.firstResponseMinutes,
    nextResponseMinutes: policy.nextResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    warningPercent: policy.warningPercent,
  };
}

export function isSlaPolicyFormEqual(a: SlaPolicyFormValue, b: SlaPolicyFormValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Positions to write after a move. Positions need not be contiguous (or even distinct) in storage,
 * so the new order is written as 0..n-1 wherever a policy's stored position differs.
 */
export function positionChanges(ordered: readonly SlaPolicyRecord[]): { policy: SlaPolicyRecord; position: number }[] {
  return ordered.flatMap((policy, index) => (policy.position === index ? [] : [{ policy, position: index }]));
}

// ---- validation ---------------------------------------------------------------------------------

function wholeNumber(text: string): number | undefined {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

export function validateSlaPolicyForm(form: SlaPolicyFormValue, calendars: readonly CalendarOption[]): Record<string, string> {
  const found: Record<string, string> = {};
  if (form.name.trim() === '') found['name'] = 'Enter a name.';
  else if (form.name.trim().length > MAX_POLICY_NAME_LENGTH) found['name'] = `Use ${MAX_POLICY_NAME_LENGTH} characters or fewer.`;

  if (form.businessHoursId === '') found['businessHoursId'] = 'Choose a business-hours calendar.';
  else if (!calendars.some((calendar) => calendar.id === form.businessHoursId)) found['businessHoursId'] = 'That calendar no longer exists. Choose another.';

  for (const { key } of TARGET_FIELDS) {
    const text = form[key].trim();
    if (text === '') continue;
    const minutes = wholeNumber(text);
    if (minutes === undefined || minutes < 1 || minutes > MAX_TARGET_MINUTES) {
      found[key] = `Enter a whole number of minutes from 1 to ${MAX_TARGET_MINUTES.toLocaleString('en-US')}, or leave it blank.`;
    }
  }

  const percent = wholeNumber(form.warningPercent);
  if (percent === undefined || percent < MIN_WARNING_PERCENT || percent > MAX_WARNING_PERCENT) {
    found['warningPercent'] = `Enter a whole number from ${MIN_WARNING_PERCENT} to ${MAX_WARNING_PERCENT}.`;
  }
  return found;
}

const ISSUE_MESSAGES: Record<string, string> = {
  required: 'This field is required.',
  too_small: 'This value is too small.',
  too_big: 'This value is too large.',
  too_long: 'This is too long.',
  invalid: 'This value is not valid.',
  invalid_type: 'This value is not valid.',
  invalid_value: 'Choose one of the available options.',
  unrecognized_key: 'This field is not supported.',
};

/** Folds the API's `details` paths onto the form's fields (`conditions.items.0.value` -> `conditions`). */
export function slaIssuesFromApi(fieldErrors: Readonly<Record<string, string>>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [path, issue] of Object.entries(fieldErrors)) {
    const key = path.startsWith('conditions') ? 'conditions' : path;
    if (found[key] !== undefined) continue;
    found[key] =
      key === 'conditions' && issue === 'invalid_value'
        ? 'A condition names a group that no longer exists, or one this editor cannot use.'
        : (ISSUE_MESSAGES[issue] ?? `${issue.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}.`);
  }
  return found;
}

// ---- summaries ----------------------------------------------------------------------------------

export function priorityName(id: string): string {
  return PRIORITY_OPTIONS.find((option) => option.id === id)?.name ?? id;
}

function clauseText(label: string, clause: SlaClause, names: (id: string) => string): string | undefined {
  if (clause.values.length === 0) return undefined;
  return `${label} ${clause.operator === 'is' ? 'is' : 'is not'} ${clause.values.map(names).join(' or ')}`;
}

/** "Priority is Urgent or High, Group is Billing"; "Every ticket" when nothing narrows it. */
export function summarizeSlaConditions(conditions: ConditionGroup, groupNames: ReadonlyMap<string, string>): string {
  const parsed = parseSlaConditions(conditions);
  if (!parsed.supported) return 'Custom conditions';
  const parts = [
    clauseText('Priority', parsed.priority, priorityName),
    clauseText('Group', parsed.group, (id) => (id === UNGROUPED_ID ? 'Ungrouped' : (groupNames.get(id) ?? 'a deleted group'))),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'Every ticket' : parts.join(', ');
}

/** "First response 1h, Next response 30m, Resolution 1d"; "No targets" when none is set. */
export function summarizeTargets(policy: Pick<SlaPolicyRecord, 'firstResponseMinutes' | 'nextResponseMinutes' | 'resolutionMinutes'>): string {
  const parts = TARGET_FIELDS.flatMap(({ key, label }) => {
    const minutes = policy[key];
    return minutes === null ? [] : [`${label} ${formatDurationShort(minutes)}`];
  });
  return parts.length === 0 ? 'No targets' : parts.join(', ');
}
