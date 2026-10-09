import { z } from 'zod';

/**
 * Body of `PUT /ai/complexity` (contracts/ai.yaml `ComplexityConfig`, data-model.md
 * `ai_complexity_factors`, research R12). Shape rules per factor kind live here; rules across
 * fields (unique keys, a positive weight, threshold order, the tag existing) are checked by
 * `ComplexityService`, so each error lands on its own field.
 */

export const FACTOR_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_FACTORS = 12;

const Key = z.string().regex(FACTOR_KEY);
const Label = z.string().trim().min(1).max(80);
const Weight = z.number().min(0).max(10);
const Instructions = z.string().trim().min(1).max(500);
const Criterion = z.string().trim().min(1).max(200);

const base = { key: Key, label: Label, weight: Weight };

const NoulFactor = z.object({ ...base, kind: z.literal('noul'), instructions: Instructions, criteria: z.object({ true: Criterion, false: Criterion }).strict() }).strict();

const ChoiceFactor = z
  .object({
    ...base,
    kind: z.literal('choice'),
    instructions: Instructions,
    options: z
      .array(z.object({ key: Key, description: z.string().trim().min(1).max(200), value: z.number().min(0).max(1) }).strict())
      .min(2)
      .max(8),
  })
  .strict();

const ScoreFactor = z.object({ ...base, kind: z.literal('score'), instructions: Instructions, levels: z.array(z.string().trim().min(1).max(80)).min(2).max(7) }).strict();

const CustomerTagFactor = z.object({ ...base, kind: z.literal('customer_tag'), tagId: z.uuid() }).strict();

const ReopenCountFactor = z.object({ ...base, kind: z.literal('reopen_count') }).strict();

const SlaBreachedFactor = z.object({ ...base, kind: z.literal('sla_breached') }).strict();

export const ComplexityFactorSchema = z.discriminatedUnion('kind', [NoulFactor, ChoiceFactor, ScoreFactor, CustomerTagFactor, ReopenCountFactor, SlaBreachedFactor]);

export const ComplexityConfigSchema = z
  .object({
    thresholds: z.object({ standard: z.number().gt(0).lt(1), advanced: z.number().gt(0).lt(1) }).strict(),
    factors: z.array(ComplexityFactorSchema).max(MAX_FACTORS),
  })
  .strict();

export type ComplexityFactorInput = z.infer<typeof ComplexityFactorSchema>;
export type ComplexityConfigInput = z.infer<typeof ComplexityConfigSchema>;
