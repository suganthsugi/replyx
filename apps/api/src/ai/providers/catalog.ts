import type { Usage } from './ports.js';
import type { AiLevelModels, AiModelLevel } from '../../platform-kernel/db/tables/ai.js';

/**
 * The models a tenant may choose per level, their defaults, and the fixed decision and embedding
 * models (specs/002-ai-assist research R5). Tenant settings store only level → model id, so adding
 * a provider later only adds entries here.
 *
 * Prices (USD per million tokens) are OpenRouter's list prices on 2026-10-08. They are only used to
 * estimate a cost when the provider's response does not report one (OpenRouter does with
 * `usage.include`), so `ai_runs.cost_estimated` marks such rows.
 */

export interface ModelOption {
  id: string;
  label: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** False when no OpenRouter endpoint of the model accepts `temperature`: sending it is a 400. */
  acceptsTemperature?: boolean;
}

export const MODEL_LEVELS: readonly AiModelLevel[] = ['fast', 'standard', 'advanced'];

export const LEVEL_MODELS: Readonly<Record<AiModelLevel, readonly ModelOption[]>> = {
  fast: [
    { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, acceptsTemperature: false },
    { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
    { id: 'qwen/qwen3.7-flash', label: 'Qwen 3.7 Flash', inputPerMillionUsd: 0.03, outputPerMillionUsd: 0.13 },
  ],
  standard: [
    { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
    { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', inputPerMillionUsd: 0.25, outputPerMillionUsd: 2, acceptsTemperature: false },
  ],
  advanced: [
    { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', inputPerMillionUsd: 2, outputPerMillionUsd: 10, acceptsTemperature: false },
    { id: '~google/gemini-pro-latest', label: 'Gemini Pro (latest)', inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
  ],
};

export const DEFAULT_LEVEL_MODELS: Readonly<Record<AiModelLevel, string>> = {
  fast: 'anthropic/claude-haiku-5.5',
  standard: 'google/gemini-3.1-flash-lite',
  advanced: 'anthropic/claude-sonnet-5.5',
};

/** Pinned, never the `~typesafe/jev-latest` alias, so behaviour changes only when ReplyX upgrades it. */
export const DECISION_MODEL: ModelOption = {
  id: 'typesafe/jev-1.13',
  label: 'Jev 1.13',
  inputPerMillionUsd: 0.042,
  outputPerMillionUsd: 0,
};

/** ReplyX-wide; every policy chunk records it, so a change needs a re-index (not in this release). */
export const EMBEDDING_MODEL: ModelOption & { dimensions: number } = {
  id: 'openai/text-embedding-3-small',
  label: 'text-embedding-3-small',
  inputPerMillionUsd: 0.02,
  outputPerMillionUsd: 0,
  dimensions: 1536,
};

export function isSelectableModel(level: AiModelLevel, modelId: string): boolean {
  return LEVEL_MODELS[level].some((m) => m.id === modelId);
}

/** The tenant's choice for a level, or the default when unset or no longer offered. */
export function modelForLevel(models: AiLevelModels, level: AiModelLevel): string {
  const chosen = models[level];
  return chosen !== undefined && isSelectableModel(level, chosen) ? chosen : DEFAULT_LEVEL_MODELS[level];
}

const ALL_PRICED: readonly ModelOption[] = [...MODEL_LEVELS.flatMap((l) => LEVEL_MODELS[l]), DECISION_MODEL, EMBEDDING_MODEL];

/** Whether a chat request to the model may carry `temperature` (OpenRouter's `supported_parameters`). */
export function acceptsTemperature(modelId: string): boolean {
  return ALL_PRICED.find((m) => m.id === modelId)?.acceptsTemperature !== false;
}

/** Cost to record for a call: the provider's figure when given, else an estimate from list prices. */
export function costOf(modelId: string, usage: Usage): { costUsd: number | null; estimated: boolean } {
  if (usage.costUsd !== null) return { costUsd: usage.costUsd, estimated: false };
  // Providers may answer with a dated id (`typesafe/jev-1.13-20260917`): match by prefix.
  const priced = ALL_PRICED.find((m) => modelId === m.id || modelId.startsWith(`${m.id}-`));
  if (priced === undefined) return { costUsd: null, estimated: true };
  const cost = (usage.inputTokens * priced.inputPerMillionUsd + usage.outputTokens * priced.outputPerMillionUsd) / 1_000_000;
  return { costUsd: Math.round(cost * 1_000_000) / 1_000_000, estimated: true };
}
