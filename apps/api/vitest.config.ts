import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Testcontainers (PostgreSQL + Valkey, init.sql, migrations) for the whole run, and a per-file
// setup that points the app at them (test/support/).
const globalSetupFile = fileURLToPath(new URL('./test/support/global-setup.ts', import.meta.url));
const envSetupFile = fileURLToPath(new URL('./test/support/env.ts', import.meta.url));

export default defineConfig({
  // esbuild does not emit decorator metadata, which Nest's DI needs; SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    // The dev image sets NODE_ENV=development; tests must not inherit it.
    env: { NODE_ENV: 'test' },
    include: ['test/**/*.test.ts'],
    globalSetup: existsSync(globalSetupFile) ? [globalSetupFile] : [],
    setupFiles: existsSync(envSetupFile) ? [envSetupFile] : [],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.api.ts', 'src/main.worker.ts'],
      reportsDirectory: 'coverage',
    },
  },
});
