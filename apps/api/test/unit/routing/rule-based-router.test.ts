import { describe, expect, it, vi } from 'vitest';

import { RuleBasedRouter } from '../../../src/routing/rule-based-router.js';
import {
  containsPhrase,
  emailDomain,
  evaluateRules,
  ruleMatches,
  type GroupStatusLookup,
  type RoutingRuleRecord,
  type RoutingSubject,
} from '../../../src/routing/rule-evaluation.js';

import type { TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import type { RoutingEvaluator } from '../../../src/routing/rule-evaluator.service.js';
import type { TicketRow } from '../../../src/tickets/tickets.repository.js';

/**
 * Pure rule evaluation (FR-059-FR-061) and the router's mapping of a decision. No database: the
 * matching rules are plain functions over data.
 */

const G1 = '01920000-0000-7000-8000-0000000000a1';
const G2 = '01920000-0000-7000-8000-0000000000a2';
const TAG = '01920000-0000-7000-8000-0000000000b1';

let counter = 0;
function rule(partial: Partial<RoutingRuleRecord> & Pick<RoutingRuleRecord, 'conditions'>): RoutingRuleRecord {
  counter += 1;
  return {
    id: `01920000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    name: `Rule ${counter}`,
    position: counter,
    enabled: true,
    actions: { groupId: G1 },
    ...partial,
  };
}

const subject = (overrides: Partial<RoutingSubject> = {}): RoutingSubject => ({
  messageBody: 'I want a refund',
  customerEmail: 'pat@example.com',
  customerTagIds: [],
  ...overrides,
});

const active: GroupStatusLookup = new Map([
  [G1, 'active'],
  [G2, 'active'],
]);

describe('containsPhrase', () => {
  it('matches whole words case-insensitively', () => {
    expect(containsPhrase('I WANT A Refund.', 'refund')).toBe(true);
    expect(containsPhrase('refund', 'REFUND')).toBe(true);
  });

  it('does not match inside a longer word', () => {
    expect(containsPhrase('already refunded', 'refund')).toBe(false);
    expect(containsPhrase('prefund', 'refund')).toBe(false);
    expect(containsPhrase('refund_id', 'refund')).toBe(false);
  });

  it('matches a multi-word phrase across any whitespace and escapes regex characters', () => {
    expect(containsPhrase('please cancel\n  my   order', 'cancel my order')).toBe(true);
    expect(containsPhrase('cost is 5.00 net', '5.00 net')).toBe(true);
    expect(containsPhrase('cost is 5x00 net', '5.00 net')).toBe(false);
  });

  it('never matches an empty phrase', () => {
    expect(containsPhrase('anything', '   ')).toBe(false);
  });
});

describe('emailDomain', () => {
  it('takes the part after the last @, lower-cased', () => {
    expect(emailDomain('Pat@Example.COM')).toBe('example.com');
    expect(emailDomain('no-at-sign')).toBe('');
  });
});

describe('ruleMatches', () => {
  it('matches "any" when one phrase is present', () => {
    expect(ruleMatches({ messageContainsAny: ['invoice', 'refund'] }, subject())).toBe(true);
    expect(ruleMatches({ messageContainsAny: ['invoice', 'chargeback'] }, subject())).toBe(false);
  });

  it('requires every phrase for "all"', () => {
    expect(ruleMatches({ messageContainsAll: ['want', 'refund'] }, subject())).toBe(true);
    expect(ruleMatches({ messageContainsAll: ['want', 'invoice'] }, subject())).toBe(false);
  });

  it('ANDs across kinds', () => {
    const conditions = { messageContainsAny: ['refund'], emailDomains: ['example.com'] };
    expect(ruleMatches(conditions, subject())).toBe(true);
    expect(ruleMatches(conditions, subject({ customerEmail: 'pat@other.org' }))).toBe(false);
    expect(ruleMatches(conditions, subject({ messageBody: 'hello' }))).toBe(false);
  });

  it('matches the email domain exactly, not as a suffix, and ignores a leading @', () => {
    expect(ruleMatches({ emailDomains: ['example.com'] }, subject({ customerEmail: 'a@mail.example.com' }))).toBe(false);
    expect(ruleMatches({ emailDomains: ['example.com'] }, subject({ customerEmail: 'a@notexample.com' }))).toBe(false);
    expect(ruleMatches({ emailDomains: ['@Example.com'] }, subject())).toBe(true);
  });

  it('matches customer tags when the customer has any of them', () => {
    expect(ruleMatches({ customerTagIds: [TAG] }, subject({ customerTagIds: [TAG] }))).toBe(true);
    expect(ruleMatches({ customerTagIds: [TAG] }, subject({ customerTagIds: [] }))).toBe(false);
  });

  it('never matches a rule without any condition', () => {
    expect(ruleMatches({}, subject())).toBe(false);
    expect(ruleMatches({ messageContainsAny: [], emailDomains: [] }, subject())).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('the first matching rule by position wins, whatever the array order', () => {
    const late = rule({ position: 5, name: 'late', conditions: { messageContainsAny: ['refund'] }, actions: { groupId: G2 } });
    const early = rule({ position: 1, name: 'early', conditions: { messageContainsAny: ['refund'] }, actions: { groupId: G1 } });
    const result = evaluateRules([late, early], subject(), active);
    expect(result.matched).toMatchObject({ ruleId: early.id, groupId: G1 });
  });

  it('ignores disabled rules', () => {
    const off = rule({ position: 0, enabled: false, conditions: { messageContainsAny: ['refund'] } });
    const on = rule({ position: 1, actions: { groupId: G2 }, conditions: { messageContainsAny: ['refund'] } });
    expect(evaluateRules([off, on], subject(), active).matched?.ruleId).toBe(on.id);
  });

  it('returns the priority and de-duplicated tags of the match', () => {
    const r = rule({ conditions: { messageContainsAny: ['refund'] }, actions: { groupId: G1, priority: 'high', tagIds: [TAG, TAG] } });
    expect(evaluateRules([r], subject(), active).matched).toEqual({
      ruleId: r.id,
      ruleName: r.name,
      groupId: G1,
      priority: 'high',
      tagIds: [TAG],
    });
  });

  it('is unmatched when nothing matches or the list is empty', () => {
    expect(evaluateRules([], subject(), active)).toEqual({ matched: null, skipped: [] });
    const r = rule({ conditions: { messageContainsAny: ['invoice'] } });
    expect(evaluateRules([r], subject(), active)).toEqual({ matched: null, skipped: [] });
  });

  it('skips a matching rule whose group is inactive or missing and uses the next rule', () => {
    const inactive = rule({ position: 0, conditions: { messageContainsAny: ['refund'] }, actions: { groupId: G1 } });
    const missing = rule({ position: 1, conditions: { messageContainsAny: ['refund'] }, actions: { groupId: 'gone' } });
    const fallback = rule({ position: 2, conditions: { messageContainsAny: ['refund'] }, actions: { groupId: G2 } });
    const groups: GroupStatusLookup = new Map([
      [G1, 'inactive'],
      [G2, 'active'],
    ]);
    const result = evaluateRules([inactive, missing, fallback], subject(), groups);
    expect(result.matched?.ruleId).toBe(fallback.id);
    expect(result.skipped.map((s) => [s.ruleId, s.reason])).toEqual([
      [inactive.id, 'group_inactive'],
      [missing.id, 'group_missing'],
    ]);
  });

  it('is unmatched, with the skipped rules listed, when every matching rule is skipped', () => {
    const r = rule({ conditions: { messageContainsAny: ['refund'] } });
    const result = evaluateRules([r], subject(), new Map([[G1, 'inactive']]));
    expect(result.matched).toBeNull();
    expect(result.skipped).toHaveLength(1);
  });

  it('does not report a non-matching rule with an inactive group as skipped', () => {
    const r = rule({ conditions: { messageContainsAny: ['invoice'] } });
    expect(evaluateRules([r], subject(), new Map([[G1, 'inactive']])).skipped).toEqual([]);
  });
});

describe('RuleBasedRouter', () => {
  const tx = {} as TenantTransaction;
  const ticket = {} as TicketRow;
  const customer = { id: 'c1', email: 'pat@example.com' } as never;

  function routerWith(matched: Awaited<ReturnType<RoutingEvaluator['evaluate']>>['matched']) {
    const evaluator = {
      subjectFor: vi.fn().mockResolvedValue(subject()),
      evaluate: vi.fn().mockResolvedValue({ matched, skipped: [] }),
    };
    return { router: new RuleBasedRouter(evaluator as unknown as RoutingEvaluator), evaluator };
  }

  it('maps a match to group, priority, tags and the rule name as reason', async () => {
    const { router, evaluator } = routerWith({ ruleId: 'r', ruleName: 'Refunds', groupId: G1, priority: 'urgent', tagIds: [TAG] });
    await expect(router.route(tx, ticket, { body: 'I want a refund' }, customer)).resolves.toEqual({
      groupId: G1,
      priority: 'urgent',
      tagIds: [TAG],
      reason: 'Refunds',
    });
    expect(evaluator.subjectFor).toHaveBeenCalledWith(tx, customer, 'I want a refund');
  });

  it('omits priority and tags that the rule does not set', async () => {
    const { router } = routerWith({ ruleId: 'r', ruleName: 'Plain', groupId: G1, tagIds: [] });
    await expect(router.route(tx, ticket, { body: 'x' }, customer)).resolves.toEqual({ groupId: G1, reason: 'Plain' });
  });

  it('returns null when no rule matched', async () => {
    const { router } = routerWith(null);
    await expect(router.route(tx, ticket, { body: 'x' }, customer)).resolves.toBeNull();
  });
});
