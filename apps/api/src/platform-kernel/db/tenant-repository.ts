import {
  sql,
  type DeleteQueryBuilder,
  type DeleteResult,
  type Insertable,
  type SelectQueryBuilder,
  type UpdateQueryBuilder,
  type UpdateResult,
} from 'kysely';

import { TenantContext } from './tenant-context.js';
import { tenantScopeOf, type TenantTransaction } from './unit-of-work.js';

import type { Database } from './database.js';

/** Tables whose row type has a `tenant_id` column. Global tables are not tenant tables. */
export type TenantTableName = Extract<
  { [K in keyof Database]: Database[K] extends { tenant_id: unknown } ? K : never }[keyof Database],
  string
>;

/** Insert shape without `tenant_id`: the repository always sets it from the context. */
export type TenantInsert<T extends TenantTableName> = Omit<Insertable<Database[T]>, 'tenant_id'>;

/**
 * Base class for every repository over tenant-owned tables (research D3, application layer).
 * It cannot be built without a `TenantContext`, and every helper adds
 * `<table>.tenant_id = :tenantId` (reads, updates, deletes) or sets `tenant_id` (inserts), so
 * RLS is only the backstop. Pass plain table names; alias in the subclass query if needed.
 */
export abstract class TenantRepository {
  protected readonly ctx: TenantContext;

  constructor(ctx: TenantContext) {
    if (!TenantContext.isTenantContext(ctx)) {
      throw new TypeError(`${new.target.name} requires a TenantContext`);
    }
    this.ctx = ctx;
  }

  // With a generic table name Kysely infers a union of builders; the casts pin the single
  // concrete builder type that the same call has for a literal table name.
  protected selectFrom<T extends TenantTableName>(
    tx: TenantTransaction,
    table: T,
  ): SelectQueryBuilder<Database, T, Record<never, never>> {
    const query = this.checked(tx).selectFrom(table) as unknown as SelectQueryBuilder<
      Database,
      T,
      Record<never, never>
    >;
    return query.where(this.tenantFilter(table));
  }

  protected updateTable<T extends TenantTableName>(
    tx: TenantTransaction,
    table: T,
  ): UpdateQueryBuilder<Database, T, T, UpdateResult> {
    const query = this.checked(tx).updateTable(table) as unknown as UpdateQueryBuilder<
      Database,
      T,
      T,
      UpdateResult
    >;
    return query.where(this.tenantFilter(table));
  }

  protected deleteFrom<T extends TenantTableName>(
    tx: TenantTransaction,
    table: T,
  ): DeleteQueryBuilder<Database, T, DeleteResult> {
    const query = this.checked(tx).deleteFrom(table) as unknown as DeleteQueryBuilder<
      Database,
      T,
      DeleteResult
    >;
    return query.where(this.tenantFilter(table));
  }

  /** Any `tenant_id` on the input (for example spread from a DTO) is overwritten. */
  protected insertInto<T extends TenantTableName>(
    tx: TenantTransaction,
    table: T,
    values: TenantInsert<T> | readonly TenantInsert<T>[],
  ) {
    const rows = (Array.isArray(values) ? values : [values]).map((row) => ({
      ...(row as TenantInsert<T>),
      tenant_id: this.ctx.tenantId,
    })) as unknown as Insertable<Database[T]>[];
    return this.checked(tx).insertInto(table).values(rows);
  }

  private tenantFilter(table: TenantTableName) {
    return sql<boolean>`${sql.id(table, 'tenant_id')} = ${this.ctx.tenantId}`;
  }

  /** A loud error instead of a silent empty result when the transaction is not this tenant's. */
  private checked(tx: TenantTransaction): TenantTransaction {
    const scope = tenantScopeOf(tx);
    if (scope === undefined) {
      throw new Error('Repository used outside withTenant/withTenantReadOnly');
    }
    if (scope.tenantId !== this.ctx.tenantId) {
      throw new Error('Repository and transaction belong to different tenants');
    }
    return tx;
  }
}
