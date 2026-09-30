import { describe, expect, it } from 'vitest';

import { scannerFromEnv } from '../../../src/attachments/scan.job.js';

describe('scannerFromEnv', () => {
  it('uses ClamAV whenever CLAMAV_HOST is set, even with SCAN_DISABLED', () => {
    expect(scannerFromEnv({ NODE_ENV: 'production', CLAMAV_HOST: 'clamav:3310', SCAN_DISABLED: 'true' }).name).toBe('clamav');
  });

  it('refuses to run in production without a scanner or an explicit opt-out', () => {
    expect(() => scannerFromEnv({ NODE_ENV: 'production' })).toThrow(/not allowed in production/);
    expect(() => scannerFromEnv({ NODE_ENV: 'production', SCAN_DISABLED: 'yes' })).toThrow(/not allowed in production/);
  });

  it('allows the pass-through scanner in production only with SCAN_DISABLED=true', () => {
    expect(scannerFromEnv({ NODE_ENV: 'production', SCAN_DISABLED: 'true' }).name).toBe('passthrough');
  });

  it('keeps the pass-through scanner outside production', () => {
    expect(scannerFromEnv({ NODE_ENV: 'development' }).name).toBe('passthrough');
  });
});
