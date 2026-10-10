/**
 * The scoring the home page flow illustrates: a mirror of spec 002's complexity formula
 * (specs/002-ai-assist/research.md R12) with its default factors and thresholds, and the routing
 * confidence rule (default threshold 0.7). Only the docs use this module; the product computes
 * these in apps/api. If 002's defaults change, change them here and in the concept pages.
 */

export const WEIGHTS = { frustration: 2, severalIssues: 1, technical: 1, vip: 1 } as const;

export const THRESHOLDS = { standard: 0.45, advanced: 0.8 } as const;

export const ROUTING_CONFIDENCE = 0.7;

export type Factor = keyof typeof WEIGHTS;
/** Each factor's value, from 0 to 1 (a yes/no answer is P(yes), a tag is 0 or 1). */
export type Factors = Record<Factor, number>;
export type Level = 'Fast' | 'Standard' | 'Advanced';

/** Weighted average of the factor values: Σ w·v / Σ w, from 0 to 1. */
export function score(factors: Factors): number {
  let weighted = 0;
  let total = 0;
  for (const factor of Object.keys(WEIGHTS) as Factor[]) {
    weighted += WEIGHTS[factor] * factors[factor];
    total += WEIGHTS[factor];
  }
  return weighted / total;
}

export function level(value: number): Level {
  if (value < THRESHOLDS.standard) return 'Fast';
  if (value < THRESHOLDS.advanced) return 'Standard';
  return 'Advanced';
}

export interface Candidate {
  group: string;
  confidence: number;
}

/** The decision model's pick: the most confident group if it clears the threshold, else triage. */
export function route(candidates: readonly Candidate[]): string {
  const best = [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
  return best && best.confidence >= ROUTING_CONFIDENCE ? best.group : 'Needs Triage';
}
