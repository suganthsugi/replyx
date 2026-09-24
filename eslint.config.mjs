// @ts-check
// Shared flat config for every workspace package. Each app runs `eslint .` from its own
// directory; ESLint 9 walks up to this file, and file globs below are relative to the repo root.
import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import { importX } from 'eslint-plugin-import-x';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '**/.turbo/',
    '**/.astro/',
    '**/playwright-report/',
    '**/test-results/',
    '.next/',
    'apps/web/src/api/generated/',
  ]),

  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    name: 'replyx/base',
    plugins: { 'import-x': importX },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        // Type-aware linting per app: each file is checked against the nearest tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',

      // Already in recommendedTypeChecked; pinned so a preset change cannot silently drop it.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Resolution is TypeScript's job (typecheck task); import-x only handles ordering and hygiene.
      'import-x/no-duplicates': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // API and worker: Node runtime. NestJS DI reads constructor parameter types at runtime via
  // emitDecoratorMetadata, so type-only import rewriting is NOT enforced here.
  {
    name: 'replyx/api',
    files: ['apps/api/**/*.{ts,mts,cts}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Web app: browser runtime, bundler resolution, type-only imports kept explicit.
  {
    name: 'replyx/web',
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // Tests may print diagnostics.
  {
    name: 'replyx/tests',
    files: ['**/test/**/*.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}', '**/e2e/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Plain JS (config files like this one): no tsconfig covers them, so skip type-aware rules.
  {
    name: 'replyx/js',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
    },
  },

  // Must stay last: turns off stylistic rules that Prettier owns.
  prettierConfig,
);
