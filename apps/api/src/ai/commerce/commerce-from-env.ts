import { FakeCommerceConnector } from './fake/fake-commerce.connector.js';
import { SpreeAdminConnector } from './spree/spree-admin.connector.js';

import type { CommerceConnector } from './ports.js';

/** `COMMERCE_PROVIDER`: `spree`, or `fake` (default outside production: tests, e2e, offline dev). */
export function commerceFromEnv(env: NodeJS.ProcessEnv = process.env): CommerceConnector {
  const choice = env.COMMERCE_PROVIDER ?? (env.NODE_ENV === 'production' ? 'spree' : 'fake');
  if (choice === 'spree') return new SpreeAdminConnector();
  if (choice === 'fake') {
    if (env.NODE_ENV === 'production') throw new Error('COMMERCE_PROVIDER=fake is not allowed in production');
    return new FakeCommerceConnector();
  }
  throw new Error(`Unknown COMMERCE_PROVIDER "${choice}" (expected spree or fake)`);
}
