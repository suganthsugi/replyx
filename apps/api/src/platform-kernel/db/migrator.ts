import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Logger } from '@nestjs/common';
import { FileMigrationProvider, Kysely, Migrator, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * Runs the SQL migrations in `apps/api/migrations/` as `replyx_owner` (DATABASE_URL_OWNER), the
 * schema owner. The API and worker never run migrations and never hold the owner URL.
 *
 * The folder is `../../../migrations` relative to this file: `apps/api/migrations` in development
 * (tsx) and `/app/migrations` (compiled) in the runtime image (apps/api/Dockerfile).
 *
 *   pnpm --filter api migrate                         # development
 *   node dist/platform-kernel/db/migrator.js          # runtime image (`migrate` service)
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

const logger = new Logger('Migrator');

/** Applies every pending migration in name order; throws (after logging) if one fails. */
export async function migrateToLatest(connectionString: string): Promise<void> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 1, application_name: 'replyx-migrate' }),
    }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIR }),
    });
    const { error, results } = await migrator.migrateToLatest();
    for (const result of results ?? []) {
      if (result.status === 'Success') {
        logger.log(`Applied ${result.migrationName}`);
      } else if (result.status === 'Error') {
        logger.error(`Failed ${result.migrationName}`);
      }
    }
    if (error !== undefined) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if ((results ?? []).length === 0) {
      logger.log('No pending migrations');
    }
  } finally {
    await db.destroy();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const url = process.env.DATABASE_URL_OWNER;
  if (url === undefined || url === '') {
    logger.error('DATABASE_URL_OWNER is not set');
    process.exit(1);
  }
  migrateToLatest(url).catch((error: unknown) => {
    // The pg error message never contains the connection string.
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
