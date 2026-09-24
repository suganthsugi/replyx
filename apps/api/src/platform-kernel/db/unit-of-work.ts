import { sql, type Kysely, type Transaction } from 'kysely';

import { TenantContext } from './tenant-context.js';

import type { Database } from './database.js';

declare const tenantScoped: unique symbol;

/**
 * A transaction opened by `UnitOfWork` with `app.tenant_id` and `app.request_id` set. Only
 * `withTenant` / `withTenantReadOnly` produce one; repositories accept nothing else.
 */
export type TenantTransaction = Transaction<Database> & { readonly [tenantScoped]: true };

// Which context each live tenant transaction was opened for. Repositories check it so a
// repository built for one tenant cannot run inside another tenant's transaction.
const scopes = new WeakMap<Transaction<Database>, TenantContext>();

/** The context a tenant transaction was opened with, or undefined for any other handle. */
export function tenantScopeOf(tx: Transaction<Database>): TenantContext | undefined {
  return scopes.get(tx);
}

/**
 * The only way to get a query handle for tenant data (research D3). Each call is one database
 * transaction on the `replyx_app` pool with the tenant setting applied via `SET LOCAL`, so RLS
 * sees it and it ends with the transaction (safe on pooled connections).
 */
export class UnitOfWork {
  constructor(private readonly db: Kysely<Database>) {}

  withTenant<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.run(ctx, false, fn);
  }

  /** For pure reads and operator support-access reads: the database rejects any write. */
  withTenantReadOnly<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.run(ctx, true, fn);
  }

  private run<T>(
    ctx: TenantContext,
    readOnly: boolean,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (!TenantContext.isTenantContext(ctx)) {
      throw new TypeError('withTenant requires a TenantContext');
    }
    return this.db
      .transaction()
      .execute(async (trx) => {
        if (readOnly) {
          // Must be the first statement of the transaction.
          await sql`SET TRANSACTION READ ONLY`.execute(trx);
        }
        // set_config(..., true) is SET LOCAL with bind parameters: no string-built SQL.
        await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true),
                         set_config('app.request_id', ${ctx.requestId}, true)`.execute(trx);
        scopes.set(trx, ctx);
        try {
          return await fn(trx as TenantTransaction);
        } finally {
          scopes.delete(trx);
        }
      });
  }
}
