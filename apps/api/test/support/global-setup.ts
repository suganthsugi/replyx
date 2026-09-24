import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { migrateToLatest } from '../../src/platform-kernel/db/migrator.js';

import type { TestProject } from 'vitest/node';

/**
 * Throwaway PostgreSQL 17 and Valkey 8 for the whole run (testing-conventions rule 2): the same
 * images as compose.yaml, `infra/postgres/init.sql` through the image's initdb entrypoint (it
 * reads the role passwords with psql `\getenv`), then every migration as `replyx_owner`.
 * Connection URLs reach the test files through `provide`/`inject` (support/env.ts).
 */

const INIT_SQL = fileURLToPath(new URL('../../../../infra/postgres/init.sql', import.meta.url));

const PASSWORDS = {
  REPLYX_OWNER_PASSWORD: 'owner-test',
  REPLYX_APP_PASSWORD: 'app-test',
  REPLYX_PLATFORM_PASSWORD: 'platform-test',
};

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrlOwner: string;
    databaseUrlApp: string;
    databaseUrlPlatform: string;
    redisUrl: string;
  }
}

let postgres: StartedPostgreSqlContainer | undefined;
let valkey: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgres:17')
      .withDatabase('replyx')
      .withCopyFilesToContainer([{ source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql' }])
      .withEnvironment(PASSWORDS)
      .start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);

  const base = `${postgres.getHost()}:${postgres.getPort()}/replyx`;
  const owner = `postgres://replyx_owner:${PASSWORDS.REPLYX_OWNER_PASSWORD}@${base}`;
  await migrateToLatest(owner);

  project.provide('databaseUrlOwner', owner);
  project.provide('databaseUrlApp', `postgres://replyx_app:${PASSWORDS.REPLYX_APP_PASSWORD}@${base}`);
  project.provide('databaseUrlPlatform', `postgres://replyx_platform:${PASSWORDS.REPLYX_PLATFORM_PASSWORD}@${base}`);
  project.provide('redisUrl', `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`);
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), valkey?.stop()]);
}
