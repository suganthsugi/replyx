import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// @testing-library/jest-dom 6 augments Vitest's pre-v3 `Assertion<T>`; Vitest 5 takes custom
// matcher types through `Matchers<R, T>`. The runtime matchers come from test/setup.ts.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type -- a type-only merge that must repeat Vitest's parameters
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends TestingLibraryMatchers<unknown, R> {}
}
