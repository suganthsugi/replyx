import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../../platform-kernel/jobs/idempotent-handler.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { DEFAULT_ATTEMPTS, QueueRegistry } from '../../platform-kernel/jobs/queues.js';
import { runWithLogContext } from '../../platform-kernel/observability/logger.js';
import { TicketHistoryService } from '../../tickets/ticket-history.service.js';
import { TicketsRepository, type TicketRow } from '../../tickets/tickets.repository.js';
import { SUPPORT, TicketsService } from '../../tickets/tickets.service.js';
import { DECISION_MODEL } from '../providers/catalog.js';
import { AI_PROVIDER, ProviderError, type AiProvider, type ProviderCredentials } from '../providers/ports.js';
import { AiRunsRecorder } from '../runs/ai-runs.recorder.js';
import { AiStatus, isActive } from '../settings/ai-status.js';

import type { TicketOrigin } from '../../platform-kernel/db/tables/tickets.js';
import type { DomainEventType } from '../../platform-kernel/outbox/event-types.js';
import type { AiSettingsRow } from '../settings/ai-settings.repository.js';
import type { Job } from 'bullmq';

/** The job's name on queue `ai` (research R6, R11). */
export const AI_ROUTE_JOB = 'ai-route';
/** Tickets a customer started; staff-started and split tickets are routed by people. */
const CUSTOMER_ORIGINS: readonly TicketOrigin[] = ['customer_message', 'follow_up'];
/** The `none` option of the routing question. */
export const NO_GROUP = 'none';
const ROUTE_TIMEOUT_MS = 15_000;
const MESSAGE_CHARS = 2_000;

export interface AiRouteJobData {
  tenantId: string;
  ticketId: string;
}

/** BullMQ job id, one per ticket: a redelivered `ticket.created` never routes twice. BullMQ rejects `:`. */
export function routeJobId(ticketId: string): string {
  return `route.${ticketId}`;
}

export type RouteOutcome = 'routed' | 'below_threshold' | 'none' | 'skipped' | 'dropped' | 'paused' | 'failed';

type Handled = Extract<DomainEventType, 'ticket.created'>;

/** `ticket.created` → the `ai-route` job, for an ungrouped customer ticket while AI routing is on. */
@Injectable()
export class AiRouteConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'ai-route-trigger';
  readonly queue = 'ai' as const;
  readonly eventTypes: readonly Handled[] = ['ticket.created'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly status: AiStatus,
    private readonly queues: QueueRegistry,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const { ticket } = event.payload as { ticket: { id: string; group: { id: string } | null } };
    if (ticket.group !== null) return;
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AiRouteConsumer.handle must run inside withTenant');
    const settings = await this.status.settings(ctx, tx);
    if (!routingOn(settings)) return;
    const data: AiRouteJobData = { tenantId: event.tenantId, ticketId: ticket.id };
    await this.queues.get('ai').add(AI_ROUTE_JOB, data, { jobId: routeJobId(ticket.id), attempts: DEFAULT_ATTEMPTS, backoff: { type: 'exponential', delay: 2_000 } });
  }
}

function routingOn(settings: AiSettingsRow): boolean {
  return settings.routingEnabled && isActive(settings);
}

interface Candidate {
  id: string;
  name: string;
  aiDescription: string;
}

type Snapshot =
  | { kind: 'skip' }
  | { kind: 'ready'; settings: AiSettingsRow; credentials: ProviderCredentials; title: string; message: string; groups: Candidate[] };

/**
 * The `ai-route` job (specs/002-ai-assist research R11, FR-023/024). Rules first, AI second, people
 * last: it runs only for a customer ticket that is still ungrouped, that no routing rule touched
 * (no `routing` history entry), while AI is active and routing is on.
 *
 * 1. **Read** (read-only transaction): the ticket, its first customer message, and the active groups
 *    that have an AI description.
 * 2. **Think** (no transaction): one `choice` question to the decision model over those groups plus
 *    `none`, recorded as an `ai_runs` row with purpose `routing`.
 * 3. **Write** (one transaction): when the choice is a group with probability ≥ the threshold, lock
 *    the ticket and, only if it is still ungrouped (manual triage wins), move it through
 *    `TicketsService.applyLocked` and record history `ai_routing { groupId, confidence }`.
 *
 * The decision is not stored on the job: a write that fails and retries asks the model again (one
 * more cheap decision call). Any failure leaves the ticket in Needs Triage: provider `auth`/`credit` errors pause the tenant,
 * other errors are retried and, on the last attempt, given up quietly.
 */
@Injectable()
export class AiRouteJob extends JobProcessor<AiRouteJobData> {
  readonly queue = 'ai' as const;
  readonly jobName = AI_ROUTE_JOB;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly status: AiStatus,
    private readonly runs: AiRunsRecorder,
    private readonly tickets: TicketsService,
    private readonly history: TicketHistoryService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {
    super();
  }

  process(data: AiRouteJobData, job: Job<AiRouteJobData>): Promise<RouteOutcome> {
    const ctx = TenantContext.create({ tenantId: data.tenantId, actor: { kind: 'system' }, requestId: `job:${job.id ?? data.ticketId}`.slice(0, 128) });
    return runWithLogContext({ tenantId: ctx.tenantId, jobId: job.id }, () => this.run(ctx, data.ticketId, job));
  }

  private async run(ctx: TenantContext, ticketId: string, job: Job<AiRouteJobData>): Promise<RouteOutcome> {
    const snapshot = await this.read(ctx, ticketId);
    if (snapshot.kind === 'skip') return 'skipped';

    let choice: { groupId: string | null; confidence: number };
    try {
      choice = await this.ask(ctx, ticketId, snapshot);
    } catch (error) {
      if (error instanceof ProviderError && error.pausesTenant) {
        await this.status.pauseFor(ctx, error);
        return 'paused';
      }
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? DEFAULT_ATTEMPTS)) return 'failed';
      throw error;
    }
    if (choice.groupId === null) return 'none';
    if (choice.confidence < snapshot.settings.routingThreshold) return 'below_threshold';
    return this.write(ctx, ticketId, choice.groupId, choice.confidence);
  }

  private read(ctx: TenantContext, ticketId: string): Promise<Snapshot> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx): Promise<Snapshot> => {
      const settings = await this.status.settings(ctx, tx);
      const credentials = this.status.credentials(settings);
      if (!routingOn(settings) || credentials === undefined) return { kind: 'skip' };
      const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
      if (ticket === undefined || !routable(ticket)) return { kind: 'skip' };
      const repo = new RouteRepository(ctx);
      if (await repo.ruleRouted(tx, ticketId)) return { kind: 'skip' };
      const groups = await repo.candidates(tx);
      if (groups.length === 0) return { kind: 'skip' };
      const message = await repo.firstCustomerMessage(tx, ticketId);
      return { kind: 'ready', settings, credentials, title: ticket.title, message: (message ?? '').slice(0, MESSAGE_CHARS), groups };
    });
  }

  private async ask(ctx: TenantContext, ticketId: string, snapshot: Extract<Snapshot, { kind: 'ready' }>): Promise<{ groupId: string | null; confidence: number }> {
    const criteria: Record<string, string> = Object.fromEntries(snapshot.groups.map((group) => [group.id, `${group.name}: ${group.aiDescription}`]));
    criteria[NO_GROUP] = 'None of these teams fit';
    const result = await this.runs.track(ctx, { purpose: 'routing', model: DECISION_MODEL.id, ticketId }, () =>
      this.provider.decide(snapshot.credentials, {
        model: DECISION_MODEL.id,
        state: { title: snapshot.title, message: snapshot.message },
        questions: { route: { type: 'choice', instructions: 'Choose the support team that should handle this customer request.', criteria } },
        timeoutMs: ROUTE_TIMEOUT_MS,
      }),
    );
    const answer = result.answers.route;
    if (answer?.type !== 'choice' || answer.choice === NO_GROUP || criteria[answer.choice] === undefined) return { groupId: null, confidence: 0 };
    return { groupId: answer.choice, confidence: answer.probabilities[answer.choice] ?? answer.confidence };
  }

  private write(ctx: TenantContext, ticketId: string, groupId: string, confidence: number): Promise<RouteOutcome> {
    return this.unitOfWork.withTenant(ctx, async (tx): Promise<RouteOutcome> => {
      const before = await new TicketsRepository(ctx).lock(tx, ticketId);
      // Triaged by a person (or merged) while the model was thinking: theirs stands.
      if (before === undefined || !routable(before)) return 'dropped';
      const settings = await this.status.settings(ctx, tx);
      if (!routingOn(settings)) return 'dropped';
      if (!(await new RouteRepository(ctx).isCandidate(tx, groupId))) return 'dropped';
      // Moving out of Ungrouped needs no group permission: the system acts as the support viewer.
      await this.tickets.applyLocked(ctx, tx, SUPPORT, before, { groupId }, { historyActorKind: 'ai' });
      const rounded = Math.round(confidence * 1000) / 1000;
      await this.history.record(tx, ticketId, [{ field: 'ai_routing', old: null, new: { groupId, confidence: rounded } }], { actorKind: 'ai' });
      return 'routed';
    });
  }
}

function routable(ticket: TicketRow): boolean {
  return ticket.group_id === null && ticket.merged_into_id === null && CUSTOMER_ORIGINS.includes(ticket.origin);
}

class RouteRepository extends TenantRepository {
  /** A routing rule acted on the ticket (its history has a `routing` entry). */
  async ruleRouted(tx: TenantTransaction, ticketId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'ticket_history')
      .select('ticket_history.id')
      .where('ticket_history.ticket_id', '=', ticketId)
      .where('ticket_history.actor_kind', '=', 'routing')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async candidates(tx: TenantTransaction): Promise<Candidate[]> {
    const rows = await this.selectFrom(tx, 'groups')
      .select(['groups.id', 'groups.name', 'groups.ai_description'])
      .where('groups.status', '=', 'active')
      .where(sql<boolean>`coalesce(btrim(groups.ai_description), '') <> ''`)
      .orderBy('groups.name')
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name, aiDescription: row.ai_description ?? '' }));
  }

  async isCandidate(tx: TenantTransaction, groupId: string): Promise<boolean> {
    return (await this.candidates(tx)).some((group) => group.id === groupId);
  }

  async firstCustomerMessage(tx: TenantTransaction, ticketId: string): Promise<string | undefined> {
    const row = await this.selectFrom(tx, 'ticket_messages')
      .select('ticket_messages.body')
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.author_kind', '=', 'customer')
      .where('ticket_messages.visibility', '=', 'public')
      .orderBy('ticket_messages.created_at')
      .orderBy('ticket_messages.id')
      .limit(1)
      .executeTakeFirst();
    return row?.body;
  }
}
