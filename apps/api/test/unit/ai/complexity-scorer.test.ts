import { describe, expect, it } from 'vitest';

import { factorQuestions, levelFor, scoreComplexity, type ComplexityConfig, type ComplexityFacts } from '../../../src/ai/complexity/complexity-scorer.js';

import type { DecisionAnswer } from '../../../src/ai/providers/ports.js';

/** Research R12: each factor's value in [0, 1], Σ w·v / Σ w, then the level by the thresholds. */

const NO_FACTS: ComplexityFacts = { customerTagIds: new Set(), reopenCount: 0, slaBreached: false };
const THRESHOLDS = { standard: 0.45, advanced: 0.8 };

const config = (factors: ComplexityConfig['factors']): ComplexityConfig => ({ thresholds: THRESHOLDS, factors });

describe('scoreComplexity', () => {
  it('weights a score factor by its level probabilities and a choice by its option values', () => {
    const answers: Record<string, DecisionAnswer> = {
      cx_mood: { type: 'score', score: 1, confidence: 0.8, probabilities: { '0': 0.2, '1': 0.4, '2': 0.4 } },
      cx_topic: { type: 'choice', choice: 'billing', confidence: 0.7, probabilities: { billing: 0.7, other: 0.3 } },
    };
    const result = scoreComplexity(
      config([
        { key: 'mood', label: 'Mood', kind: 'score', weight: 2, instructions: 'Mood?', levels: ['calm', 'annoyed', 'angry'] },
        { key: 'topic', label: 'Topic', kind: 'choice', weight: 1, instructions: 'Topic?', options: [{ key: 'billing', description: 'Billing', value: 1 }, { key: 'other', description: 'Other', value: 0 }] },
      ]),
      answers,
      NO_FACTS,
    );
    // mood = 0.4·0.5 + 0.4·1 = 0.6; topic = 0.7; (2·0.6 + 1·0.7) / 3 = 0.633
    expect(result).toEqual({ score: 0.633, level: 'standard' });
  });

  it('reads tags, reopens and SLA from the facts, and skips unanswered or weightless factors', () => {
    const result = scoreComplexity(
      config([
        { key: 'vip', label: 'VIP', kind: 'customer_tag', weight: 1, tagId: 'tag-1' },
        { key: 'reopens', label: 'Reopens', kind: 'reopen_count', weight: 1 },
        { key: 'late', label: 'Late', kind: 'sla_breached', weight: 1 },
        { key: 'missing', label: 'Missing', kind: 'noul', weight: 5, instructions: 'x', criteria: { true: 'y', false: 'n' } },
        { key: 'ignored', label: 'Ignored', kind: 'sla_breached', weight: 0 },
      ]),
      {},
      { customerTagIds: new Set(['tag-1']), reopenCount: 6, slaBreached: true },
    );
    expect(result).toEqual({ score: 1, level: 'advanced' });
  });

  it('is Fast with no score when nothing carries weight', () => {
    expect(scoreComplexity(config([]), {}, NO_FACTS)).toEqual({ score: null, level: 'fast' });
  });
});

describe('levelFor and factorQuestions', () => {
  it('uses ≥ for both thresholds', () => {
    expect([levelFor(0.44, THRESHOLDS), levelFor(0.45, THRESHOLDS), levelFor(0.8, THRESHOLDS)]).toEqual(['fast', 'standard', 'advanced']);
  });

  it('asks only the weighted model factors, under the cx_ prefix', () => {
    const questions = factorQuestions([
      { key: 'urgent', label: 'Urgent', kind: 'noul', weight: 1, instructions: 'Urgent?', criteria: { true: 'yes', false: 'no' } },
      { key: 'quiet', label: 'Quiet', kind: 'noul', weight: 0, instructions: 'Quiet?', criteria: { true: 'yes', false: 'no' } },
      { key: 'reopens', label: 'Reopens', kind: 'reopen_count', weight: 1 },
    ]);
    expect(Object.keys(questions)).toEqual(['cx_urgent']);
  });
});
