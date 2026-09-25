import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, inject } from 'vitest';

import { closeTestApps } from './app.js';

/**
 * Runs before every test file. Points the app at the throwaway containers from global-setup:
 * the `tools` service loads the dev `.env`, and tests must never reach the dev postgres/valkey
 * (testing-conventions rule 1).
 */
Object.assign(process.env, {
  DATABASE_URL_OWNER: inject('databaseUrlOwner'),
  DATABASE_URL_APP: inject('databaseUrlApp'),
  DATABASE_URL_PLATFORM: inject('databaseUrlPlatform'),
  REDIS_URL: inject('redisUrl'),
  BASE_DOMAIN: 'localhost',
  CONSOLE_HOST: 'console.localhost',
  METRICS_PORT: '0',
  FILES_DIR: mkdtempSync(join(tmpdir(), 'replyx-files-')),
  // Mail is only enqueued in tests; nothing connects to SMTP unless a test runs the worker.
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2525',
  SMTP_FROM: 'support@example.test',
  OPERATOR_BOOTSTRAP_EMAIL: 'operator@example.test',
  OPERATOR_BOOTSTRAP_PASSWORD: 'operator-password',
  // Signs operator support tokens; tests must not depend on the developer's own .env.
  SESSION_SECRET: 'test-session-secret',
});

afterAll(closeTestApps);
