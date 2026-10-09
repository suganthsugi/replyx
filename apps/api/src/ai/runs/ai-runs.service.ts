import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { decodeCursor, toPage, type Page } from '../../platform-kernel/http/pagination.js';

import { AiRunsReadRepository, type AiRunRow, type AiRunsFilter, type AiRunsTotals } from './ai-runs.repository.js';

import type { AiRunsQuery } from './ai-runs.input.js';
import type { AiModelLevel, AiRunOutcome, AiRunPurpose } from '../../platform-kernel/db/tables/ai.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/** `GET /ai/runs` (contracts/ai.yaml `AiRun`, FR-021): tokens, cost and outcome; never message content. */
export interface AiRunDto {
  id: string;
  createdAt: string;
  ticket: { id: string; number: number } | null;
  purpose: AiRunPurpose;
  model: string;
  level: AiModelLevel | null;
  complexityScore: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costEstimated: boolean;
  durationMs: number;
  outcome: AiRunOutcome;
}

export interface AiRunsPage extends Page<AiRunDto> {
  totals: AiRunsTotals;
}

// `createdAt` is the microsecond ISO string the repository produced; anything else is a tampered
// cursor (and would be a cast error in the query).
const Position = z
  .object({ createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.uuid() })
  .strict();

function toAiRunDto(row: AiRunRow): AiRunDto {
  return {
    id: row.id,
    createdAt: row.created_at,
    ticket: row.ticket_id !== null && row.ticket_number !== null ? { id: row.ticket_id, number: Number(row.ticket_number) } : null,
    purpose: row.purpose,
    model: row.model,
    level: row.level,
    complexityScore: row.complexity_score === null ? null : Number(row.complexity_score),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    costEstimated: row.cost_estimated,
    durationMs: row.duration_ms,
    outcome: row.outcome,
  };
}

@Injectable()
export class AiRunsService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  list(ctx: TenantContext, query: AiRunsQuery): Promise<AiRunsPage> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, Position);
    const filter: AiRunsFilter = {
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
    };
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repository = new AiRunsReadRepository(ctx);
      const rows = await repository.list(tx, filter, after, query.limit + 1);
      const totals = await repository.totals(tx, filter);
      return { ...toPage(rows, query.limit, (row) => ({ createdAt: row.created_at, id: row.id }), toAiRunDto), totals };
    });
  }
}
