import type { Candidate, Factors, Level } from './complexity';

/**
 * Stages and scenarios of the home page flow (specs/003-product-docs-site/contracts/flow-scenarios.md).
 * Messages, groups and rules are made up. `expected` must match complexity.ts (test/flow.test.ts).
 */

export type StageId = 'intake' | 'rules' | 'decision' | 'groups' | 'triage' | 'factors' | 'score' | 'levels';

export interface Stage {
  id: StageId;
  caption: string;
  href: string;
  /** AI stages get the neon treatment (FR-016a). */
  ai: boolean;
}

export const STAGES: readonly Stage[] = [
  { id: 'intake', caption: 'New ticket', href: '/guides/customer-chat/', ai: false },
  { id: 'rules', caption: 'Rules first', href: '/admin/routing-rules/', ai: false },
  { id: 'decision', caption: 'Decision model', href: '/concepts/how-ai-routing-works/', ai: true },
  { id: 'groups', caption: 'Right team', href: '/admin/roles-and-groups/', ai: false },
  { id: 'triage', caption: 'Needs Triage', href: '/guides/triage/', ai: false },
  { id: 'factors', caption: 'Complexity factors', href: '/concepts/how-complexity-picks-a-model/', ai: true },
  { id: 'score', caption: 'Weighted score', href: '/concepts/how-complexity-picks-a-model/#the-score', ai: true },
  { id: 'levels', caption: 'Model level', href: '/guides/ai-assist/#complexity-which-model-answers', ai: true },
];

export const GROUPS = ['Orders & Shipping', 'Accounts', 'Technical Support', 'Billing'] as const;
export type Group = (typeof GROUPS)[number];

export interface Scenario {
  id: string;
  message: string;
  /** A routing rule matched: the decision model is skipped. */
  ruleMatch: { rule: string; group: Group } | null;
  /** The decision model's candidates, when no rule matched. */
  routing: { candidates: readonly Candidate[] } | null;
  /** Complexity factor values; null when the ticket stays in Needs Triage. */
  factors: Factors | null;
  expected: { group: Group | 'Needs Triage'; score?: number; level?: Level };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'order-status',
    message: 'Where is my order 1042? It said 3 days.',
    ruleMatch: null,
    routing: {
      candidates: [
        { group: 'Orders & Shipping', confidence: 0.93 },
        { group: 'Billing', confidence: 0.05 },
      ],
    },
    factors: { frustration: 0.1, severalIssues: 0, technical: 0, vip: 0 },
    expected: { group: 'Orders & Shipping', score: 0.04, level: 'Fast' },
  },
  {
    id: 'password-reset',
    message: 'Reset my password please',
    ruleMatch: { rule: 'Password reset', group: 'Accounts' },
    routing: null,
    factors: { frustration: 0.25, severalIssues: 0, technical: 0, vip: 0 },
    expected: { group: 'Accounts', score: 0.1, level: 'Fast' },
  },
  {
    id: 'export-crash',
    message: "Export to CSV crashes every time since the update, I've tried twice.",
    ruleMatch: null,
    routing: {
      candidates: [
        { group: 'Technical Support', confidence: 0.88 },
        { group: 'Orders & Shipping', confidence: 0.07 },
      ],
    },
    factors: { frustration: 0.75, severalIssues: 0, technical: 1, vip: 0 },
    expected: { group: 'Technical Support', score: 0.5, level: 'Standard' },
  },
  {
    id: 'double-charge',
    message: 'Charged twice AGAIN, third time asking. Fix it and refund me.',
    ruleMatch: null,
    routing: {
      candidates: [
        { group: 'Billing', confidence: 0.81 },
        { group: 'Orders & Shipping', confidence: 0.12 },
      ],
    },
    factors: { frustration: 1, severalIssues: 1, technical: 0.2, vip: 1 },
    expected: { group: 'Billing', score: 0.84, level: 'Advanced' },
  },
  {
    id: 'vague',
    message: 'hi, quick question',
    ruleMatch: null,
    routing: {
      candidates: [
        { group: 'Billing', confidence: 0.41 },
        { group: 'Accounts', confidence: 0.33 },
      ],
    },
    factors: null,
    expected: { group: 'Needs Triage' },
  },
];

/** The scenario the static (no-JS, reduce-motion) diagram shows: Technical Support, 0.50, Standard. */
export const STATIC_SCENARIO = SCENARIOS[2]!;
