import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { factorQuestions, scoreComplexity, type ComplexityResult } from '../complexity/complexity-scorer.js';
import { modelForLevel } from '../providers/catalog.js';
import { AI_PROVIDER, ProviderError, type AiProvider, type ChatMessage } from '../providers/ports.js';
import { AiRunsRecorder } from '../runs/ai-runs.recorder.js';

import { ANSWER_SCHEMA, renderConversation, SYSTEM_PROMPT, TOOLS } from './assistant-prompt.js';
import { AssistantTools, newToolTurn } from './assistant-tools.js';
import { AssistantTyping } from './assistant-typing.js';
import { HandoffScreen } from './handoff-screen.js';

import type { TurnBrain, TurnDecision, TurnInput } from './turn-brain.js';

/** The reply must be at least this sure of itself (research R7 step 4). */
export const MIN_CONFIDENCE = 0.6;
/** Two unresolved turns in a row hand off; the first one is already counted in `unresolvedTurns`. */
export const MAX_UNRESOLVED_TURNS = 2;
/** The model may call tools this many times in a row; then it must answer. */
export const MAX_TOOL_ROUNDS = 3;

const CHAT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 800;

const Answer = z.object({
  reply: z.string(),
  confidence: z.number().transform((value) => Math.min(1, Math.max(0, value))),
  awaiting: z.enum(['order_number', 'other']).nullable(),
  resolved: z.boolean(),
});

/**
 * The assistant's decision logic (specs/002-ai-assist research R7, R8), bound to `TURN_BRAIN`:
 *
 * 1. The decision model screens the last 6 messages for a wish for a person, a refund or exception
 *    request, or anger (`HandoffScreen`). Any of them hands off without a chat call. The same call
 *    answers the tenant's complexity factors (US4), whose score picks the model level (R12).
 * 2. The chat model at that level answers with the tools `search_policies`, `lookup_order` and
 *    `handoff`, at most 3 tool rounds, and returns `{ reply, confidence, awaiting, resolved }`.
 * 3. Low confidence, or a second unresolved turn in a row, hands off instead of answering.
 *
 * It opens no database transaction of its own (tools use their own short reads). Provider
 * `auth`/`credit` errors are rethrown for the job to pause the tenant; on the last attempt any other
 * failure becomes a hand-off with reason `ai_unavailable`, earlier ones are retried by BullMQ.
 */
@Injectable()
export class AssistantBrain implements TurnBrain {
  constructor(
    private readonly screen: HandoffScreen,
    private readonly tools: AssistantTools,
    private readonly typing: AssistantTyping,
    private readonly runs: AiRunsRecorder,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async think(input: TurnInput): Promise<TurnDecision> {
    try {
      return await this.decide(input);
    } catch (error) {
      if (error instanceof ProviderError && error.pausesTenant) throw error;
      if (input.attempt.last) return { kind: 'handoff', reason: 'ai_unavailable' };
      throw error;
    }
  }

  private async decide(input: TurnInput): Promise<TurnDecision> {
    const { config, facts } = input.complexity;
    const screened = await this.screen.run(input, factorQuestions(config.factors));
    const complexity = scoreComplexity(config, screened.answers, facts);
    const meta = { level: complexity.level, complexityScore: complexity.score };
    // No chat model ran, so no level was used: the turn and its runs carry none.
    if (screened.handoffReason !== null) return { kind: 'handoff', reason: screened.handoffReason, level: null, complexityScore: null };

    const outcome = await this.typing.while(
      { ctx: input.ctx, ticketId: input.ticketId, customerId: input.customer.id, showToCustomer: input.mode === 'auto' },
      () => this.chat(input, complexity),
    );
    if (outcome.kind === 'handoff') return { kind: 'handoff', reason: outcome.reason, ...meta };

    const { answer } = outcome;
    if (answer.reply.trim().length === 0) return { kind: 'handoff', reason: 'empty_reply', ...meta };
    if (answer.confidence < MIN_CONFIDENCE) return { kind: 'handoff', reason: 'low_confidence', ...meta };
    if (!answer.resolved && input.state.unresolvedTurns + 1 >= MAX_UNRESOLVED_TURNS) return { kind: 'handoff', reason: 'unresolved', ...meta };

    return {
      kind: input.mode === 'auto' ? 'answer' : 'draft',
      reply: answer.reply,
      ...meta,
      awaiting: answer.awaiting,
      resolved: answer.resolved,
    };
  }

  /** The tool loop. Returns the parsed final answer, or the model's own hand-off. */
  private async chat(input: TurnInput, complexity: ComplexityResult): Promise<{ kind: 'answer'; answer: z.infer<typeof Answer> } | { kind: 'handoff'; reason: string }> {
    const { level, score } = complexity;
    const model = modelForLevel(input.settings.models, level);
    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, renderConversation({ summary: input.summary, messages: input.messages, awaiting: input.state.awaiting })];
    const purpose = input.mode === 'auto' ? 'reply' : 'draft';
    const turn = newToolTurn();

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      // After the last round the tools are withdrawn, so the model has to answer.
      const withTools = round < MAX_TOOL_ROUNDS;
      const result = await this.runs.track(input.ctx, { purpose, model, level, complexityScore: score, ticketId: input.ticketId }, () =>
        this.provider.complete(input.credentials, {
          model,
          messages,
          ...(withTools ? { tools: TOOLS } : {}),
          responseSchema: ANSWER_SCHEMA,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          timeoutMs: CHAT_TIMEOUT_MS,
        }),
      );

      if (result.toolCalls.length === 0 || !withTools) {
        if (result.content === null) throw new Error('The chat model returned no answer');
        return { kind: 'answer', answer: parseAnswer(result.content) };
      }

      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        const outcome = await this.tools.execute(input, call, turn);
        if (outcome.kind === 'handoff') return outcome;
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
      }
    }
    throw new Error('unreachable: the last round has no tools');
  }
}

function parseAnswer(content: string): z.infer<typeof Answer> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error('The chat model did not return JSON');
  }
  const parsed = Answer.safeParse(json);
  if (!parsed.success) throw new Error('The chat model answered in the wrong shape');
  return parsed.data;
}
