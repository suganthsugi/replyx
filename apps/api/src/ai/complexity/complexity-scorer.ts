import type { ComplexityFactorInput } from './complexity.input.js';
import type { AiComplexityThresholds, AiModelLevel } from '../../platform-kernel/db/tables/ai.js';
import type { DecisionAnswer, DecisionQuestion } from '../providers/ports.js';

/**
 * The complexity score of a turn (specs/002-ai-assist research R12, FR-025/026): the tenant's
 * factors, each worth a value v ∈ [0, 1], weighted into Σ w·v / Σ w, which picks the model level.
 * Pure functions: the questions go into the turn's single decision call (`HandoffScreen`), the
 * facts the database knows (customer tags, reopens, SLA) are read in the turn's read phase.
 */

export type ComplexityFactor = ComplexityFactorInput;

export interface ComplexityConfig {
  thresholds: AiComplexityThresholds;
  factors: ComplexityFactor[];
}

/** What the database says about the ticket, for the factors the decision model does not answer. */
export interface ComplexityFacts {
  customerTagIds: ReadonlySet<string>;
  reopenCount: number;
  slaBreached: boolean;
}

export interface ComplexityResult {
  /** Null when no factor carried weight (or none could be answered): the level is then Fast. */
  score: number | null;
  level: AiModelLevel;
}

/** Factor questions are namespaced so a tenant key never collides with the hand-off questions. */
export const QUESTION_PREFIX = 'cx_';

export const DEFAULT_THRESHOLDS: AiComplexityThresholds = { standard: 0.45, advanced: 0.8 };

/** A reopen count at or above this is worth 1. */
const REOPENS_FOR_FULL_VALUE = 3;

/** The decision-model questions for the factors that need one (weight > 0 only). */
export function factorQuestions(factors: readonly ComplexityFactor[]): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const factor of factors) {
    if (factor.weight <= 0) continue;
    const key = `${QUESTION_PREFIX}${factor.key}`;
    if (factor.kind === 'noul') questions[key] = { type: 'noul', instructions: factor.instructions, criteria: factor.criteria };
    if (factor.kind === 'choice') {
      questions[key] = { type: 'choice', instructions: factor.instructions, criteria: Object.fromEntries(factor.options.map((option) => [option.key, option.description])) };
    }
    if (factor.kind === 'score') questions[key] = { type: 'score', instructions: factor.instructions, criteria: factor.levels };
  }
  return questions;
}

/** One factor's value in [0, 1], or undefined when its answer is missing or of the wrong type. */
export function factorValue(factor: ComplexityFactor, answers: Readonly<Record<string, DecisionAnswer>>, facts: ComplexityFacts): number | undefined {
  const answer = answers[`${QUESTION_PREFIX}${factor.key}`];
  switch (factor.kind) {
    case 'noul':
      return answer?.type === 'noul' ? clamp(answer.noul) : undefined;
    case 'score': {
      if (answer?.type !== 'score') return undefined;
      const top = factor.levels.length - 1;
      const weighted = factor.levels.reduce<number | undefined>((sum, level, index) => {
        const p = answer.probabilities[String(index)] ?? answer.probabilities[level];
        return p === undefined || sum === undefined ? undefined : sum + p * (index / top);
      }, 0);
      return clamp(weighted ?? answer.score / top);
    }
    case 'choice': {
      if (answer?.type !== 'choice') return undefined;
      const fromProbabilities = factor.options.reduce((sum, option) => sum + (answer.probabilities[option.key] ?? 0) * option.value, 0);
      const known = factor.options.some((option) => answer.probabilities[option.key] !== undefined);
      return clamp(known ? fromProbabilities : (factor.options.find((option) => option.key === answer.choice)?.value ?? 0));
    }
    case 'customer_tag':
      return facts.customerTagIds.has(factor.tagId) ? 1 : 0;
    case 'reopen_count':
      return Math.min(facts.reopenCount / REOPENS_FOR_FULL_VALUE, 1);
    case 'sla_breached':
      return facts.slaBreached ? 1 : 0;
  }
}

/** Σ w·v / Σ w over the factors with weight and a value, then the level by the thresholds. */
export function scoreComplexity(config: ComplexityConfig, answers: Readonly<Record<string, DecisionAnswer>>, facts: ComplexityFacts): ComplexityResult {
  let weighted = 0;
  let total = 0;
  for (const factor of config.factors) {
    if (factor.weight <= 0) continue;
    const value = factorValue(factor, answers, facts);
    if (value === undefined) continue;
    weighted += factor.weight * value;
    total += factor.weight;
  }
  if (total === 0) return { score: null, level: 'fast' };
  const score = Math.round((weighted / total) * 1000) / 1000;
  return { score, level: levelFor(score, config.thresholds) };
}

export function levelFor(score: number, thresholds: AiComplexityThresholds): AiModelLevel {
  if (score >= thresholds.advanced) return 'advanced';
  if (score >= thresholds.standard) return 'standard';
  return 'fast';
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
