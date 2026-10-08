import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { DirectNotifier } from '../../notifications/direct-notifier.js';
import { Clock } from '../../platform-kernel/clock.js';
import { SecretBox } from '../../platform-kernel/crypto/secret-box.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { AiAudience, streamsOf } from '../ai-audience.js';

import { AiSettingsRepository, DEFAULT_SETTINGS, type AiSettingsRow } from './ai-settings.repository.js';

import type { AiPauseReason } from '../../platform-kernel/db/tables/ai.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { ProviderCredentials, ProviderError } from '../providers/ports.js';

const PAUSE_TITLES: Readonly<Record<AiPauseReason, string>> = {
  invalid_key: 'AI paused: the AI provider key was not accepted',
  no_credit: 'AI paused: the AI provider account has no credit left',
};

/** AI is active when it has something to do, a key, and is not paused (data-model.md). */
export function isActive(settings: AiSettingsRow): boolean {
  return (settings.replyMode !== 'off' || settings.routingEnabled) && settings.sealedKey !== null && settings.pausedReason === null;
}

export function pauseReasonFor(error: ProviderError): AiPauseReason | undefined {
  if (error.kind === 'auth') return 'invalid_key';
  if (error.kind === 'credit') return 'no_credit';
  return undefined;
}

/**
 * Whether a tenant's AI may run, its provider credentials, and pausing (specs/002-ai-assist
 * research R10). Pausing happens on the first `auth` or `credit` error and resuming on a good
 * connection test or a key replace; each transition emits `ai.paused`/`ai.resumed` for the admins'
 * banner, `ai.responder_scope_changed` for every open conversation, and is audited. Holders of
 * `ai_settings.manage` get one `ai.paused` notification per pause.
 */
@Injectable()
export class AiStatus {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly secrets: SecretBox,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly audience: AiAudience,
    private readonly notifier: DirectNotifier,
    private readonly clock: Clock,
  ) {}

  async settings(ctx: TenantContext, tx?: TenantTransaction): Promise<AiSettingsRow> {
    const read = (t: TenantTransaction) => new AiSettingsRepository(ctx).find(t);
    return (await (tx === undefined ? this.unitOfWork.withTenantReadOnly(ctx, read) : read(tx))) ?? DEFAULT_SETTINGS;
  }

  async isActive(ctx: TenantContext): Promise<boolean> {
    return isActive(await this.settings(ctx));
  }

  /** The tenant's key, opened only here; undefined when none is saved. */
  credentials(settings: AiSettingsRow): ProviderCredentials | undefined {
    return settings.sealedKey === null ? undefined : { apiKey: this.secrets.open(settings.sealedKey) };
  }

  /** Pauses on an `auth`/`credit` error; other errors change nothing. True when this call paused it. */
  async pauseFor(ctx: TenantContext, error: ProviderError): Promise<boolean> {
    const reason = pauseReasonFor(error);
    if (reason === undefined) return false;
    return this.unitOfWork.withTenant(ctx, (tx) => this.pauseIn(tx, ctx, reason));
  }

  /** Inside the caller's transaction, after it locked the settings row. */
  async pauseIn(tx: TenantTransaction, ctx: TenantContext, reason: AiPauseReason): Promise<boolean> {
    const repo = new AiSettingsRepository(ctx);
    const current = await repo.lock(tx);
    if (current.pausedReason !== null) return false;
    await repo.update(tx, { paused: { reason, at: this.clock.now() } }, undefined, this.clock.now());

    const holders = await this.audience.holderIds(tx, ctx, 'ai_settings.manage');
    const eventId = await this.outbox.append(tx, { type: 'ai.paused', payload: { reason }, streams: streamsOf(holders) });
    await this.notifier.notify(tx, holders, { eventType: 'ai.paused', title: PAUSE_TITLES[reason], summary: 'Fix it in Admin > AI settings.', eventId });
    await this.outbox.append(tx, { type: 'ai.responder_scope_changed', payload: {}, streams: ['tenant'] });
    await this.audit.record(tx, { action: 'ai_settings.paused', resourceType: 'ai_settings', details: { reason } });
    return true;
  }

  /** Clears a pause inside the caller's transaction. True when it was paused. */
  async resumeIn(tx: TenantTransaction, ctx: TenantContext): Promise<boolean> {
    const repo = new AiSettingsRepository(ctx);
    const current = await repo.lock(tx);
    if (current.pausedReason === null) return false;
    await repo.update(tx, { paused: null }, undefined, this.clock.now());

    const streams = await this.audience.streamsFor(tx, ctx, 'ai_settings.manage');
    await this.outbox.append(tx, { type: 'ai.resumed', payload: {}, streams });
    await this.outbox.append(tx, { type: 'ai.responder_scope_changed', payload: {}, streams: ['tenant'] });
    await this.audit.record(tx, { action: 'ai_settings.resumed', resourceType: 'ai_settings', details: { previousReason: current.pausedReason } });
    return true;
  }
}
