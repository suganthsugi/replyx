import { getContrastRatio } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';

import {
  AA_LARGE_TEXT_CONTRAST,
  AA_NORMAL_TEXT_CONTRAST,
  contrastRatio,
  defaultSurfacesForMode,
  hexToRgb,
  hslToRgb,
  isValidHexColor,
  nearestAACompliantShade,
  resolveBrandAccent,
  rgbToHex,
  rgbToHsl,
} from '../../src/theme/brand-accent';
import { createAppTheme, darkTheme, lightTheme } from '../../src/theme/theme';
import { colorTokens } from '../../src/theme/tokens';

describe('color math', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('round-trips hex, rgb and hsl', () => {
    for (const hex of ['#4b4fe0', '#f45b3b', '#1f9d6b', '#000000', '#ffffff', '#808080']) {
      expect(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex))))).toBe(hex);
    }
    expect(hexToRgb('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it('validates tenant colors', () => {
    expect(isValidHexColor('#12abEF')).toBe(true);
    expect(isValidHexColor(' #fff ')).toBe(true);
    for (const value of [null, undefined, '', 'red', '#12345', '#ggg', 'rgb(0,0,0)', '#1234567']) {
      expect(isValidHexColor(value)).toBe(false);
    }
  });

  it('keeps compliant colors and moves others to the nearest compliant shade', () => {
    expect(nearestAACompliantShade('#23256e', '#ffffff')).toBe('#23256e');
    const adjusted = nearestAACompliantShade('#ffd98a', '#ffffff');
    expect(contrastRatio(adjusted, '#ffffff')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_CONTRAST);
    // Same hue family, just darker.
    expect(Math.abs(rgbToHsl(hexToRgb(adjusted)).h - rgbToHsl(hexToRgb('#ffd98a')).h)).toBeLessThan(2);
  });
});

describe('resolveBrandAccent', () => {
  it('falls back to the default accent for missing or malformed colors', () => {
    for (const value of [null, undefined, 'blue', '#12']) {
      expect(resolveBrandAccent(value)).toEqual({ color: colorTokens.primary.main, wasAdjusted: false, usedFallback: true });
    }
  });

  it('meets both AA constraints in both modes for any tenant color', () => {
    const samples: string[] = [];
    for (let h = 0; h < 360; h += 30) {
      for (const s of [0, 40, 100]) {
        for (const l of [5, 30, 50, 70, 95]) samples.push(rgbToHex(hslToRgb({ h, s, l })));
      }
    }
    for (const mode of ['light', 'dark'] as const) {
      const surfaces = defaultSurfacesForMode(mode);
      for (const sample of samples) {
        const { color } = resolveBrandAccent(sample, mode);
        expect({ mode, sample, fill: contrastRatio(color, surfaces.onAccentText) >= AA_NORMAL_TEXT_CONTRAST }).toEqual({
          mode,
          sample,
          fill: true,
        });
        expect({ mode, sample, surface: contrastRatio(color, surfaces.surface) >= AA_LARGE_TEXT_CONTRAST }).toEqual({
          mode,
          sample,
          surface: true,
        });
      }
    }
  });

  it('reports when it adjusted the tenant color', () => {
    expect(resolveBrandAccent('#23256e', 'light')).toMatchObject({ color: '#23256e', wasAdjusted: false });
    expect(resolveBrandAccent('#ffee00', 'light')).toMatchObject({ wasAdjusted: true, usedFallback: false });
  });
});

describe('createAppTheme', () => {
  it('uses the resolved tenant accent as primary', () => {
    const theme = createAppTheme('light', '#ffee00');
    expect(theme.palette.primary.main).toBe(resolveBrandAccent('#ffee00', 'light').color);
  });

  it('gives every palette color AA contrast text', () => {
    for (const theme of [lightTheme, darkTheme]) {
      for (const key of ['primary', 'secondary', 'success', 'warning', 'error'] as const) {
        const color = theme.palette[key];
        expect({ mode: theme.palette.mode, key, ok: getContrastRatio(color.main, color.contrastText) >= AA_NORMAL_TEXT_CONTRAST }).toEqual({
          mode: theme.palette.mode,
          key,
          ok: true,
        });
      }
    }
  });

  it('keeps body text readable on both backgrounds', () => {
    for (const theme of [lightTheme, darkTheme]) {
      for (const text of [theme.palette.text.primary, theme.palette.text.secondary]) {
        expect(getContrastRatio(text, theme.palette.background.default)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_CONTRAST);
        expect(getContrastRatio(text, theme.palette.background.paper)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_CONTRAST);
      }
    }
  });

  it('shows a visible focus ring and honours reduced motion', () => {
    const buttonBase = lightTheme.components?.MuiButtonBase?.styleOverrides?.root as Record<string, unknown>;
    expect(buttonBase['&.Mui-focusVisible']).toMatchObject({ outline: `2px solid ${colorTokens.focusRing}` });
    const baseline = lightTheme.components?.MuiCssBaseline?.styleOverrides as Record<string, unknown>;
    expect(baseline).toHaveProperty(['@media (prefers-reduced-motion: reduce)']);
    const darkButtonBase = darkTheme.components?.MuiButtonBase?.styleOverrides?.root as Record<string, unknown>;
    expect(darkButtonBase['&.Mui-focusVisible']).toMatchObject({ outline: `2px solid ${colorTokens.focusRingOnDark}` });
    for (const background of [lightTheme.palette.background.paper, lightTheme.palette.background.default]) {
      expect(contrastRatio(colorTokens.focusRing, background)).toBeGreaterThanOrEqual(3);
    }
    for (const background of [darkTheme.palette.background.paper, darkTheme.palette.background.default]) {
      expect(contrastRatio(colorTokens.focusRingOnDark, background)).toBeGreaterThanOrEqual(3);
    }
  });
});
