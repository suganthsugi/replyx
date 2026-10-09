import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { last4, SecretBox } from '../../platform-kernel/crypto/secret-box.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { conflict, validationFailed, type ErrorDetail } from '../../platform-kernel/http/app-error.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { ComplexityRepository } from '../complexity/complexity.repository.js';
import { DECISION_MODEL, DEFAULT_LEVEL_MODELS, isSelectableModel, LEVEL_MODELS, MODEL_LEVELS, modelForLevel } from '../providers/catalog.js';
import { AI_PROVIDER, ProviderError, type AiProvider, type ProviderErrorKind } from '../providers/ports.js';
import { AiRunsRecorder } from '../runs/ai-runs.recorder.js';

import { AiSettingsRepository, type AiSettingsChange, type AiSettingsRow } from './ai-settings.repository.js';
import { AiStatus, isActive, pauseReasonFor } from './ai-status.js';

import type { AiSettingsPatch, ProviderKeyInput } from './ai-settings.input.js';
import type { AiLevelModels, AiModelLevel, AiPauseReason, AiProviderName, AiReplyMode } from '../../platform-kernel/db/tables/ai.js';
import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

export interface AiSettingsDto {
  replyMode: AiReplyMode;
  routingEnabled: boolean;
  routingThreshold: number;
  models: Record<AiModelLevel, string>;
  provider: AiProviderName;
  providerKey: { last4: string } | null;
  paused: { reason: AiPauseReason; since: string } | null;
}

export type ConnectionTestError = 'invalid_key' | 'no_credit' | 'unreachable' | 'timeout' | 'unexpected_response';

export interface ConnectionTestDto {
  ok: boolean;
  error?: ConnectionTestError;
  detail: string;
  creditRemainingUsd?: number | null;
}

export interface ModelOptionDto {
  id: string;
  label: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  isDefault: boolean;
}

export interface AiModelsDto {
  decisionModel: string;
  levels: Record<AiModelLevel, ModelOptionDto[]>;
}

/** `model` of the `ai_runs` row for a key check, which calls no model. */
const KEY_CHECK_MODEL = 'openrouter/key';

const TEST_ERRORS: Readonly<Record<ProviderErrorKind, { error: ConnectionTestError; detail: string }>> = {
  auth: { error: 'invalid_key', detail: 'OpenRouter did not accept this key. Check that you copied all of it, or create a new key.' },
  credit: { error: 'no_credit', detail: 'The OpenRouter account has no credit left. Add credit, then test again.' },
  rate_limit: { error: 'unreachable', detail: 'OpenRouter is busy right now. Try again in a minute.' },
  unavailable: { error: 'unreachable', detail: "Couldn't reach OpenRouter. Try again in a minute." },
  timeout: { error: 'timeout', detail: 'OpenRouter did not answer in time. Try again in a minute.' },
  bad_request: { error: 'unexpected_response', detail: 'OpenRouter sent an answer ReplyX did not expect. Try again later.' },
};

export function toSettingsDto(row: AiSettingsRow): AiSettingsDto {
  return {
    replyMode: row.replyMode,
    routingEnabled: row.routingEnabled,
    routingThreshold: row.routingThreshold,
    models: Object.fromEntries(MODEL_LEVELS.map((level) => [level, modelForLevel(row.models, level)])) as Record<AiModelLevel, string>,
    provider: 'openrouter',
    providerKey: row.keyLast4 === null ? null : { last4: row.keyLast4 },
    paused: row.pausedReason === null || row.pausedAt === null ? null : { reason: row.pausedReason, since: row.pausedAt.toISOString() },
  };
}

export function modelCatalog(): AiModelsDto {
  const levels = Object.fromEntries(
    MODEL_LEVELS.map((level) => [level, LEVEL_MODELS[level].map((option) => ({ ...option, isDefault: option.id === DEFAULT_LEVEL_MODELS[level] }))]),
  ) as Record<AiModelLevel, ModelOptionDto[]>;
  return { decisionModel: DECISION_MODEL.id, levels };
}

/**
 * `/ai/settings*` and `/ai/models` (contracts/ai.yaml, FR-001 to FR-005). The key is write-only:
 * it is sealed before it is stored and only `last4` is ever returned, logged or audited.
 */
@Injectable()
export class AiSettingsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly status: AiStatus,
    private readonly secrets: SecretBox,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly runs: AiRunsRecorder,
    private readonly clock: Clock,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async get(ctx: TenantContext): Promise<AiSettingsDto> {
    return toSettingsDto(await this.status.settings(ctx));
  }

  async update(ctx: TenantContext, patch: AiSettingsPatch): Promise<AiSettingsDto> {
    const problems: ErrorDetail[] = [];
    for (const level of MODEL_LEVELS) {
      const model = patch.models?.[level];
      if (model !== undefined && !isSelectableModel(level, model)) problems.push({ path: `models.${level}`, issue: 'invalid_model' });
    }
    if (problems.length > 0) throw validationFailed(problems);

    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiSettingsRepository(ctx);
      const before = await repo.lock(tx);
      const change: AiSettingsChange = {};
      const changed: Record<string, JsonValue> = {};
      if (patch.replyMode !== undefined && patch.replyMode !== before.replyMode) change.replyMode = changed.replyMode = patch.replyMode;
      if (patch.routingEnabled !== undefined && patch.routingEnabled !== before.routingEnabled) {
        change.routingEnabled = changed.routingEnabled = patch.routingEnabled;
      }
      if (patch.routingThreshold !== undefined && patch.routingThreshold !== before.routingThreshold) {
        change.routingThreshold = changed.routingThreshold = patch.routingThreshold;
      }
      if (patch.models !== undefined) {
        const models: AiLevelModels = { ...before.models, ...patch.models };
        if (MODEL_LEVELS.some((level) => models[level] !== before.models[level])) {
          change.models = models;
          changed.models = { ...models };
        }
      }
      if (Object.keys(change).length === 0) return toSettingsDto(before);

      await repo.update(tx, change, this.editorOf(ctx), this.clock.now());
      const after = { ...before, ...change, models: change.models ?? before.models } as AiSettingsRow;
      // First switched on (a reply mode or routing): a tenant that never set complexity factors gets the defaults (R12).
      const switchedOn = (before.replyMode === 'off' && after.replyMode !== 'off') || (!before.routingEnabled && after.routingEnabled);
      if (switchedOn) await new ComplexityRepository(ctx).seedDefaults(tx);
      if (change.replyMode !== undefined || isActive(after) !== isActive(before)) {
        await this.outbox.append(tx, { type: 'ai.responder_scope_changed', payload: {}, streams: ['tenant'] });
      }
      await this.audit.record(tx, { action: 'ai_settings.updated', resourceType: 'ai_settings', details: changed });
      return toSettingsDto(after);
    });
  }

  /** Saves or replaces the key; a replace clears a pause (research R10). */
  async setKey(ctx: TenantContext, input: ProviderKeyInput): Promise<AiSettingsDto> {
    const key = { sealed: this.secrets.seal(input.apiKey), last4: last4(input.apiKey) };
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiSettingsRepository(ctx);
      const before = await repo.lock(tx);
      await repo.update(tx, { key }, this.editorOf(ctx), this.clock.now());
      await this.audit.record(tx, {
        action: 'ai_settings.key_saved',
        resourceType: 'ai_settings',
        details: { last4: key.last4, replaced: before.keyLast4 !== null },
      });
      const resumed = await this.status.resumeIn(tx, ctx);
      const after: AiSettingsRow = { ...before, sealedKey: key.sealed, keyLast4: key.last4, ...(resumed ? { pausedReason: null, pausedAt: null } : {}) };
      if (!resumed && isActive(after) !== isActive(before)) {
        await this.outbox.append(tx, { type: 'ai.responder_scope_changed', payload: {}, streams: ['tenant'] });
      }
      return toSettingsDto(after);
    });
  }

  /** Removes the key, which stops AI; a pause about that key no longer applies. */
  async removeKey(ctx: TenantContext): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiSettingsRepository(ctx);
      const before = await repo.lock(tx);
      if (before.keyLast4 === null) return;
      // A pause about this key no longer applies: resume first, so open banners clear too.
      await this.status.resumeIn(tx, ctx);
      await repo.update(tx, { key: null }, this.editorOf(ctx), this.clock.now());
      await this.audit.record(tx, { action: 'ai_settings.key_removed', resourceType: 'ai_settings', details: { last4: before.keyLast4 } });
      if (isActive(before)) await this.outbox.append(tx, { type: 'ai.responder_scope_changed', payload: {}, streams: ['tenant'] });
    });
  }

  /**
   * Checks the saved key with the provider. A good answer clears a pause; `auth`/`credit` pause AI
   * as any other call would, but only while the tested key is still the saved one: a key replaced
   * or removed during the check keeps its own state. The check is recorded as an `ai_runs` row.
   */
  async testKey(ctx: TenantContext): Promise<ConnectionTestDto> {
    const settings = await this.status.settings(ctx);
    const credentials = this.status.credentials(settings);
    if (credentials === undefined) throw conflict('AI_KEY_MISSING', 'Save an AI provider key first');

    const started = performance.now();
    let result: ConnectionTestDto;
    let failure: ProviderError | undefined;
    try {
      const info = await this.provider.checkKey(credentials);
      result = { ok: true, detail: 'Connected to OpenRouter.', creditRemainingUsd: info.limitRemainingUsd };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      failure = error;
      result = { ok: false, ...TEST_ERRORS[error.kind] };
    }
    const durationMs = Math.round(performance.now() - started);

    await this.unitOfWork.withTenant(ctx, async (tx) => {
      await this.runs.recordIn(tx, ctx, { purpose: 'connection_test', model: KEY_CHECK_MODEL, outcome: failure?.kind ?? 'ok', durationMs });
      await this.audit.record(tx, {
        action: 'ai_settings.key_tested',
        resourceType: 'ai_settings',
        details: { ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) },
      });
      const current = await new AiSettingsRepository(ctx).lock(tx);
      if (current.sealedKey !== settings.sealedKey) return;
      if (failure === undefined) {
        await this.status.resumeIn(tx, ctx);
      } else {
        const reason = pauseReasonFor(failure);
        if (reason !== undefined) await this.status.pauseIn(tx, ctx, reason);
      }
    });
    return result;
  }

  private editorOf(ctx: TenantContext): string | null {
    return ctx.actor.kind === 'user' ? ctx.actor.id : null;
  }
}
