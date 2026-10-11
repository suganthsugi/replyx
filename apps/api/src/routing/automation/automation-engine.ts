import { createHash } from 'node:crypto';

import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { compileConditions, type ConditionExpression } from '../../views/view-compiler.js';

import type { AutomationSince } from '../../platform-kernel/db/tables/routing.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import type { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

/**
 * Shared pieces of the automation engine (US17, FR-088, FR-089): rule matching, the run job's
 * payload and how it is queued. The event consumer (automation.consumer.ts) and the time sweeper
 * (automation-sweep.job.ts) only decide which (rule, ticket) pairs to run; every run happens in
 * `AutomationRunJob` (automation-run.job.ts), in its own transaction, as the rule.
 */

export const AUTOMATION_RUN_JOB = 'automation_run';

/** A chain of rules triggering rules stops after this many links (FR-089). */
export const MAX_CHAIN_DEPTH = 3;

export interface AutomationRunJobData {
  tenantId: string;
  ruleId: string;
  ticketId: string;
  /** The domain event id (event triggers) or `since:<ISO timestamp>` (time.elapsed). */
  triggerKey: string;
  /** This run's link in the chain: 1 for a person's or the clock's change, +1 per rule. */
  depth: number;
  /** The event that triggered it, if any. */
  eventId: string | null;
}

/** `owner is me` is refused for rules, so the compiler's viewer is never consulted. */
const NO_VIEWER = '00000000-0000-0000-0000-000000000000';

const SINCE_COLUMNS: Readonly<Record<AutomationSince, 'tickets.created_at' | 'tickets.updated_at' | 'tickets.last_customer_message_at' | 'tickets.last_agent_reply_at'>> = {
  created_at: 'tickets.created_at',
  updated_at: 'tickets.updated_at',
  last_customer_message_at: 'tickets.last_customer_message_at',
  last_agent_reply_at: 'tickets.last_agent_reply_at',
};

export function sinceColumn(since: AutomationSince) {
  return SINCE_COLUMNS[since];
}

export function compiledConditions(conditions: unknown, now: Date): Expression<SqlBool> {
  return conditions === null || conditions === undefined ? sql<SqlBool>`true` : compileConditions(conditions as ConditionExpression, { viewerId: NO_VIEWER, now });
}

/**
 * The time.elapsed trigger key for one waiting period, built in SQL (microsecond precision), so the
 * sweeper and the run compare exactly the same text a JS Date could not round-trip.
 */
function sinceKeySql(column: ReturnType<typeof sinceColumn>) {
  return sql<string>`'since:' || to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** BullMQ refuses `:` in custom job ids; one job per (rule, ticket, trigger key). */
export function runJobId(data: Pick<AutomationRunJobData, 'ruleId' | 'ticketId' | 'triggerKey'>): string {
  const key = createHash('sha256').update(data.triggerKey).digest('hex').slice(0, 16);
  return `automation.${data.ruleId}.${data.ticketId}.${key}`;
}

/** The auto-reply's idempotency key (`client_message_id`, at most 100 characters). */
export function autoReplyKey(data: Pick<AutomationRunJobData, 'ruleId' | 'triggerKey'>): string {
  return `automation-${data.ruleId}-${createHash('sha256').update(data.triggerKey).digest('hex').slice(0, 16)}`;
}

export async function enqueueRun(queues: QueueRegistry, data: AutomationRunJobData): Promise<void> {
  await queues.get('automation').add(AUTOMATION_RUN_JOB, data, { jobId: runJobId(data) });
}

export class AutomationMatchRepository extends TenantRepository {
  /** Whether the ticket matches the rule's conditions right now. */
  async matches(tx: TenantTransaction, ticketId: string, conditions: unknown, now: Date): Promise<boolean> {
    const row = await this.selectFrom(tx, 'tickets').select('tickets.id').where('tickets.id', '=', ticketId).where(compiledConditions(conditions, now)).executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Tickets whose `since` timestamp is at least `after` old, that match the conditions, are not
   * closed and have no run for this waiting period yet: the time sweeper's candidates.
   */
  async dueForTime(
    tx: TenantTransaction,
    rule: { id: string; since: AutomationSince; conditions: unknown },
    cutoff: Date,
    now: Date,
    limit: number,
  ): Promise<{ id: string; triggerKey: string }[]> {
    const column = sinceColumn(rule.since);
    const rows = await this.selectFrom(tx, 'tickets')
      .select(['tickets.id', sinceKeySql(column).as('trigger_key')])
      .where(column, 'is not', null)
      .where(column, '<=', cutoff)
      .where('tickets.state', '<>', 'closed')
      .where(compiledConditions(rule.conditions, now))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('automation_runs')
              .select('automation_runs.id')
              .whereRef('automation_runs.tenant_id', '=', 'tickets.tenant_id')
              .whereRef('automation_runs.ticket_id', '=', 'tickets.id')
              .where('automation_runs.rule_id', '=', rule.id)
              .where(sql<boolean>`automation_runs.trigger_key = ${sinceKeySql(column)}`),
          ),
        ),
      )
      .orderBy('tickets.id')
      .limit(limit)
      .execute();
    return rows.map((row) => ({ id: row.id, triggerKey: row.trigger_key }));
  }

  /** The ticket's current waiting-period key for `since`, or null when the timestamp is unset. */
  async currentSinceKey(tx: TenantTransaction, ticketId: string, since: AutomationSince): Promise<string | null> {
    const column = sinceColumn(since);
    const row = await this.selectFrom(tx, 'tickets').select(sinceKeySql(column).as('trigger_key')).where('tickets.id', '=', ticketId).executeTakeFirst();
    return row?.trigger_key ?? null;
  }
}
