import { afterEach, describe, expect, it, vi } from 'vitest';

import { seedDev } from '../../../src/tenancy/dev-seed.js';

describe('seedDev', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is refused in production before touching anything', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = { get: vi.fn() };
    await expect(seedDev(app as never)).rejects.toThrow('refused when NODE_ENV=production');
    expect(app.get).not.toHaveBeenCalled();
  });
});
