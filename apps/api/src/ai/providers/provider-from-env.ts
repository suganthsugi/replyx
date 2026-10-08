import { FakeAiProvider } from './fake/fake.provider.js';
import { OpenRouterProvider } from './openrouter/openrouter.provider.js';

import type { AiProvider } from './ports.js';

/** `AI_PROVIDER`: `openrouter`, or `fake` (default outside production: tests, e2e, offline dev). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const choice = env.AI_PROVIDER ?? (env.NODE_ENV === 'production' ? 'openrouter' : 'fake');
  if (choice === 'openrouter') return new OpenRouterProvider(env.OPENROUTER_BASE_URL);
  if (choice === 'fake') {
    if (env.NODE_ENV === 'production') throw new Error('AI_PROVIDER=fake is not allowed in production');
    return new FakeAiProvider();
  }
  throw new Error(`Unknown AI_PROVIDER "${choice}" (expected openrouter or fake)`);
}
