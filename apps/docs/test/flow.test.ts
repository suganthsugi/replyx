import { describe, expect, it } from 'vitest';

import { level, ROUTING_CONFIDENCE, route, score, THRESHOLDS } from '@/components/flow/complexity';
import { SCENARIOS, STAGES, STATIC_SCENARIO } from '@/components/flow/scenarios';

// The home flow's made-up data must tell the truth about the real scoring (contracts/flow-scenarios.md
// "Invariants"), so the animation can't drift from what spec 002 does.

const round2 = (n: number) => Math.round(n * 100) / 100;

describe('complexity (spec 002 R12)', () => {
  it('scores a weighted average with frustration counting double', () => {
    expect(score({ frustration: 0, severalIssues: 0, technical: 0, vip: 0 })).toBe(0);
    expect(score({ frustration: 1, severalIssues: 1, technical: 1, vip: 1 })).toBe(1);
    expect(score({ frustration: 1, severalIssues: 0, technical: 0, vip: 0 })).toBeCloseTo(0.4);
  });

  it('splits levels at 0.45 and 0.80, inclusive of the upper level', () => {
    expect(level(THRESHOLDS.standard - 0.001)).toBe('Fast');
    expect(level(THRESHOLDS.standard)).toBe('Standard');
    expect(level(THRESHOLDS.advanced - 0.001)).toBe('Standard');
    expect(level(THRESHOLDS.advanced)).toBe('Advanced');
  });

  it('routes to the most confident group only at or above 0.70', () => {
    expect(route([{ group: 'A', confidence: 0.2 }, { group: 'B', confidence: ROUTING_CONFIDENCE }])).toBe('B');
    expect(route([{ group: 'A', confidence: ROUTING_CONFIDENCE - 0.01 }])).toBe('Needs Triage');
    expect(route([])).toBe('Needs Triage');
  });
});

describe.each(SCENARIOS.map((s) => [s.id, s]))('scenario %s', (_, s) => {
  it('1. has the score and level complexity.ts computes', () => {
    if (!s.factors) {
      expect(s.expected.score).toBeUndefined();
      expect(s.expected.level).toBeUndefined();
      return;
    }
    for (const v of Object.values(s.factors)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const computed = score(s.factors);
    expect(round2(computed)).toBe(s.expected.score);
    expect(level(computed)).toBe(s.expected.level);
  });

  it('2. routes the way the rules and the 0.70 threshold say', () => {
    if (s.ruleMatch) {
      expect(s.routing).toBeNull();
      expect(s.expected.group).toBe(s.ruleMatch.group);
    } else {
      expect(s.routing).not.toBeNull();
      expect(route(s.routing!.candidates)).toBe(s.expected.group);
    }
    expect(s.factors === null).toBe(s.expected.group === 'Needs Triage');
  });

  it('5. reads like made-up data, with no personal details', () => {
    expect(s.message.length).toBeLessThanOrEqual(90);
    expect(s.message).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/); // email
    expect(s.message).not.toMatch(/\+?\d[\d\s().-]{7,}\d/); // phone number
    expect(s.message).not.toMatch(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/); // First Last
  });
});

describe('the loop as a whole', () => {
  it('3. shows every outcome, and the cheaper levels more often than Advanced', () => {
    const levels = SCENARIOS.map((s) => s.expected.level).filter(Boolean);
    const count = (l: string) => levels.filter((x) => x === l).length;
    expect(count('Fast')).toBeGreaterThanOrEqual(1);
    expect(count('Standard')).toBeGreaterThanOrEqual(1);
    expect(count('Advanced')).toBeGreaterThanOrEqual(1);
    expect(SCENARIOS.some((s) => s.expected.group === 'Needs Triage')).toBe(true);
    expect(SCENARIOS.some((s) => s.ruleMatch !== null)).toBe(true);
    expect(count('Fast') + count('Standard')).toBeGreaterThan(count('Advanced'));
  });

  it('has unique scenario ids and a static scenario with a full outcome', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(STATIC_SCENARIO.expected.level).toBeDefined();
  });
});

describe('stages', () => {
  it('has the eight contract stages in order, with neon only on AI stages', () => {
    expect(STAGES.map((s) => s.id)).toEqual(['intake', 'rules', 'decision', 'groups', 'triage', 'factors', 'score', 'levels']);
    expect(STAGES.filter((s) => s.ai).map((s) => s.id)).toEqual(['decision', 'factors', 'score', 'levels']);
  });

  it.each(STAGES.map((s) => [s.id, s]))('4. %s has a short caption and an internal docs link', (_, stage) => {
    expect(stage.caption.length).toBeGreaterThan(0);
    expect(stage.caption.length).toBeLessThanOrEqual(40);
    // Resolution is checked against the export by scripts/check-links.mjs.
    expect(stage.href).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+\/(#[a-z0-9-]+)?$/);
  });
});
