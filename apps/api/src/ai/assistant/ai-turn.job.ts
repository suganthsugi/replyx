import { Inject, Injectable } from '@nestjs/common';

import { AssistantMessageWriter } from '../../messaging/assistant-message.writer.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { DEFAULT_ATTEMPTS } from '../../platform-kernel/jobs/queues.js';
import { runWithLogContext } from '../../platform-kernel/observability/logger.js';
import { TicketsRepository } from '../../tickets/tickets.repository.js';
import { ProviderError } from '../providers/ports.js';
import { AiStatus, isActive } from '../settings/ai-status.js';

import { blocksAssistant } from './ai-ticket-status.js';
import { AiTicketStateRepository, AiTurnsRepository, AssistantConversationRepository, type TurnMessage } from './assistant.repositories.js';
import { CONTEXT_WINDOW, ConversationSummary, MAX_UNSUMMARISED, type SummaryState } from './conversation-summary.js';
import { DRAFT_WRITER, type DraftWriter } from './draft-writer.js';
import { HandoffWriter } from './handoff-writer.js';
import { TURN_BRAIN, type TurnBrain, type TurnDecision, type TurnInput } from './turn-brain.js';

import type { AiTurnOutcome } from '../../platform-kernel/db/tables/ai.js';
import type { Job } from 'bullmq';

/** The job's name on queue `ai` (research R6). */
export const AI_TURN_JOB = 'ai-turn';
/** A burst of customer messages becomes one turn, run this long after the last one. */
export const TURN_DELAY_MS = 3_000;
/** Provider errors are retried 3 times with exponential back-off before the turn hands off (research R10). */
export const TURN_ATTEMPTS = 3;
export const TURN_BACKOFF_MS = 2_000;

export interface AiTurnJobData {
  tenantId: string;
  ticketId: string;
}

/**
 * BullMQ deduplication id: one pending turn per ticket. BullMQ rejects custom ids with a single
 * `:` (T015), so dots separate the parts.
 */
export function turnDeduplicationId(tenantId: string, ticketId: string): string {
  return `turn.${tenantId}.${ticketId}`;
}

export type TurnJobOutcome = AiTurnOutcome | 'dropped' | 'duplicate' | 'skipped' | 'paused';

/** Phase 1's result: what to think about, or why there is nothing to do. */
type Snapshot =
  | { kind: 'skip'; reason: 'gone' | 'inactive' | 'stopped' | 'no_trigger' | 'duplicate' | 'stale' }
  | { kind: 'ready'; input: Omit<TurnInput, 'summary' | 'attempt'>; summary: SummaryState };

/**
 * The `ai-turn` job: one assistant turn for one ticket (specs/002-ai-assist research R6).
 *
 * 1. **Read** (read-only transaction): settings, the ticket's AI state, the last 20 public messages
 *    and the summary. The trigger is the latest customer message.
 * 2. **Think** (no transaction): refresh the summary, then ask the `TurnBrain` (T022) for a decision.
 * 3. **Write** (one transaction): lock the ticket, then `ai_ticket_state`; re-check that AI is still
 *    on, the assistant is not stopped, and no customer or staff message arrived after the trigger;
 *    insert the `ai_turns` row (its unique key makes a second run exit quietly); then post the
 *    answer, store the draft or hand off. Events are appended in the same transaction.
 *
 * No transaction is open during a provider call. Running the job twice for one trigger message
 * produces one reply or draft: the read phase sees the turn, and the write phase's insert refuses a
 * second one.
 */
@Injectable()
export class AiTurnJob extends JobProcessor<AiTurnJobData> {
  readonly queue = 'ai' as const;
  readonly jobName = AI_TURN_JOB;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly status: AiStatus,
    private readonly summary: ConversationSummary,
    private readonly messages: AssistantMessageWriter,
    private readonly handoffs: HandoffWriter,
    @Inject(TURN_BRAIN) private readonly brain: TurnBrain,
    @Inject(DRAFT_WRITER) private readonly drafts: DraftWriter,
  ) {
    super();
  }

  process(data: AiTurnJobData, job: Job<AiTurnJobData>): Promise<TurnJobOutcome> {
    const ctx = TenantContext.create({ tenantId: data.tenantId, actor: { kind: 'system' }, requestId: `job:${job.id ?? data.ticketId}`.slice(0, 128) });
    return runWithLogContext({ tenantId: ctx.tenantId, jobId: job.id }, () => this.run(ctx, data, job));
  }

  private async run(ctx: TenantContext, data: AiTurnJobData, job: Job<AiTurnJobData>): Promise<TurnJobOutcome> {
    const snapshot = await this.read(ctx, data.ticketId);
    if (snapshot.kind === 'skip') return snapshot.reason === 'duplicate' ? 'duplicate' : 'skipped';

    let decision: TurnDecision;
    try {
      const summary = await this.summary.refresh(ctx, snapshot.summary, snapshot.input.settings, snapshot.input.credentials);
      decision = await this.brain.think({
        ...snapshot.input,
        summary,
        attempt: { number: job.attemptsMade + 1, last: job.attemptsMade + 1 >= (job.opts.attempts ?? DEFAULT_ATTEMPTS) },
      });
    } catch (error) {
      // A rejected key or an empty account pauses the tenant's AI (research R10); nothing to retry.
      if (error instanceof ProviderError && error.pausesTenant) {
        await this.status.pauseFor(ctx, error);
        return 'paused';
      }
      throw error;
    }
    return this.write(ctx, snapshot.input.ticketId, snapshot.input.trigger.id, normalise(decision));
  }

  // --- Phase 1 -------------------------------------------------------------------------------------

  private read(ctx: TenantContext, ticketId: string): Promise<Snapshot> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx): Promise<Snapshot> => {
      const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
      if (ticket === undefined || ticket.merged_into_id !== null) return { kind: 'skip', reason: 'gone' };

      const settings = await this.status.settings(ctx, tx);
      const credentials = isActive(settings) && settings.replyMode !== 'off' ? this.status.credentials(settings) : undefined;
      if (credentials === undefined || settings.replyMode === 'off') return { kind: 'skip', reason: 'inactive' };

      const state = await new AiTicketStateRepository(ctx).find(tx, ticketId);
      if (blocksAssistant(state, settings.replyMode)) return { kind: 'skip', reason: 'stopped' };

      const conversation = new AssistantConversationRepository(ctx);
      const trigger = await conversation.latestCustomerMessage(tx, ticketId);
      if (trigger === undefined) return { kind: 'skip', reason: 'no_trigger' };
      if (await new AiTurnsRepository(ctx).existsFor(tx, ticketId, trigger.id)) return { kind: 'skip', reason: 'duplicate' };
      // Someone already replied after the customer: there is nothing left to answer.
      if (await conversation.hasNewerPublicMessage(tx, ticketId, trigger.id)) return { kind: 'skip', reason: 'stale' };

      const messages = await conversation.recent(tx, ticketId, CONTEXT_WINDOW);
      const first = messages[0];
      if (first === undefined || !messages.some((message) => message.id === trigger.id)) return { kind: 'skip', reason: 'stale' };
      const unsummarised: TurnMessage[] =
        messages.length >= CONTEXT_WINDOW ? await conversation.olderThan(tx, ticketId, first.id, state?.summaryUptoMessageId ?? null, MAX_UNSUMMARISED) : [];

      const customer = await conversation.customer(tx, ticket.customer_id);
      if (customer === undefined) return { kind: 'skip', reason: 'gone' };

      return {
        kind: 'ready',
        input: {
          ctx,
          ticketId,
          customer,
          mode: settings.replyMode,
          settings,
          credentials,
          trigger,
          messages,
          state: { awaiting: state?.awaiting ?? null, unresolvedTurns: state?.unresolvedTurns ?? 0 },
        },
        summary: { ticketId, summary: state?.summary ?? null, unsummarised },
      };
    });
  }

  // --- Phase 3 -------------------------------------------------------------------------------------

  private write(ctx: TenantContext, ticketId: string, triggerMessageId: string, decision: TurnDecision): Promise<TurnJobOutcome> {
    return this.unitOfWork.withTenant(ctx, async (tx): Promise<TurnJobOutcome> => {
      // Ticket first, then the AI state: the order every writer of both uses (assistant.repositories.ts).
      const ticket = await new TicketsRepository(ctx).lock(tx, ticketId);
      if (ticket === undefined || ticket.merged_into_id !== null) return 'dropped';
      const state = await new AiTicketStateRepository(ctx).ensureLocked(tx, ticketId);

      const settings = await this.status.settings(ctx, tx);
      if (!isActive(settings) || settings.replyMode === 'off') return 'dropped';
      const mode = settings.replyMode;
      if (blocksAssistant(state, mode)) return 'dropped';
      // A newer message means a newer turn will answer; a staff reply means a person has it.
      if (await new AssistantConversationRepository(ctx).hasNewerPublicMessage(tx, ticketId, triggerMessageId)) return 'dropped';

      // A draft stays a draft; an answer becomes one when the mode switched to Drafts meanwhile.
      const outcome: AiTurnOutcome = decision.kind === 'handoff' ? 'handoff' : decision.kind === 'draft' || mode === 'drafts' ? 'drafted' : 'replied';
      const turnId = uuidv7();
      const turns = new AiTurnsRepository(ctx);
      const inserted = await turns.insert(tx, {
        id: turnId,
        ticketId,
        triggerMessageId,
        outcome,
        level: decision.level ?? null,
        complexityScore: decision.complexityScore ?? null,
      });
      if (!inserted) return 'duplicate';

      if (decision.kind === 'handoff') {
        const noticeId = await this.handoffs.write(tx, { ticketId, turnId, reason: decision.reason, mode });
        if (noticeId !== undefined) await turns.attach(tx, turnId, { messageId: noticeId });
        return outcome;
      }

      if (outcome === 'drafted') {
        const { draftId } = await this.drafts.write(tx, { ticketId, turnId, body: decision.reply });
        await turns.attach(tx, turnId, { draftId });
      } else {
        const message = await this.messages.write(tx, { ticketId, body: decision.reply, clientMessageId: `ai-turn:${turnId}`, kind: 'answer' });
        await turns.attach(tx, turnId, { messageId: message.id });
      }
      await new AiTicketStateRepository(ctx).recordTurn(tx, ticketId, { awaiting: decision.awaiting ?? null, resolved: decision.resolved });
      return outcome;
    });
  }
}

/** An empty reply is not posted: it is a hand-off. */
function normalise(decision: TurnDecision): TurnDecision {
  if (decision.kind !== 'handoff' && decision.reply.trim().length === 0) {
    return { kind: 'handoff', reason: 'empty_reply', level: decision.level ?? null, complexityScore: decision.complexityScore ?? null };
  }
  return decision;
}
