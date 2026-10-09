import { sql } from 'kysely';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { AiModelLevel, AiRunOutcome, AiRunPurpose } from '../../platform-kernel/db/tables/ai.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

export interface AiRunRow {
  id: string;
  /** ISO 8601 UTC with microseconds, straight from Postgres so the cursor loses no precision. */
  created_at: string;
  ticket_id: string | null;
  ticket_number: string | null;
  purpose: AiRunPurpose;
  model: string;
  level: AiModelLevel | null;
  complexity_score: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | null;
  cost_estimated: boolean;
  duration_ms: number;
  outcome: AiRunOutcome;
}

export interface AiRunsFilter {
  from?: Date;
  to?: Date;
  purpose?: AiRunPurpose;
}

export interface AiRunsTotals {
  runs: number;
  costUsd: number;
}

/** Read side of `ai_runs` (the write side is `AiRunsRecorder`). Every query is tenant-scoped. */
export class AiRunsReadRepository extends TenantRepository {
  list(
    tx: TenantTransaction,
    filter: AiRunsFilter,
    after: { createdAt: string; id: string } | undefined,
    limit: number,
  ): Promise<AiRunRow[]> {
    let query = this.selectFrom(tx, 'ai_runs')
      .leftJoin('tickets', (join) =>
        join.onRef('tickets.tenant_id', '=', 'ai_runs.tenant_id').onRef('tickets.id', '=', 'ai_runs.ticket_id'),
      )
      .select([
        'ai_runs.id',
        'ai_runs.ticket_id',
        'tickets.number as ticket_number',
        'ai_runs.purpose',
        'ai_runs.model',
        'ai_runs.level',
        'ai_runs.complexity_score',
        'ai_runs.input_tokens',
        'ai_runs.output_tokens',
        'ai_runs.cost_usd',
        'ai_runs.cost_estimated',
        'ai_runs.duration_ms',
        'ai_runs.outcome',
        sql<string>`to_char(ai_runs.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('created_at'),
      ]);
    if (filter.from !== undefined) query = query.where('ai_runs.created_at', '>=', filter.from);
    if (filter.to !== undefined) query = query.where('ai_runs.created_at', '<=', filter.to);
    if (filter.purpose !== undefined) query = query.where('ai_runs.purpose', '=', filter.purpose);
    if (after !== undefined) {
      query = query.where(sql<boolean>`(ai_runs.created_at, ai_runs.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    }
    return query.orderBy('ai_runs.created_at', 'desc').orderBy('ai_runs.id', 'desc').limit(limit).execute();
  }

  /** Over everything the filter matches, not just one page. */
  async totals(tx: TenantTransaction, filter: AiRunsFilter): Promise<AiRunsTotals> {
    let query = this.selectFrom(tx, 'ai_runs').select([
      sql<string>`count(*)::text`.as('runs'),
      sql<string>`coalesce(sum(ai_runs.cost_usd), 0)::text`.as('cost_usd'),
    ]);
    if (filter.from !== undefined) query = query.where('ai_runs.created_at', '>=', filter.from);
    if (filter.to !== undefined) query = query.where('ai_runs.created_at', '<=', filter.to);
    if (filter.purpose !== undefined) query = query.where('ai_runs.purpose', '=', filter.purpose);
    const row = await query.executeTakeFirstOrThrow();
    return { runs: Number(row.runs), costUsd: Number(row.cost_usd) };
  }
}
