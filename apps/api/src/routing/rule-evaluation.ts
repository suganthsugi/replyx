import type { RoutingActions, RoutingConditions } from '../platform-kernel/db/tables/routing.js';
import type { TicketPriority } from '../platform-kernel/db/tables/tickets.js';

/**
 * Pure rule evaluation (FR-059–FR-061, data-model.md "Routing rules (P2)"). No database, clock or
 * Nest: the rule-based router (ticket creation) and the dry-run endpoint (`POST
 * /routing-rules/test`, T216) both call `evaluateRules` with data they loaded, so a dry run can
 * never disagree with real routing.
 *
 * - Rules are taken in `position` order (ties by id); disabled rules are ignored; the first rule
 *   that matches and whose group is active wins.
 * - A rule matches when every kind of condition it specifies matches (AND across kinds). A rule
 *   that specifies none never matches, so an unfinished rule cannot catch every ticket.
 * - A matching rule whose group is inactive or missing is skipped (recorded in `skipped`) and the
 *   next rule is tried.
 */

export interface RoutingRuleRecord {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingConditions;
  actions: RoutingActions;
}

export interface RoutingSubject {
  /** The customer's first message. */
  messageBody: string;
  customerEmail: string;
  customerTagIds: readonly string[];
}

export type GroupStatus = 'active' | 'inactive';

export type SkipReason = 'group_inactive' | 'group_missing';

export interface SkippedRule {
  ruleId: string;
  ruleName: string;
  groupId: string;
  reason: SkipReason;
}

export interface MatchedRule {
  ruleId: string;
  ruleName: string;
  groupId: string;
  priority?: TicketPriority;
  /** As configured on the rule; callers drop ids that no longer exist before applying. */
  tagIds: string[];
}

export interface RoutingEvaluation {
  /** `null`: nothing matched (the ticket stays in Needs Triage). */
  matched: MatchedRule | null;
  /** Rules whose conditions matched but whose group could not take the ticket, in position order. */
  skipped: SkippedRule[];
}

/** Statuses of the groups the rules target; a group absent from the map no longer exists. */
export type GroupStatusLookup = ReadonlyMap<string, GroupStatus>;

export function evaluateRules(
  rules: readonly RoutingRuleRecord[],
  subject: RoutingSubject,
  groups: GroupStatusLookup,
): RoutingEvaluation {
  const skipped: SkippedRule[] = [];
  const ordered = rules.filter((rule) => rule.enabled).sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
  for (const rule of ordered) {
    if (!ruleMatches(rule.conditions, subject)) continue;
    const groupId = rule.actions.groupId;
    const status = groups.get(groupId);
    if (status !== 'active') {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, groupId, reason: status === undefined ? 'group_missing' : 'group_inactive' });
      continue;
    }
    return {
      matched: {
        ruleId: rule.id,
        ruleName: rule.name,
        groupId,
        ...(rule.actions.priority === undefined ? {} : { priority: rule.actions.priority }),
        tagIds: [...new Set(rule.actions.tagIds ?? [])],
      },
      skipped,
    };
  }
  return { matched: null, skipped };
}

/** True when the conditions specify at least one part and every specified part matches. */
export function ruleMatches(conditions: RoutingConditions, subject: RoutingSubject): boolean {
  const any = cleanPhrases(conditions.messageContainsAny);
  const all = cleanPhrases(conditions.messageContainsAll);
  const tagIds = strings(conditions.customerTagIds);
  const domains = cleanDomains(conditions.emailDomains);
  if (any.length === 0 && all.length === 0 && tagIds.length === 0 && domains.length === 0) return false;

  if (any.length > 0 && !any.some((phrase) => containsPhrase(subject.messageBody, phrase))) return false;
  if (all.length > 0 && !all.every((phrase) => containsPhrase(subject.messageBody, phrase))) return false;
  if (tagIds.length > 0 && !tagIds.some((id) => subject.customerTagIds.includes(id))) return false;
  if (domains.length > 0 && !domains.includes(emailDomain(subject.customerEmail))) return false;
  return true;
}

// A phrase matches on word boundaries: not glued to a letter, digit or underscore on either side,
// in any script (`\p{L}`), so "refund" matches "a refund." but not "refunded" or "prefund".
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/** Case-insensitive whole-phrase search; whitespace inside the phrase matches any whitespace run. */
export function containsPhrase(text: string, phrase: string): boolean {
  const normalized = collapseWhitespace(phrase);
  if (normalized === '') return false;
  const source = normalized.split(' ').map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<!${WORD_CHAR})${source}(?!${WORD_CHAR})`, 'iu').test(text);
}

/** The part after the last `@`, lower-cased; empty when there is none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

function cleanPhrases(value: unknown): string[] {
  return strings(value).map(collapseWhitespace).filter((phrase) => phrase !== '');
}

function cleanDomains(value: unknown): string[] {
  return strings(value)
    .map((domain) => domain.trim().replace(/^@/, '').toLowerCase())
    .filter((domain) => domain !== '');
}

/** Stored jsonb is validated on write, but evaluation must never throw on a stray value. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
