import { describe, expect, it } from 'vitest';

import { isShortening, periodYears, retentionCutoff } from '../../../src/tenancy/retention/retention-period.js';

describe('periodYears', () => {
  it('reads whole years and treats forever as no period', () => {
    expect(periodYears('P1Y')).toBe(1);
    expect(periodYears('P7Y')).toBe(7);
    expect(periodYears('P10Y')).toBe(10);
    expect(periodYears('forever')).toBeNull();
    expect(periodYears('P0Y')).toBeNull();
    expect(periodYears('P6M')).toBeNull();
  });
});

describe('retentionCutoff', () => {
  const now = new Date('2026-09-30T12:00:00.000Z');

  it('is the same instant N years earlier', () => {
    expect(retentionCutoff(now, 'P1Y')?.toISOString()).toBe('2025-09-30T12:00:00.000Z');
    expect(retentionCutoff(now, 'P7Y')?.toISOString()).toBe('2019-09-30T12:00:00.000Z');
  });

  it('clamps a leap day instead of overflowing', () => {
    expect(retentionCutoff(new Date('2028-02-29T00:00:00.000Z'), 'P1Y')?.toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });

  it('is null when nothing is ever purged', () => {
    expect(retentionCutoff(now, 'forever')).toBeNull();
  });
});

describe('isShortening', () => {
  it('counts forever to a period and fewer years as shortening', () => {
    expect(isShortening('forever', 'P7Y')).toBe(true);
    expect(isShortening('P5Y', 'P3Y')).toBe(true);
    expect(isShortening('P2Y', 'P1Y')).toBe(true);
  });

  it('does not count keeping or lengthening the period', () => {
    expect(isShortening('P3Y', 'P3Y')).toBe(false);
    expect(isShortening('P3Y', 'P5Y')).toBe(false);
    expect(isShortening('P3Y', 'forever')).toBe(false);
    expect(isShortening('forever', 'forever')).toBe(false);
  });
});
