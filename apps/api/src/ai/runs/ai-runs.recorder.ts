import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { costOf } from '../providers/catalog.js';
import { ProviderError, type Usage } from '../providers/ports.js';

import type { AiModelLevel, AiRunOutcome, AiRunPurpose } from '../../platform-kernel/db/tables/ai.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/** What a run is for; never message content (FR-021). */
export interface AiRunMeta {
  purpose: AiRunPurpose;
  model: string;
  provider?: string;
  ticketId?: string | null;
  turnId?: string | null;
  level?: AiModelLevel | null;
  complexityScore?: number | null;
}

export interface AiRunInput extends AiRunMeta {
  outcome: AiRunOutcome;
  durationMs: number;
  /** Absent when the call failed before the provider reported usage. */
  usage?: Usage;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: null };

/**
 * Writes one `ai_runs` row per provider call (FR-021): tokens, cost and outcome only. The cost
 * is the provider's figure when it gives one, else an estimate from catalog list prices
 * (`cost_estimated = true`).
 */
@Injectable()
export class AiRunsRecorder {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Records in its own transaction, so a failed call is recorded even when the caller rolls back. */
  async record(ctx: TenantContext, input: AiRunInput): Promise<void> {
    await this.unitOfWork.withTenant(ctx, (tx) => this.recordIn(tx, ctx, input));
  }

  async recordIn(tx: TenantTransaction, ctx: TenantContext, input: AiRunInput): Promise<void> {
    await new AiRunsRepository(ctx).insert(tx, input);
  }

  /**
   * Runs one provider call and records it: `ok` with the call's usage, or the `ProviderError` kind
   * (rethrown). Errors that are not provider errors are rethrown unrecorded: they are bugs, not
   * provider outcomes.
   */
  async track<T extends { usage: Usage }>(ctx: TenantContext, meta: AiRunMeta, call: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let result: T;
    try {
      result = await call();
    } catch (error) {
      if (error instanceof ProviderError) {
        await this.record(ctx, { ...meta, outcome: error.kind, durationMs: elapsed() });
      }
      throw error;
    }
    await this.record(ctx, { ...meta, outcome: 'ok', durationMs: elapsed(), usage: result.usage });
    return result;
  }
}

class AiRunsRepository extends TenantRepository {
  async insert(tx: TenantTransaction, input: AiRunInput): Promise<void> {
    const usage = input.usage ?? NO_USAGE;
    const cost = input.usage === undefined ? { costUsd: null, estimated: false } : costOf(input.model, usage);
    await this.insertInto(tx, 'ai_runs', {
      ticket_id: input.ticketId ?? null,
      turn_id: input.turnId ?? null,
      purpose: input.purpose,
      provider: input.provider ?? 'openrouter',
      model: input.model,
      level: input.level ?? null,
      complexity_score: input.complexityScore ?? null,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: cost.costUsd,
      cost_estimated: cost.estimated,
      duration_ms: input.durationMs,
      outcome: input.outcome,
    }).execute();
  }
}
