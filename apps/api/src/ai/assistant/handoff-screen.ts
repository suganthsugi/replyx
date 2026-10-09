import { Inject, Injectable } from '@nestjs/common';

import { DECISION_MODEL } from '../providers/catalog.js';
import { AI_PROVIDER, type AiProvider, type DecisionAnswer, type DecisionQuestion } from '../providers/ports.js';
import { AiRunsRecorder } from '../runs/ai-runs.recorder.js';

import { renderForDecision } from './assistant-prompt.js';

import type { TurnInput } from './turn-brain.js';

/** The last messages the decision model reads (research R7). */
export const SCREEN_MESSAGES = 6;
/** A yes/no at or above this probability hands off. */
export const YES_NO_THRESHOLD = 0.7;
/** "angry" at or above this probability hands off. */
export const ANGRY_THRESHOLD = 0.6;

const FRUSTRATION_CRITERIA = [
  'calm: neutral or polite',
  'annoyed: irritated, impatient, or complaining',
  'angry: furious, abusive, threatening, or repeating complaints in strong words',
];

/** Keys of the hand-off questions; extra questions (complexity factors, T030) must not reuse them. */
export const HANDOFF_QUESTION_KEYS = ['wants_human', 'refund_or_exception', 'frustration'] as const;

const QUESTIONS: Record<(typeof HANDOFF_QUESTION_KEYS)[number], DecisionQuestion> = {
  wants_human: {
    type: 'noul',
    instructions: 'Decide whether the customer is asking to talk to a person.',
    criteria: {
      true: 'The customer asks for a human, an agent, a manager, the support team, or says they do not want to talk to a bot or an assistant.',
      false: 'The customer is not asking for a person.',
    },
  },
  refund_or_exception: {
    type: 'noul',
    instructions: 'Decide whether the customer asks for money back or for something outside the normal rules.',
    criteria: {
      true: 'The customer asks for a refund, a chargeback, compensation, a discount, a price adjustment, or an exception to a policy.',
      false: 'The customer asks a question, or asks for status or information only.',
    },
  },
  frustration: {
    type: 'score',
    instructions: "Rate the customer's frustration in their latest messages.",
    criteria: FRUSTRATION_CRITERIA,
  },
};

export interface ScreenResult {
  /** Why the turn must hand off, or null to go on with the chat model. */
  handoffReason: 'wants_human' | 'refund_or_exception' | 'frustrated' | null;
  /** Every answer of the call, including those of extra questions. */
  answers: Record<string, DecisionAnswer>;
}

/** Probability of the last (angriest) level; tolerates index or name keys, else uses the score's position. */
function angryProbability(answer: DecisionAnswer): number {
  if (answer.type !== 'score') return 0;
  const last = FRUSTRATION_CRITERIA.length - 1;
  const criterion = FRUSTRATION_CRITERIA[last]!;
  return answer.probabilities[String(last)] ?? answer.probabilities[criterion] ?? answer.probabilities[criterion.split(':')[0]!] ?? answer.score / last;
}

/**
 * The hand-off check of a turn: one call to the decision model (Jev) over the last 6 messages, three
 * questions, cheap and calibrated, before any costly chat call (research R7).
 *
 * The call is built to carry more: `run` takes extra questions that join the same request, and
 * returns all answers. US4's complexity scorer (T030) passes its factor questions here, so a turn
 * still makes a single decision call. One `ai_runs` row (purpose `complexity`) is recorded for it.
 */
@Injectable()
export class HandoffScreen {
  constructor(
    private readonly runs: AiRunsRecorder,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async run(input: TurnInput, extraQuestions: Record<string, DecisionQuestion> = {}): Promise<ScreenResult> {
    for (const key of Object.keys(extraQuestions)) {
      if ((HANDOFF_QUESTION_KEYS as readonly string[]).includes(key)) throw new Error(`Decision question key "${key}" is reserved for the hand-off check`);
    }
    const result = await this.runs.track(input.ctx, { purpose: 'complexity', model: DECISION_MODEL.id, ticketId: input.ticketId }, () =>
      this.provider.decide(input.credentials, {
        model: DECISION_MODEL.id,
        state: renderForDecision(input.messages.slice(-SCREEN_MESSAGES)),
        questions: { ...QUESTIONS, ...extraQuestions },
        timeoutMs: 15_000,
      }),
    );
    return { handoffReason: reasonFor(result.answers), answers: result.answers };
  }
}

function reasonFor(answers: Record<string, DecisionAnswer>): ScreenResult['handoffReason'] {
  const yes = (key: string): number => {
    const answer = answers[key];
    return answer?.type === 'noul' ? answer.noul : 0;
  };
  if (yes('wants_human') >= YES_NO_THRESHOLD) return 'wants_human';
  if (yes('refund_or_exception') >= YES_NO_THRESHOLD) return 'refund_or_exception';
  const frustration = answers.frustration;
  if (frustration !== undefined && angryProbability(frustration) >= ANGRY_THRESHOLD) return 'frustrated';
  return null;
}
