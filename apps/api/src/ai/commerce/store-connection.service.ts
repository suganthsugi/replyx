import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { last4, SecretBox } from '../../platform-kernel/crypto/secret-box.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { AppError, notFound, validationFailed } from '../../platform-kernel/http/app-error.js';
import { checkOutboundUrl, OutboundRefusedError, type OutboundRefusal } from '../../platform-kernel/http/outbound-guard.js';

import { COMMERCE_CONNECTOR, CommerceError, type CommerceConnector, type CommerceCredentials, type CommerceErrorKind } from './ports.js';
import { StoreConnectionRepository, type StoreConnectionRow } from './store-connection.repository.js';

import type { StoreConnectionInput } from './store-connection.input.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

export interface StoreConnectionDto {
  kind: 'spree';
  baseUrl: string;
  apiKey: { last4: string };
  lastTest: { at: string; ok: boolean; error?: string } | null;
}

export type StoreTestError = 'invalid_key' | 'unreachable' | 'timeout' | 'not_allowed' | 'unexpected_response';

export interface StoreTestDto {
  ok: boolean;
  error?: StoreTestError;
  detail: string;
}

const TEST_ERRORS: Readonly<Record<CommerceErrorKind, { error: StoreTestError; detail: string }>> = {
  auth: {
    error: 'invalid_key',
    detail: 'The store did not accept this key. Check that you copied all of it and that it is a secret key that can read orders.',
  },
  not_allowed: { error: 'not_allowed', detail: 'ReplyX is not allowed to connect to this address. Use the public https address of your store.' },
  rate_limit: { error: 'unreachable', detail: 'The store is busy right now. Try again in a minute.' },
  unavailable: { error: 'unreachable', detail: "Couldn't reach the store. Check the address and try again." },
  timeout: { error: 'timeout', detail: 'The store did not answer in time. Try again in a minute.' },
  bad_response: {
    error: 'unexpected_response',
    detail: 'The address answered, but not like a Spree 5.5 store. Check the store address and that Spree is version 5.5 or later.',
  },
};

const URL_MESSAGES: Readonly<Record<OutboundRefusal, string>> = {
  invalid_url: 'Enter the full store address, for example https://shop.example.com',
  not_https: 'The store address must start with https://',
  private_address: 'This address points to a private network and cannot be used',
  unresolvable: 'This address could not be found',
};

/** The address as stored: past the outbound guard, without query, fragment or trailing slash. */
export function normalizeStoreUrl(raw: string): string {
  let url: URL;
  try {
    url = checkOutboundUrl(raw);
  } catch (error) {
    if (!(error instanceof OutboundRefusedError)) throw error;
    throw new AppError('STORE_URL_NOT_ALLOWED', 400, URL_MESSAGES[error.reason], [{ path: 'baseUrl', issue: error.reason }]);
  }
  url.search = '';
  url.hash = '';
  const normalized = url.toString().replace(/\/+$/, '');
  if (normalized.length > 300) throw validationFailed([{ path: 'baseUrl', issue: 'too_long' }]);
  return normalized;
}

export function toStoreConnectionDto(row: StoreConnectionRow): StoreConnectionDto {
  return {
    kind: row.kind,
    baseUrl: row.baseUrl,
    apiKey: { last4: row.keyLast4 },
    lastTest:
      row.lastTestAt === null || row.lastTestOk === null
        ? null
        : { at: row.lastTestAt.toISOString(), ok: row.lastTestOk, ...(row.lastTestError === null ? {} : { error: row.lastTestError }) },
  };
}

/**
 * `/ai/store-connection*` (contracts/ai.yaml, FR-017): the tenant's store, at most one. The key is
 * write-only: sealed before it is stored, and only `last4` is ever returned, logged or audited.
 */
@Injectable()
export class StoreConnectionService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(COMMERCE_CONNECTOR) private readonly connector: CommerceConnector,
  ) {}

  async get(ctx: TenantContext): Promise<StoreConnectionDto> {
    const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new StoreConnectionRepository(ctx).find(tx));
    if (row === undefined) throw notFound('store_connection');
    return toStoreConnectionDto(row);
  }

  /** The tenant's store credentials, opened only here; undefined when no store is connected. */
  async credentials(ctx: TenantContext): Promise<CommerceCredentials | undefined> {
    const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new StoreConnectionRepository(ctx).find(tx));
    return row === undefined ? undefined : { baseUrl: row.baseUrl, apiKey: this.secrets.open(row.sealedKey) };
  }

  async put(ctx: TenantContext, input: StoreConnectionInput): Promise<StoreConnectionDto> {
    const baseUrl = normalizeStoreUrl(input.baseUrl);
    const key = input.apiKey === undefined ? undefined : { sealed: this.secrets.seal(input.apiKey), last4: last4(input.apiKey) };

    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new StoreConnectionRepository(ctx);
      const before = await repo.find(tx, { forUpdate: true });
      const now = this.clock.now();
      if (before === undefined) {
        if (key === undefined) throw validationFailed([{ path: 'apiKey', issue: 'required' }]);
        await repo.save(tx, { kind: input.kind, baseUrl, key }, now);
      } else {
        // The saved key must not follow the address to another host: a new origin needs the key again.
        if (key === undefined && new URL(before.baseUrl).origin !== new URL(baseUrl).origin) {
          throw new AppError('VALIDATION_FAILED', 400, 'Enter the key again when you change the store address.', [{ path: 'apiKey', issue: 'required' }]);
        }
        await repo.update(tx, { kind: input.kind, baseUrl, key }, now);
      }
      await this.audit.record(tx, {
        action: 'ai_store_connection.saved',
        resourceType: 'ai_store_connection',
        details: {
          kind: input.kind,
          baseUrl,
          created: before === undefined,
          addressChanged: before !== undefined && before.baseUrl !== baseUrl,
          ...(key === undefined ? {} : { last4: key.last4 }),
        },
      });
      const after = await repo.find(tx);
      if (after === undefined) throw new Error('ai_store_connections row missing after save');
      return toStoreConnectionDto(after);
    });
  }

  async remove(ctx: TenantContext): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new StoreConnectionRepository(ctx);
      const before = await repo.find(tx, { forUpdate: true });
      if (before === undefined) return;
      await repo.remove(tx);
      await this.audit.record(tx, {
        action: 'ai_store_connection.removed',
        resourceType: 'ai_store_connection',
        details: { kind: before.kind, baseUrl: before.baseUrl, last4: before.keyLast4 },
      });
    });
  }

  /**
   * Checks the saved connection against the store. The result is kept on the row as the last test,
   * but only while the tested address and key are still the saved ones: a connection replaced during
   * the check keeps its own (cleared) state.
   */
  async test(ctx: TenantContext): Promise<StoreTestDto> {
    const saved = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new StoreConnectionRepository(ctx).find(tx));
    if (saved === undefined) throw notFound('store_connection');

    let result: StoreTestDto;
    try {
      await this.connector.test({ baseUrl: saved.baseUrl, apiKey: this.secrets.open(saved.sealedKey) });
      result = { ok: true, detail: 'Connected to the store.' };
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      result = { ok: false, ...TEST_ERRORS[error.kind] };
    }

    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new StoreConnectionRepository(ctx);
      const current = await repo.find(tx, { forUpdate: true });
      await this.audit.record(tx, {
        action: 'ai_store_connection.tested',
        resourceType: 'ai_store_connection',
        details: { ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) },
      });
      if (current === undefined || current.sealedKey !== saved.sealedKey || current.baseUrl !== saved.baseUrl) return;
      await repo.recordTest(tx, { ok: result.ok, error: result.error ?? null }, this.clock.now());
    });
    return result;
  }
}
