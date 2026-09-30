import type { RoutingDryRun, RoutingRule } from '../../src/api/generated/model';

export function makeRoutingRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'rule-1',
    name: 'Refunds to Billing',
    position: 0,
    enabled: true,
    conditions: { messageContainsAny: ['refund', 'invoice'] },
    actions: { groupId: 'group-billing', priority: 'high', tagIds: ['tag-vip'] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export const groupsFixture = [
  { id: 'group-billing', name: 'Billing', active: true },
  { id: 'group-support', name: 'Support', active: true },
  { id: 'group-old', name: 'Legacy', active: false },
];

export const tagsFixture = [
  { id: 'tag-vip', name: 'vip' },
  { id: 'tag-refund', name: 'refund' },
];

export function makeDryRun(overrides: Partial<RoutingDryRun> = {}): RoutingDryRun {
  return { matchedRuleId: null, matchedRuleName: null, actions: null, skipped: [], ...overrides };
}
