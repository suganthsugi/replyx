import { z } from 'zod';

import { acceptsTemperature } from '../catalog.js';
import {
  ProviderError,
  type AiProvider,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type DecisionRequest,
  type DecisionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type KeyInfo,
  type ProviderCredentials,
  type ProviderErrorKind,
  type Usage,
} from '../ports.js';

/**
 * OpenRouter adapter (specs/002-ai-assist research R1): OpenAI-compatible chat completions and
 * embeddings, the alpha Decisions API for Jev, and `/api/v1/key` for "Test connection".
 *
 * Every generation asks providers not to keep or train on the data (`data_collection: deny`) and
 * for usage accounting, so responses carry the real cost. Responses are validated with zod; an
 * unexpected shape is an `unavailable` error (the call may be retried).
 */

const DEFAULT_TIMEOUTS = { chat: 20_000, decisions: 5_000, embeddings: 15_000, key: 5_000 } as const;

const PRIVACY = { data_collection: 'deny' } as const;

const UsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cost: z.number().nullish(),
  })
  .loose();

function usageOf(raw: z.infer<typeof UsageSchema> | undefined): Usage {
  return {
    inputTokens: raw?.prompt_tokens ?? raw?.input_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? raw?.output_tokens ?? 0,
    costUsd: raw?.cost ?? null,
  };
}

const ChatResponse = z
  .object({
    model: z.string(),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullish(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        id: z.string(),
                        function: z.object({ name: z.string(), arguments: z.string() }).loose(),
                      })
                      .loose(),
                  )
                  .nullish(),
              })
              .loose(),
          })
          .loose(),
      )
      .min(1),
    usage: UsageSchema.optional(),
  })
  .loose();

const Probabilities = z.record(z.string(), z.number());

const DecisionsResponse = z
  .object({
    model: z.string(),
    answers: z.record(
      z.string(),
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('noul'), noul: z.number() }).loose(),
        z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number(), probabilities: Probabilities }).loose(),
        z.object({ type: z.literal('score'), score: z.number(), confidence: z.number(), probabilities: Probabilities }).loose(),
      ]),
    ),
    usage: UsageSchema.optional(),
  })
  .loose();

const EmbeddingsResponse = z
  .object({
    model: z.string().optional(),
    data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) }).loose()),
    usage: UsageSchema.optional(),
  })
  .loose();

const KeyResponse = z
  .object({ data: z.object({ limit_remaining: z.number().nullish() }).loose() })
  .loose();

/** OpenRouter's HTTP status → our error kinds (https://openrouter.ai/docs/api-reference/errors). */
export function errorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 524) return 'timeout';
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'bad_request';
  return 'unavailable';
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls === undefined || message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

export class OpenRouterProvider implements AiProvider {
  readonly name = 'openrouter';

  constructor(
    private readonly baseUrl: string = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(credentials: ProviderCredentials, request: ChatRequest): Promise<ChatResult> {
    const body = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) }),
      ...(request.responseSchema === undefined
        ? {}
        : { response_format: { type: 'json_schema', json_schema: { ...request.responseSchema, strict: true } } }),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      // Some models reject the parameter outright (HTTP 400) instead of ignoring it.
      ...(request.temperature === undefined || !acceptsTemperature(request.model) ? {} : { temperature: request.temperature }),
      provider: PRIVACY,
      usage: { include: true },
    };
    const raw = await this.post(credentials, '/api/v1/chat/completions', body, request.timeoutMs ?? DEFAULT_TIMEOUTS.chat);
    const parsed = this.parse(ChatResponse, raw);
    const message = parsed.choices[0]!.message;
    return {
      model: parsed.model,
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      usage: usageOf(parsed.usage),
    };
  }

  async decide(credentials: ProviderCredentials, request: DecisionRequest): Promise<DecisionResult> {
    const body = { model: request.model, state: request.state, questions: request.questions, provider: PRIVACY };
    const raw = await this.post(credentials, '/api/alpha/decisions', body, request.timeoutMs ?? DEFAULT_TIMEOUTS.decisions);
    const parsed = this.parse(DecisionsResponse, raw);
    return { model: parsed.model, answers: parsed.answers, usage: usageOf(parsed.usage) };
  }

  async embed(credentials: ProviderCredentials, request: EmbeddingRequest): Promise<EmbeddingResult> {
    const body = { model: request.model, input: request.inputs, provider: PRIVACY, usage: { include: true } };
    const raw = await this.post(credentials, '/api/v1/embeddings', body, request.timeoutMs ?? DEFAULT_TIMEOUTS.embeddings);
    const parsed = this.parse(EmbeddingsResponse, raw);
    if (parsed.data.length !== request.inputs.length) throw new ProviderError('unavailable', 'Embedding count does not match the inputs');
    const vectors = [...parsed.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    return { model: parsed.model ?? request.model, vectors, usage: usageOf(parsed.usage) };
  }

  async checkKey(credentials: ProviderCredentials): Promise<KeyInfo> {
    const raw = await this.send(credentials, 'GET', '/api/v1/key', undefined, DEFAULT_TIMEOUTS.key);
    const parsed = this.parse(KeyResponse, raw);
    const remaining = parsed.data.limit_remaining ?? null;
    if (remaining !== null && remaining <= 0) throw new ProviderError('credit', 'The key has no credit left');
    return { limitRemainingUsd: remaining };
  }

  private post(credentials: ProviderCredentials, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    return this.send(credentials, 'POST', path, body, timeoutMs);
  }

  private async send(
    credentials: ProviderCredentials,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${credentials.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'ReplyX',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderError(timedOut ? 'timeout' : 'unavailable', timedOut ? 'Provider timed out' : 'Provider unreachable');
    }
    if (!response.ok) {
      // Never echo the response body: some providers repeat the request, which holds message text.
      throw new ProviderError(errorKindForStatus(response.status), `Provider answered ${response.status}`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderError('unavailable', 'Provider sent a response that is not JSON');
    }
  }

  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success) throw new ProviderError('unavailable', 'Provider sent an unexpected response shape');
    return result.data;
  }
}
