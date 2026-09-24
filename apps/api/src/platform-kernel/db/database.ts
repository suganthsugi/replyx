import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { UnitOfWork } from './unit-of-work.js';

import type { IdentityTables } from './tables/identity.js';
import type { TenancyTables } from './tables/tenancy.js';

/**
 * Kysely table map. Each migration that adds tables also adds their row types under `tables/`
 * and adds them to this intersection (tenant-owned tables include `tenant_id: string`).
 */
export type Database = TenancyTables & IdentityTables;

export type DB = Database;

/**
 * `replyx_app` pool (NOBYPASSRLS, DML only). Kernel-internal: modules get query handles only from
 * `UnitOfWork.withTenant` / `withTenantReadOnly`, never from this instance directly.
 */
export const APP_DB = Symbol('APP_DB');

/** `replyx_platform` pool: global tables only (tenants, platform_operators, permission_definitions). */
export const PLATFORM_DB = Symbol('PLATFORM_DB');

type PoolName = 'app' | 'platform';

const logger = new Logger('Database');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** Pools connect lazily, so creating one does not need the database to be up. */
export function createDatabase(connectionString: string, name: PoolName): Kysely<Database> {
  const pool = new pg.Pool({ connectionString, application_name: `replyx-${name}` });
  // An idle client error (for example a server restart) is emitted on the pool; without a
  // listener it would crash the process. The message never contains the connection string.
  pool.on('error', (error) => {
    logger.error(`Idle ${name} database client error: ${error.message}`);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

@Global()
@Module({
  providers: [
    { provide: APP_DB, useFactory: () => createDatabase(requireEnv('DATABASE_URL_APP'), 'app') },
    {
      provide: PLATFORM_DB,
      useFactory: () => createDatabase(requireEnv('DATABASE_URL_PLATFORM'), 'platform'),
    },
    { provide: UnitOfWork, useFactory: (db: Kysely<Database>) => new UnitOfWork(db), inject: [APP_DB] },
  ],
  exports: [UnitOfWork, PLATFORM_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(APP_DB) private readonly appDb: Kysely<Database>,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {}

  /** Runs after every other module's destroy hooks, so in-flight work has stopped first. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.appDb.destroy(), this.platformDb.destroy()]);
  }
}
