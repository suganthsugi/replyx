import { sql } from 'kysely';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { AiAwaiting, AiDraftStatus, AiModelLevel, AiStopReason, AiTurnOutcome } from '../../platform-kernel/db/tables/ai.js';
import type { MessageAuthorKind } from '../../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/**
 * Data access for the assistant's per-ticket state, turns, drafts and the conversation it reads
 * (data-model.md `ai_ticket_state`, `ai_turns`, `ai_drafts`). Tenant scoping comes from
 * `TenantRepository`; no query here is built from request input.
 *
 * Lock order for anything that touches both: the ticket row first (`TicketsRepository.lock`), then
 * `ai_ticket_state`. The turn's write phase and the writers it calls (`AssistantMessageWriter`
 * locks the ticket) use that order, so take-over and hand-back (T024) must too.
 */

export interface AiTicketState {
  stoppedReason: AiStopReason | null;
  takenOverBy: string | null;
  agentRepliedAt: Date | null;
  awaiting: AiAwaiting | null;
  unresolvedTurns: number;
  summary: string | null;
  summaryUptoMessageId: string | null;
}

const STATE_COLUMNS = [
  'ai_ticket_state.stopped_reason',
  'ai_ticket_state.taken_over_by',
  'ai_ticket_state.agent_replied_at',
  'ai_ticket_state.awaiting',
  'ai_ticket_state.unresolved_turns',
  'ai_ticket_state.summary',
  'ai_ticket_state.summary_upto_message_id',
] as const;

interface RawState {
  stopped_reason: AiStopReason | null;
  taken_over_by: string | null;
  agent_replied_at: Date | null;
  awaiting: AiAwaiting | null;
  unresolved_turns: number;
  summary: string | null;
  summary_upto_message_id: string | null;
}

function toState(row: RawState): AiTicketState {
  return {
    stoppedReason: row.stopped_reason,
    takenOverBy: row.taken_over_by,
    agentRepliedAt: row.agent_replied_at,
    awaiting: row.awaiting,
    unresolvedTurns: row.unresolved_turns,
    summary: row.summary,
    summaryUptoMessageId: row.summary_upto_message_id,
  };
}

export class AiTicketStateRepository extends TenantRepository {
  async find(tx: TenantTransaction, ticketId: string): Promise<AiTicketState | undefined> {
    const row = await this.selectFrom(tx, 'ai_ticket_state').select(STATE_COLUMNS).where('ai_ticket_state.ticket_id', '=', ticketId).executeTakeFirst();
    return row === undefined ? undefined : toState(row);
  }

  /** The row locked for the rest of the transaction, created empty first when the ticket has none. The ticket must exist. */
  async ensureLocked(tx: TenantTransaction, ticketId: string): Promise<AiTicketState> {
    await this.insertInto(tx, 'ai_ticket_state', { ticket_id: ticketId })
      .onConflict((oc) => oc.columns(['tenant_id', 'ticket_id']).doNothing())
      .execute();
    const row = await this.selectFrom(tx, 'ai_ticket_state').select(STATE_COLUMNS).where('ai_ticket_state.ticket_id', '=', ticketId).forUpdate().executeTakeFirstOrThrow();
    return toState(row);
  }

  /** A staff public reply stops the assistant's posting (FR-016); a hand-off or take-over reason is kept. */
  async recordAgentReply(tx: TenantTransaction, ticketId: string, now: Date): Promise<void> {
    await this.insertInto(tx, 'ai_ticket_state', { ticket_id: ticketId, agent_replied_at: now, stopped_reason: 'agent_replied' })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'ticket_id']).doUpdateSet({
          agent_replied_at: now,
          stopped_reason: sql<AiStopReason>`coalesce(ai_ticket_state.stopped_reason, 'agent_replied')`,
        }),
      )
      .execute();
  }

  /** An agent took the ticket over (R17). The row must exist (`ensureLocked`). */
  async takeOver(tx: TenantTransaction, ticketId: string, userId: string): Promise<void> {
    await this.updateTable(tx, 'ai_ticket_state')
      .set({ stopped_reason: 'taken_over', taken_over_by: userId })
      .where('ai_ticket_state.ticket_id', '=', ticketId)
      .execute();
  }

  /** Hand back to the assistant: every stop field and the unresolved run are cleared (R17). */
  async handBack(tx: TenantTransaction, ticketId: string): Promise<void> {
    await this.updateTable(tx, 'ai_ticket_state')
      .set({ stopped_reason: null, taken_over_by: null, agent_replied_at: null, unresolved_turns: 0 })
      .where('ai_ticket_state.ticket_id', '=', ticketId)
      .execute();
  }

  async stop(tx: TenantTransaction, ticketId: string, reason: AiStopReason): Promise<void> {
    await this.updateTable(tx, 'ai_ticket_state').set({ stopped_reason: reason }).where('ai_ticket_state.ticket_id', '=', ticketId).execute();
  }

  /** What an answer or draft leaves behind: the open question and the run of unresolved turns. */
  async recordTurn(tx: TenantTransaction, ticketId: string, change: { awaiting: AiAwaiting | null; resolved: boolean | undefined }): Promise<void> {
    await this.updateTable(tx, 'ai_ticket_state')
      .set({
        awaiting: change.awaiting,
        ...(change.resolved === undefined ? {} : { unresolved_turns: change.resolved ? 0 : sql<number>`ai_ticket_state.unresolved_turns + 1` }),
      })
      .where('ai_ticket_state.ticket_id', '=', ticketId)
      .execute();
  }

  /** Saves the rolling summary; creates the row when the ticket has none yet. The ticket must exist. */
  async setSummary(tx: TenantTransaction, ticketId: string, summary: string, uptoMessageId: string): Promise<void> {
    await this.insertInto(tx, 'ai_ticket_state', { ticket_id: ticketId, summary, summary_upto_message_id: uptoMessageId })
      .onConflict((oc) => oc.columns(['tenant_id', 'ticket_id']).doUpdateSet({ summary, summary_upto_message_id: uptoMessageId }))
      .execute();
  }
}

export interface NewTurn {
  id: string;
  ticketId: string;
  triggerMessageId: string;
  outcome: AiTurnOutcome;
  level: AiModelLevel | null;
  complexityScore: number | null;
}

export class AiTurnsRepository extends TenantRepository {
  /** False when the trigger message already has a turn (`ai_turns_once_per_message`). */
  async insert(tx: TenantTransaction, turn: NewTurn): Promise<boolean> {
    const row = await this.insertInto(tx, 'ai_turns', {
      id: turn.id,
      ticket_id: turn.ticketId,
      trigger_message_id: turn.triggerMessageId,
      outcome: turn.outcome,
      level: turn.level,
      complexity_score: turn.complexityScore,
    })
      .onConflict((oc) => oc.columns(['tenant_id', 'ticket_id', 'trigger_message_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async existsFor(tx: TenantTransaction, ticketId: string, triggerMessageId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'ai_turns')
      .select('ai_turns.id')
      .where('ai_turns.ticket_id', '=', ticketId)
      .where('ai_turns.trigger_message_id', '=', triggerMessageId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async attach(tx: TenantTransaction, turnId: string, result: { messageId?: string; draftId?: string }): Promise<void> {
    await this.updateTable(tx, 'ai_turns')
      .set({ ...(result.messageId === undefined ? {} : { message_id: result.messageId }), ...(result.draftId === undefined ? {} : { draft_id: result.draftId }) })
      .where('ai_turns.id', '=', turnId)
      .execute();
  }
}

export class AiDraftsRepository extends TenantRepository {
  /**
   * Closes the ticket's open draft after a staff public reply: `sent` when the reply carried that
   * draft's id, else `superseded`. Returns the draft's new status, or undefined when none was open.
   */
  async resolveOpen(tx: TenantTransaction, ticketId: string, reply: { aiDraftId: string | null; resolvedBy: string | null; now: Date }): Promise<AiDraftStatus | undefined> {
    const row = await this.updateTable(tx, 'ai_drafts')
      .set({
        status: reply.aiDraftId === null ? 'superseded' : sql<AiDraftStatus>`case when ai_drafts.id = ${reply.aiDraftId} then 'sent' else 'superseded' end`,
        resolved_by: reply.resolvedBy,
        resolved_at: reply.now,
      })
      .where('ai_drafts.ticket_id', '=', ticketId)
      .where('ai_drafts.status', '=', 'open')
      .returning('ai_drafts.status')
      .executeTakeFirst();
    return row?.status;
  }

  /** The ticket's open draft, replaced in place by each new drafts-mode turn (research R13). */
  async upsertOpen(tx: TenantTransaction, input: { ticketId: string; turnId: string; body: string }): Promise<string> {
    const updated = await this.updateTable(tx, 'ai_drafts')
      .set({ turn_id: input.turnId, body: input.body })
      .where('ai_drafts.ticket_id', '=', input.ticketId)
      .where('ai_drafts.status', '=', 'open')
      .returning('ai_drafts.id')
      .executeTakeFirst();
    if (updated !== undefined) return updated.id;
    const inserted = await this.insertInto(tx, 'ai_drafts', { ticket_id: input.ticketId, turn_id: input.turnId, body: input.body })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }
}

/** A public message as the turn sees it (internal notes never reach the assistant). */
export interface TurnMessage {
  id: string;
  authorKind: MessageAuthorKind;
  body: string;
  createdAt: Date;
  /** The fixed hand-off notice. */
  handoff: boolean;
}

const TURN_MESSAGE_COLUMNS = [
  'ticket_messages.id',
  'ticket_messages.author_kind',
  'ticket_messages.body',
  'ticket_messages.created_at',
  'ticket_messages.metadata',
] as const;

interface RawTurnMessage {
  id: string;
  author_kind: MessageAuthorKind;
  body: string;
  created_at: Date;
  metadata: { handoff?: boolean } | null;
}

function toTurnMessage(row: RawTurnMessage): TurnMessage {
  return { id: row.id, authorKind: row.author_kind, body: row.body, createdAt: row.created_at, handoff: row.metadata?.handoff === true };
}

export interface TurnCustomer {
  id: string;
  name: string;
  email: string;
}

/** Reads of a ticket's conversation for the turn job; public messages only. */
export class AssistantConversationRepository extends TenantRepository {
  /** The newest public customer message: the turn's trigger. */
  async latestCustomerMessage(tx: TenantTransaction, ticketId: string): Promise<TurnMessage | undefined> {
    const row = await this.selectFrom(tx, 'ticket_messages')
      .select(TURN_MESSAGE_COLUMNS)
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.visibility', '=', 'public')
      .where('ticket_messages.author_kind', '=', 'customer')
      .orderBy('ticket_messages.created_at', 'desc')
      .orderBy('ticket_messages.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toTurnMessage(row);
  }

  /** The last `limit` public messages, oldest first. */
  async recent(tx: TenantTransaction, ticketId: string, limit: number): Promise<TurnMessage[]> {
    const rows = await this.selectFrom(tx, 'ticket_messages')
      .select(TURN_MESSAGE_COLUMNS)
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.visibility', '=', 'public')
      .orderBy('ticket_messages.created_at', 'desc')
      .orderBy('ticket_messages.id', 'desc')
      .limit(limit)
      .execute();
    return rows.reverse().map(toTurnMessage);
  }

  /**
   * Public messages older than `windowStartId` and newer than `afterId` (the summary's end), the
   * newest `limit` of them, oldest first. Compared inside the database so microseconds are kept.
   */
  async olderThan(tx: TenantTransaction, ticketId: string, windowStartId: string, afterId: string | null, limit: number): Promise<TurnMessage[]> {
    const tenantId = this.ctx.tenantId;
    let query = this.selectFrom(tx, 'ticket_messages')
      .select(TURN_MESSAGE_COLUMNS)
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.visibility', '=', 'public')
      .where(
        sql<boolean>`(ticket_messages.created_at, ticket_messages.id) < (select m.created_at, m.id from ticket_messages m where m.id = ${windowStartId} and m.tenant_id = ${tenantId})`,
      );
    if (afterId !== null) {
      query = query.where(
        sql<boolean>`(ticket_messages.created_at, ticket_messages.id) > (select m.created_at, m.id from ticket_messages m where m.id = ${afterId} and m.tenant_id = ${tenantId})`,
      );
    }
    const rows = await query.orderBy('ticket_messages.created_at', 'desc').orderBy('ticket_messages.id', 'desc').limit(limit).execute();
    return rows.reverse().map(toTurnMessage);
  }

  /** Whether a customer or staff public message arrived after `messageId` (the turn is then stale). */
  async hasNewerPublicMessage(tx: TenantTransaction, ticketId: string, messageId: string): Promise<boolean> {
    const tenantId = this.ctx.tenantId;
    const row = await this.selectFrom(tx, 'ticket_messages')
      .select('ticket_messages.id')
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.visibility', '=', 'public')
      .where('ticket_messages.author_kind', 'in', ['customer', 'staff'])
      .where(
        sql<boolean>`(ticket_messages.created_at, ticket_messages.id) > (select m.created_at, m.id from ticket_messages m where m.id = ${messageId} and m.tenant_id = ${tenantId})`,
      )
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async customer(tx: TenantTransaction, customerId: string): Promise<TurnCustomer | undefined> {
    const row = await this.selectFrom(tx, 'users').select(['users.id', 'users.name', 'users.email']).where('users.id', '=', customerId).executeTakeFirst();
    return row;
  }

  /** The `aiDraftId` a staff reply carried in its metadata, if any (T023 stores it there). */
  async aiDraftIdOf(tx: TenantTransaction, messageId: string): Promise<string | null> {
    const row = await this.selectFrom(tx, 'ticket_messages').select('ticket_messages.metadata').where('ticket_messages.id', '=', messageId).executeTakeFirst();
    const value = (row?.metadata as Record<string, unknown> | null | undefined)?.aiDraftId;
    return typeof value === 'string' ? value : null;
  }
}
