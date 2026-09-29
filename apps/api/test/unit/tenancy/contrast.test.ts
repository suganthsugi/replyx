import { describe, expect, it } from 'vitest';

import {
  AA_NORMAL_TEXT_CONTRAST,
  contrastRatio,
  meetsAAContrast,
  nearestAACompliantShade,
} from '../../../src/tenancy/contrast.js';

/**
 * WCAG AA contrast math for `tenant_settings.brand_colors.primary` (T183, src/tenancy/contrast.ts).
 */

describe('contrastRatio', () => {
  it('is 21 for black against white, the maximum possible ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1 for a color against itself', () => {
    expect(contrastRatio('#3366cc', '#3366cc')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(contrastRatio('#abcdef', '#123456'), 10);
  });

  it('matches the known ratio for #777777 against white', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});

describe('meetsAAContrast', () => {
  it('passes black and fails a light gray against white by default', () => {
    expect(meetsAAContrast('#000000')).toBe(true);
    expect(meetsAAContrast('#eeeeee')).toBe(false);
  });

  it('is right at the boundary for #777777 (just under 4.5:1)', () => {
    expect(meetsAAContrast('#777777')).toBe(false);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(AA_NORMAL_TEXT_CONTRAST);
  });

  it('honors an explicit background and threshold', () => {
    // White on black passes AA large text (3:1) comfortably, and normal text (4.5:1) too.
    expect(meetsAAContrast('#ffffff', '#000000', 3)).toBe(true);
    expect(meetsAAContrast('#ffffff', '#000000')).toBe(true);
  });

  it('accepts shorthand-expanded and uppercase hex identically to lowercase', () => {
    // hexToRgb/relativeLuminance assume 6-digit hex; shorthand must be expanded by callers, but
    // uppercase must be read the same as lowercase.
    expect(meetsAAContrast('#000000')).toBe(meetsAAContrast('#000000'.toUpperCase()));
    expect(contrastRatio('#3366CC', '#FFFFFF')).toBeCloseTo(contrastRatio('#3366cc', '#ffffff'), 10);
  });
});

describe('nearestAACompliantShade', () => {
  it('returns the input unchanged when it already passes', () => {
    expect(nearestAACompliantShade('#000000')).toBe('#000000');
  });

  it('is idempotent: the suggestion for a passing color is itself', () => {
    const passing = nearestAACompliantShade('#eeeeee');
    expect(nearestAACompliantShade(passing)).toBe(passing);
  });

  it('darkens a failing light gray to a passing shade of the same hue/saturation', () => {
    const suggestion = nearestAACompliantShade('#eeeeee');
    expect(meetsAAContrast(suggestion)).toBe(true);
    expect(suggestion).not.toBe('#eeeeee');
  });

  it('returns a passing shade close in hue to a failing, saturated input', () => {
    // A mid-lightness, saturated blue fails against white; the fix should stay blue (same hue),
    // just darker, rather than jumping to an unrelated hue.
    const input = '#6699ff';
    expect(meetsAAContrast(input)).toBe(false);
    const suggestion = nearestAACompliantShade(input);
    expect(meetsAAContrast(suggestion)).toBe(true);

    const hueOf = (hex: string): number => {
      const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
      const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
      const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      if (delta === 0) return 0;
      let h = 0;
      if (max === r) h = 60 * (((g - b) / delta) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
      return h < 0 ? h + 360 : h;
    };
    expect(Math.abs(hueOf(suggestion) - hueOf(input))).toBeLessThan(2);
  });

  it('handles shorthand-free uppercase hex the same as lowercase', () => {
    expect(nearestAACompliantShade('#EEEEEE'.toLowerCase())).toBe(nearestAACompliantShade('#eeeeee'));
  });

  it('finds a passing shade for a zero-saturation gray by darkening it', () => {
    const suggestion = nearestAACompliantShade('#808080');
    expect(meetsAAContrast(suggestion)).toBe(true);
  });
});
