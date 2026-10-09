import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { StoreKind } from '../../platform-kernel/db/tables/ai.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

export interface StoreConnectionRow {
  kind: StoreKind;
  baseUrl: string;
  sealedKey: string;
  keyLast4: string;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export interface StoreConnectionChange {
  kind: StoreKind;
  baseUrl: string;
  /** Undefined keeps the saved key. */
  key?: { sealed: string; last4: string };
}

/** `ai_store_connections`: at most one row per tenant (data-model.md). */
export class StoreConnectionRepository extends TenantRepository {
  async find(tx: TenantTransaction, options: { forUpdate?: boolean } = {}): Promise<StoreConnectionRow | undefined> {
    let query = this.selectFrom(tx, 'ai_store_connections').select([
      'ai_store_connections.kind',
      'ai_store_connections.base_url',
      'ai_store_connections.api_key_sealed',
      'ai_store_connections.api_key_last4',
      'ai_store_connections.last_test_at',
      'ai_store_connections.last_test_ok',
      'ai_store_connections.last_test_error',
    ]);
    if (options.forUpdate === true) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      kind: row.kind,
      baseUrl: row.base_url,
      sealedKey: row.api_key_sealed,
      keyLast4: row.api_key_last4,
      lastTestAt: row.last_test_at,
      lastTestOk: row.last_test_ok,
      lastTestError: row.last_test_error,
    };
  }

  /** Creates or replaces the connection (a new key is required by the caller when none exists); a change clears the last test. */
  async save(tx: TenantTransaction, change: StoreConnectionChange & { key: { sealed: string; last4: string } }, now: Date): Promise<void> {
    const values = {
      kind: change.kind,
      base_url: change.baseUrl,
      api_key_sealed: change.key.sealed,
      api_key_last4: change.key.last4,
      last_test_at: null,
      last_test_ok: null,
      last_test_error: null,
      updated_at: now,
    };
    await this.insertInto(tx, 'ai_store_connections', values)
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet(values))
      .execute();
  }

  /** Changes the address (and key, when given) of the existing connection and clears the last test. */
  async update(tx: TenantTransaction, change: StoreConnectionChange, now: Date): Promise<void> {
    await this.updateTable(tx, 'ai_store_connections')
      .set({
        kind: change.kind,
        base_url: change.baseUrl,
        ...(change.key === undefined ? {} : { api_key_sealed: change.key.sealed, api_key_last4: change.key.last4 }),
        last_test_at: null,
        last_test_ok: null,
        last_test_error: null,
        updated_at: now,
      })
      .execute();
  }

  async recordTest(tx: TenantTransaction, result: { ok: boolean; error: string | null }, now: Date): Promise<void> {
    await this.updateTable(tx, 'ai_store_connections')
      .set({ last_test_at: now, last_test_ok: result.ok, last_test_error: result.error, updated_at: now })
      .execute();
  }

  async remove(tx: TenantTransaction): Promise<void> {
    await this.deleteFrom(tx, 'ai_store_connections').execute();
  }
}
