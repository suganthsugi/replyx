import { createHash } from 'node:crypto';

import { EMBEDDING_MODEL } from '../catalog.js';
import {
  ProviderError,
  type AiProvider,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type DecisionAnswer,
  type DecisionRequest,
  type DecisionResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type KeyInfo,
  type ProviderCredentials,
  type Usage,
} from '../ports.js';

/**
 * Deterministic stand-in for a real provider (`AI_PROVIDER=fake`): tests, e2e and offline dev never
 * reach the network (specs/002-ai-assist research R15).
 *
 * Keys: `fake-invalid` → `auth`, `fake-no-credit` → `credit`, `fake-down` → `unavailable`; anything
 * else works. Markers in the customer's text steer answers:
 * - decisions: `[fake:<question>]` makes a yes/no question 0.95 (else 0.05); `[fake:<question>=<n>]`
 *   puts a score at level n; choices pick the option whose description shares the most words with
 *   the text (or `none` when nothing matches);
 * - chat: an order number (`R100200`) calls `lookup_order`, return/refund/policy words call
 *   `search_policies`, "order" without a number asks for it, `[fake:lowconf]` answers with
 *   confidence 0.2, `[fake:unresolved]` marks the turn unresolved.
 * Tests can replace the chat behaviour with `script` and read every call in `calls`.
 */

export type ChatScript = (request: ChatRequest) => Omit<ChatResult, 'usage' | 'model'> | undefined;

const FAKE_USAGE: Usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 };

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly calls: { kind: 'chat' | 'decide' | 'embed' | 'checkKey'; model?: string; request?: unknown }[] = [];
  /** Overrides the default chat behaviour while set; return undefined to fall back to it. */
  script: ChatScript | undefined;

  reset(): void {
    this.calls.length = 0;
    this.script = undefined;
  }

  checkKey(credentials: ProviderCredentials): Promise<KeyInfo> {
    this.calls.push({ kind: 'checkKey' });
    return this.respond(credentials, () => ({ limitRemainingUsd: 5 }));
  }

  complete(credentials: ProviderCredentials, request: ChatRequest): Promise<ChatResult> {
    this.calls.push({ kind: 'chat', model: request.model, request });
    return this.respond(credentials, () => ({ ...(this.script?.(request) ?? defaultChat(request)), model: request.model, usage: FAKE_USAGE }));
  }

  decide(credentials: ProviderCredentials, request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push({ kind: 'decide', model: request.model, request });
    return this.respond(credentials, () => decideFake(request));
  }

  embed(credentials: ProviderCredentials, request: EmbeddingRequest): Promise<EmbeddingResult> {
    this.calls.push({ kind: 'embed', model: request.model });
    return this.respond(credentials, () => ({
      model: request.model,
      vectors: request.inputs.map((input) => bagOfWords(input, EMBEDDING_MODEL.dimensions)),
      usage: { inputTokens: Math.ceil(request.inputs.join(' ').length / 4), outputTokens: 0, costUsd: 0.000001 },
    }));
  }

  /** Scripted failures for the special keys, else the answer; always asynchronous, like a real provider. */
  private respond<T>(credentials: ProviderCredentials, answer: () => T): Promise<T> {
    try {
      this.failFor(credentials);
      return Promise.resolve(answer());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failFor(credentials: ProviderCredentials): void {
    if (credentials.apiKey === 'fake-invalid') throw new ProviderError('auth', 'Provider answered 401', 401);
    if (credentials.apiKey === 'fake-no-credit') throw new ProviderError('credit', 'Provider answered 402', 402);
    if (credentials.apiKey === 'fake-down') throw new ProviderError('unavailable', 'Provider answered 503', 503);
  }
}

function decideFake(request: DecisionRequest): DecisionResult {
  const text = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      answers[key] = { type: 'noul', noul: text.includes(`[fake:${key}]`) ? 0.95 : 0.05 };
    } else if (question.type === 'score') {
      const level = Number(new RegExp(`\\[fake:${key}=(\\d+)\\]`).exec(text)?.[1] ?? 0);
      const top = Math.min(level, question.criteria.length - 1);
      const probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), i === top ? 0.9 : 0.1 / (question.criteria.length - 1)]));
      answers[key] = { type: 'score', score: top, confidence: 0.9, probabilities };
    } else {
      answers[key] = pickChoice(text, question.criteria);
    }
  }
  return { model: `${request.model}-fake`, answers, usage: { inputTokens: 200, outputTokens: 0, costUsd: 0.0000084 } };
}

/** Lower-cased words of 3+ characters, crudely stemmed so "charged" and "charges" match. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w));
}

function pickChoice(text: string, criteria: Record<string, string>): DecisionAnswer {
  const forced = /\[fake:choice=([a-z0-9_-]+)\]/i.exec(text)?.[1];
  const textWords = new Set(words(text));
  const scores = Object.entries(criteria).map(([option, description]) => {
    if (option === 'none') return [option, 0] as const;
    const overlap = words(description).filter((w) => textWords.has(w)).length;
    return [option, forced === option ? 100 : overlap] as const;
  });
  const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  const choice = best[1] > 0 ? best[0] : 'none' in criteria ? 'none' : best[0];
  const probabilities = Object.fromEntries(Object.keys(criteria).map((option) => [option, option === choice ? 0.9 : 0.1 / Math.max(1, Object.keys(criteria).length - 1)]));
  return { type: 'choice', choice, confidence: best[1] > 0 ? 0.85 : 0.4, probabilities };
}

/** Word-hash vectors, L2-normalised: texts that share words are close, which is all retrieval tests need. */
export function bagOfWords(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of words(text)) {
    const index = createHash('sha256').update(word).digest().readUInt32BE(0) % dimensions;
    vector[index]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((v) => v / norm);
}

/** The newest customer text: the last `<customer_message>` block if the prompt uses them, else the last user turn. */
function customerText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const blocks = [...message.content.matchAll(/<customer_message[^>]*>([\s\S]*?)<\/customer_message>/g)];
    return blocks.length > 0 ? blocks[blocks.length - 1]![1]!.trim() : message.content;
  }
  return '';
}

function final(request: ChatRequest, reply: string, extra: { confidence?: number; awaiting?: string | null; resolved?: boolean } = {}) {
  const text = customerText(request.messages);
  const answer = {
    reply,
    confidence: text.includes('[fake:lowconf]') ? 0.2 : (extra.confidence ?? 0.9),
    awaiting: extra.awaiting ?? null,
    resolved: text.includes('[fake:unresolved]') ? false : (extra.resolved ?? true),
  };
  return { content: request.responseSchema === undefined ? reply : JSON.stringify(answer), toolCalls: [] };
}

function defaultChat(request: ChatRequest): Omit<ChatResult, 'usage' | 'model'> {
  const last = request.messages[request.messages.length - 1];
  const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
  const text = customerText(request.messages);

  if (last?.role === 'tool') {
    return final(request, replyFromToolResult(last.content));
  }
  const orderNumber = /\b[A-Z]?\d{5,}\b/.exec(text)?.[0];
  if (orderNumber !== undefined && toolNames.has('lookup_order')) {
    return { content: null, toolCalls: [{ id: 'call_order', name: 'lookup_order', arguments: JSON.stringify({ orderNumber }) }] };
  }
  if (/\b(return|refund|exchange|policy|shipping)\b/i.test(text) && toolNames.has('search_policies')) {
    return { content: null, toolCalls: [{ id: 'call_policy', name: 'search_policies', arguments: JSON.stringify({ query: text.slice(0, 200) }) }] };
  }
  if (/\border\b/i.test(text)) {
    return final(request, 'I can check that for you. Could you share your order number?', { awaiting: 'order_number' });
  }
  if (request.responseSchema === undefined) {
    // Summaries and other plain-text calls.
    return { content: `Summary: ${text.slice(0, 200)}`, toolCalls: [] };
  }
  return final(request, 'Thanks for getting in touch. How can I help with your order today?');
}

function replyFromToolResult(content: string): string {
  let result: unknown;
  try {
    result = JSON.parse(content);
  } catch {
    return 'Here is what I found.';
  }
  const record = result as Record<string, unknown>;
  if (record.found === false) return "I couldn't find an order with that number for your account. Could you check the number?";
  if (typeof record.number === 'string') {
    const tracking = Array.isArray(record.shipments) && record.shipments.length > 0 ? (record.shipments[0] as Record<string, unknown>).tracking : null;
    return `Your order ${record.number} is ${typeof record.status === 'string' ? record.status : 'being processed'}${typeof tracking === 'string' ? `, tracking number ${tracking}` : ''}.`;
  }
  if (Array.isArray(record.passages) && record.passages.length > 0) {
    const passage = record.passages[0] as Record<string, unknown>;
    return `According to our policy: ${String(passage.content).slice(0, 300)}`;
  }
  return "I'm not sure about that one, so I'll pass it to our team.";
}
