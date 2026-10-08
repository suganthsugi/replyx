import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { AiLevelModels, AiPauseReason, AiReplyMode } from '../../platform-kernel/db/tables/ai.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

export interface AiSettingsRow {
  replyMode: AiReplyMode;
  routingEnabled: boolean;
  routingThreshold: number;
  models: AiLevelModels;
  sealedKey: string | null;
  keyLast4: string | null;
  pausedReason: AiPauseReason | null;
  pausedAt: Date | null;
}

/** What a tenant without a row has (migration 0017 defaults); the row is created on first write. */
export const DEFAULT_SETTINGS: AiSettingsRow = {
  replyMode: 'off',
  routingEnabled: false,
  routingThreshold: 0.7,
  models: {},
  sealedKey: null,
  keyLast4: null,
  pausedReason: null,
  pausedAt: null,
};

export interface AiSettingsChange {
  replyMode?: AiReplyMode;
  routingEnabled?: boolean;
  routingThreshold?: number;
  models?: AiLevelModels;
  key?: { sealed: string; last4: string } | null;
  paused?: { reason: AiPauseReason; at: Date } | null;
}

/** `ai_settings`: one row per tenant, created lazily (data-model.md). */
export class AiSettingsRepository extends TenantRepository {
  async find(tx: TenantTransaction, options: { forUpdate?: boolean } = {}): Promise<AiSettingsRow | undefined> {
    let query = this.selectFrom(tx, 'ai_settings').select([
      'ai_settings.reply_mode',
      'ai_settings.routing_enabled',
      'ai_settings.routing_threshold',
      'ai_settings.models',
      'ai_settings.provider_key_sealed',
      'ai_settings.provider_key_last4',
      'ai_settings.paused_reason',
      'ai_settings.paused_at',
    ]);
    if (options.forUpdate === true) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      replyMode: row.reply_mode,
      routingEnabled: row.routing_enabled,
      routingThreshold: Number(row.routing_threshold),
      models: row.models,
      sealedKey: row.provider_key_sealed,
      keyLast4: row.provider_key_last4,
      pausedReason: row.paused_reason,
      pausedAt: row.paused_at,
    };
  }

  /** The row locked for a change, created with the defaults first when the tenant has none. */
  async lock(tx: TenantTransaction): Promise<AiSettingsRow> {
    await this.insertInto(tx, 'ai_settings', { models: JSON.stringify({}) })
      .onConflict((oc) => oc.column('tenant_id').doNothing())
      .execute();
    const row = await this.find(tx, { forUpdate: true });
    if (row === undefined) throw new Error('ai_settings row missing after insert');
    return row;
  }

  /** `updatedBy` undefined (system changes such as a pause) keeps the last editor. */
  async update(tx: TenantTransaction, change: AiSettingsChange, updatedBy: string | null | undefined, now: Date): Promise<void> {
    await this.updateTable(tx, 'ai_settings')
      .set({
        ...(change.replyMode === undefined ? {} : { reply_mode: change.replyMode }),
        ...(change.routingEnabled === undefined ? {} : { routing_enabled: change.routingEnabled }),
        ...(change.routingThreshold === undefined ? {} : { routing_threshold: change.routingThreshold }),
        ...(change.models === undefined ? {} : { models: JSON.stringify(change.models) }),
        ...(change.key === undefined
          ? {}
          : { provider_key_sealed: change.key?.sealed ?? null, provider_key_last4: change.key?.last4 ?? null }),
        ...(change.paused === undefined ? {} : { paused_reason: change.paused?.reason ?? null, paused_at: change.paused?.at ?? null }),
        ...(updatedBy === undefined ? {} : { updated_by: updatedBy }),
        updated_at: now,
      })
      .execute();
  }
}
