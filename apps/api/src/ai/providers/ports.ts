/**
 * Provider-neutral ports for AI Assist (specs/002-ai-assist research R1). Nothing outside
 * `ai/providers/` may import a provider's own request or response types: adapters (OpenRouter now;
 * direct Gemini, OpenAI and Anthropic later) translate to and from these shapes.
 *
 * Every call takes the tenant's credentials explicitly: each tenant brings and pays for its own key,
 * so there is no process-wide key.
 */

export interface ProviderCredentials {
  apiKey: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** USD as reported by the provider; null when it did not say (the caller estimates from the catalog). */
  costUsd: number | null;
}

export type ProviderErrorKind = 'auth' | 'credit' | 'rate_limit' | 'timeout' | 'unavailable' | 'bad_request';

/** `auth` and `credit` pause the tenant (research R10); the rest are retried, then handed off. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get pausesTenant(): boolean {
    return this.kind === 'auth' || this.kind === 'credit';
  }
}

// --- Chat --------------------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text exactly as the model produced it; callers validate it with zod. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Ask for a final answer matching this JSON Schema (strict where the provider supports it). */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ChatModel {
  complete(credentials: ProviderCredentials, request: ChatRequest): Promise<ChatResult>;
}

// --- Decisions (Jev) ---------------------------------------------------------------------------

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  /** `score` is the probability-weighted position, 0 … criteria.length - 1. */
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export interface DecisionRequest {
  model: string;
  /** The text or JSON the questions are about. */
  state: string | Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  timeoutMs?: number;
}

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: Usage;
}

export interface DecisionModel {
  decide(credentials: ProviderCredentials, request: DecisionRequest): Promise<DecisionResult>;
}

// --- Embeddings --------------------------------------------------------------------------------

export interface EmbeddingRequest {
  model: string;
  inputs: string[];
  timeoutMs?: number;
}

export interface EmbeddingResult {
  model: string;
  /** Same order as `inputs`. */
  vectors: number[][];
  usage: Usage;
}

export interface EmbeddingModel {
  embed(credentials: ProviderCredentials, request: EmbeddingRequest): Promise<EmbeddingResult>;
}

// --- Key check ---------------------------------------------------------------------------------

export interface KeyInfo {
  /** USD left on the key's own limit, when the key has one. */
  limitRemainingUsd: number | null;
}

/** One provider, all capabilities. Bound to `AI_PROVIDER` (ai.module.ts). */
export interface AiProvider extends ChatModel, DecisionModel, EmbeddingModel {
  readonly name: string;
  /** Throws `ProviderError('auth' | 'credit' | …)`. */
  checkKey(credentials: ProviderCredentials): Promise<KeyInfo>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
