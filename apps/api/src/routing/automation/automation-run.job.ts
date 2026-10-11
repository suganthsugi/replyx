import { Injectable, Logger } from '@nestjs/common';

import { decide, PolicyService } from '../../authorization/policy.service.js';
import { AutomationMessageWriter } from '../../messaging/automation-message.writer.js';
import { DirectNotifier } from '../../notifications/direct-notifier.js';
import { Clock } from '../../platform-kernel/clock.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { AppError } from '../../platform-kernel/http/app-error.js';
import { uuidv7 } from '../../platform-kernel/ids.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { TagsService } from '../../tags/tags.service.js';
import { TicketsRepository, type TicketRow } from '../../tickets/tickets.repository.js';
import { AUTOMATION, TicketsService, type TicketUpdateInput } from '../../tickets/tickets.service.js';

import { AUTOMATION_RUN_JOB, AutomationMatchRepository, autoReplyKey, type AutomationRunJobData } from './automation-engine.js';
import { AutomationRulesRepository, type AutomationRuleRow } from './automation-rules.repository.js';

import type { Job } from 'bullmq';

/**
 * Runs one automation rule on one ticket (US17, FR-088, FR-089), in the worker, in one
 * transaction, as the rule: the context's actor is `{ kind: 'automation', id: ruleId }` and its
 * cause `{ ruleId, depth, eventId }`, so history credits the rule and every event the run writes
 * carries the cause (the consumer never runs a rule on its own events and stops chains at
 * `MAX_CHAIN_DEPTH`).
 *
 * At run time it checks again that the rule is still enabled, the ticket still matches, it has not
 * run for this trigger key yet and (time.elapsed) the waiting period is still the same. Then:
 *
 * - field changes (group, owner, priority, state with its pending date, added tags) go through
 *   `TicketsService.applyLocked` with the trusted `AUTOMATION` viewer: permission checks pass,
 *   but an inactive group, an owner who can't edit the group or an invalid state change is refused
 *   exactly as for a person (FR-088);
 * - the auto-reply is a public holding message to the customer (automation-message.writer.ts);
 * - notified users get an in-app `automation.rule` entry, only if they can view the ticket.
 *
 * The run is recorded in `automation_runs` (`done`). A refusal rolls the run back and records it as
 * `failed` with the error code; it is not retried. Anything else throws, so the job retries.
 */

@Injectable()
export class AutomationRunJob extends JobProcessor<AutomationRunJobData> {
  readonly queue = 'automation' as const;
  readonly jobName = AUTOMATION_RUN_JOB;
  private readonly logger = new Logger('AutomationRunJob');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly tickets: TicketsService,
    private readonly tags: TagsService,
    private readonly replies: AutomationMessageWriter,
    private readonly notifier: DirectNotifier,
    private readonly policy: PolicyService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(data: AutomationRunJobData, _job?: Job<AutomationRunJobData>): Promise<'done' | 'skipped' | 'failed'> {
    const ctx = TenantContext.create({
      tenantId: data.tenantId,
      actor: { kind: 'automation', id: data.ruleId },
      requestId: `automation:${uuidv7()}`,
      cause: { ruleId: data.ruleId, depth: data.depth, ...(data.eventId === null ? {} : { eventId: data.eventId }) },
    });
    try {
      return await this.unitOfWork.withTenant(ctx, (tx) => this.run(ctx, tx, data));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.unitOfWork.withTenant(ctx, (tx) =>
        new AutomationRulesRepository(ctx).recordRun(tx, { ruleId: data.ruleId, ticketId: data.ticketId, triggerKey: data.triggerKey, status: 'failed', error: error.code }),
      );
      this.logger.warn(`Automation rule ${data.ruleId} refused on ticket ${data.ticketId}: ${error.code}`);
      return 'failed';
    }
  }

  private async run(ctx: TenantContext, tx: TenantTransaction, data: AutomationRunJobData): Promise<'done' | 'skipped'> {
    const rules = new AutomationRulesRepository(ctx);
    const rule = await rules.byId(tx, data.ruleId);
    if (rule?.enabled !== true) return 'skipped';
    if (await rules.hasRun(tx, rule.id, data.ticketId, data.triggerKey)) return 'skipped';

    const ticket = await new TicketsRepository(ctx).lock(tx, data.ticketId);
    if (ticket === undefined) return 'skipped';
    const now = this.clock.now();
    const match = new AutomationMatchRepository(ctx);
    if (!(await match.matches(tx, ticket.id, rule.conditions, now))) return 'skipped';
    if (rule.trigger.event === 'time.elapsed' && rule.trigger.since !== undefined) {
      // A reply or a new message since the sweep started a new waiting period: not due any more.
      if ((await match.currentSinceKey(tx, ticket.id, rule.trigger.since)) !== data.triggerKey) return 'skipped';
    }

    await this.applyFieldChanges(ctx, tx, rule, ticket, now);
    if (rule.actions.autoReply !== undefined) {
      await this.replies.write(tx, { ticketId: ticket.id, body: rule.actions.autoReply, clientMessageId: autoReplyKey(data) });
    }
    if (rule.actions.notifyUserIds !== undefined) await this.notify(ctx, tx, rule, ticket);

    await rules.recordRun(tx, { ruleId: rule.id, ticketId: ticket.id, triggerKey: data.triggerKey, status: 'done' });
    return 'done';
  }

  private async applyFieldChanges(ctx: TenantContext, tx: TenantTransaction, rule: AutomationRuleRow, ticket: TicketRow, now: Date): Promise<void> {
    const { actions } = rule;
    const input: TicketUpdateInput = {};
    if (actions.groupId !== undefined) input.groupId = actions.groupId;
    if (actions.ownerId !== undefined) input.ownerId = actions.ownerId;
    if (actions.priority !== undefined) input.priority = actions.priority;
    if (actions.state !== undefined) {
      input.state = actions.state;
      if (actions.pendingInHours !== undefined) input.pendingUntil = new Date(now.getTime() + actions.pendingInHours * 3_600_000).toISOString();
    }
    if (actions.addTagIds !== undefined) {
      const current = (await this.tags.tagsByTicketIds(tx, [ticket.id])).get(ticket.id) ?? [];
      const merged = [...new Set([...current.map((tag) => tag.id), ...actions.addTagIds])];
      // Tags deleted since the rule was saved are skipped rather than failing the run.
      input.tagIds = await this.existingTags(tx, merged, current.map((tag) => tag.id));
    }
    if (Object.keys(input).length === 0) return;
    await this.tickets.applyLocked(ctx, tx, AUTOMATION, ticket, input);
  }

  private async existingTags(tx: TenantTransaction, ids: readonly string[], kept: readonly string[]): Promise<string[]> {
    const existing: string[] = [];
    for (const id of ids) {
      if (kept.includes(id)) {
        existing.push(id);
        continue;
      }
      try {
        await this.tags.assertTagsExist(tx, [id]);
        existing.push(id);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    return existing;
  }

  /** In-app only, and only to users who can view the ticket now (FR-081). */
  private async notify(ctx: TenantContext, tx: TenantTransaction, rule: AutomationRuleRow, ticket: TicketRow): Promise<void> {
    const recipients: string[] = [];
    for (const userId of rule.actions.notifyUserIds ?? []) {
      const access = await this.policy.effectiveAccessIn(ctx, tx, userId);
      if (decide(access, 'ticket.view', { type: 'ticket', groupId: ticket.group_id }) === 'allow') recipients.push(userId);
    }
    if (recipients.length === 0) return;
    await this.notifier.notify(tx, recipients, {
      eventType: 'automation.rule',
      title: `${rule.name}: #${ticket.number}`.slice(0, 200),
      summary: ticket.title.slice(0, 300),
      eventId: uuidv7(),
      ticketId: ticket.id,
    });
  }
}
