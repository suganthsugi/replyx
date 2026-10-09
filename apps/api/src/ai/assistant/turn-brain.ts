import { Injectable } from '@nestjs/common';

import type { TurnCustomer, TurnMessage } from './assistant.repositories.js';
import type { AiAwaiting, AiModelLevel } from '../../platform-kernel/db/tables/ai.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { ProviderCredentials } from '../providers/ports.js';
import type { AiSettingsRow } from '../settings/ai-settings.repository.js';

/**
 * The "think" phase of an assistant turn (research R6 phase 2, R7, R8). It runs with no database
 * transaction open: it may call the provider, search policies and look up orders, and it returns a
 * decision. It must not write messages, drafts or ticket state; the job's write phase does that
 * after re-checking the ticket (T021). T022 replaces `PlaceholderTurnBrain` behind `TURN_BRAIN`.
 *
 * Provider calls made here should be recorded with `AiRunsRecorder.track` using `ticketId` and no
 * `turnId`: the turn row does not exist yet, and `ai_runs.turn_id` is a foreign key.
 */

/** Everything the brain may look at. Public messages only; internal notes never reach it. */
export interface TurnInput {
  ctx: TenantContext;
  ticketId: string;
  customer: TurnCustomer;
  /** The mode when the turn was read. The write phase uses the mode it finds then. */
  mode: 'drafts' | 'auto';
  settings: AiSettingsRow;
  credentials: ProviderCredentials;
  /** The latest customer message: what this turn answers. Also the last customer entry of `messages`. */
  trigger: TurnMessage;
  /** The last 20 public messages, oldest first. */
  messages: readonly TurnMessage[];
  /** Rolling summary of everything older than `messages`, or null when the conversation is short. */
  summary: string | null;
  /** What earlier turns left open on this ticket. */
  state: { awaiting: AiAwaiting | null; unresolvedTurns: number };
  /** `last` is true on the final BullMQ attempt: the brain should hand off with `ai_unavailable` instead of throwing. */
  attempt: { number: number; last: boolean };
}

/** Facts the write phase records on the turn and the ticket state. */
export interface TurnMeta {
  level?: AiModelLevel | null;
  complexityScore?: number | null;
  /** The question the assistant left open, if any. */
  awaiting?: AiAwaiting | null;
  /** False counts toward the "2 unresolved turns in a row" hand-off; undefined leaves the count alone. */
  resolved?: boolean;
}

export type TurnDecision =
  /** A reply to post. In Drafts mode the write phase stores it as a draft instead. */
  | ({ kind: 'answer'; reply: string } & TurnMeta)
  /** A reply that must stay a draft, even if the mode became Auto-reply meanwhile. */
  | ({ kind: 'draft'; reply: string } & TurnMeta)
  /** Stop and pass the ticket to staff. `reason` becomes `handoff:{reason}` (lower-case letters and `_`, up to 40). */
  | ({ kind: 'handoff'; reason: string } & Pick<TurnMeta, 'level' | 'complexityScore'>);

export interface TurnBrain {
  /** Throwing retries the job; provider `auth`/`credit` errors pause the tenant (the job handles it). */
  think(input: TurnInput): Promise<TurnDecision>;
}

export const TURN_BRAIN = Symbol('TURN_BRAIN');

/** Until T022: never answers, hands every turn to staff, so nothing is posted that was not thought through. */
@Injectable()
export class PlaceholderTurnBrain implements TurnBrain {
  think(): Promise<TurnDecision> {
    return Promise.resolve({ kind: 'handoff', reason: 'not_ready' });
  }
}
