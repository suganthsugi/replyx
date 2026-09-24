import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Testcontainers setup (PostgreSQL + Valkey, init.sql, migrations) is added by T045.
// It is wired only once the file exists so the empty suite still runs.
const globalSetupFile = fileURLToPath(new URL('./test/support/global-setup.ts', import.meta.url));

export default defineConfig({
  // esbuild does not emit decorator metadata, which Nest's DI needs; SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: existsSync(globalSetupFile) ? [globalSetupFile] : [],
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
