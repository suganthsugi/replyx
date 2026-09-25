/**
 * Applies a tenant's brand accent color to the theme, adjusting it to the nearest WCAG 2.2 AA
 * shade when the tenant's chosen color does not have enough contrast (constitution XI,
 * FR-071a). Every export here is a pure function — no DOM/theme access — so it can be unit
 * tested in isolation.
 */

import { colorTokens } from './tokens';

export const AA_NORMAL_TEXT_CONTRAST = 4.5;
export const AA_LARGE_TEXT_CONTRAST = 3;
/** Aim slightly above the thresholds: checkers round luminance differently (MUI's
 * `getContrastRatio` reports 4.47 for a shade that is 4.50 unrounded). */
export const CONTRAST_SAFETY_MARGIN = 0.1;

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

/** The tenant color is unset, malformed, or otherwise unusable as a brand accent. */
export function isValidHexColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value.trim());
}

function expandShorthandHex(hex: string): string {
  if (hex.length === 4) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = expandShorthandHex(hex.trim().toLowerCase());
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return { r, g, b };
}

function toHexByte(value: number): string {
  const clamped = Math.round(Math.min(255, Math.max(0, value)));
  return clamped.toString(16).padStart(2, '0');
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

export function rgbToHsl({ r, g, b }: RgbColor): HslColor {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      h = 60 * (((gNorm - bNorm) / delta) % 6);
    } else if (max === gNorm) {
      h = 60 * ((bNorm - rNorm) / delta + 2);
    } else {
      h = 60 * ((rNorm - gNorm) / delta + 4);
    }
  }
  if (h < 0) h += 360;

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: HslColor): RgbColor {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (h < 60) {
    [rPrime, gPrime, bPrime] = [c, x, 0];
  } else if (h < 120) {
    [rPrime, gPrime, bPrime] = [x, c, 0];
  } else if (h < 180) {
    [rPrime, gPrime, bPrime] = [0, c, x];
  } else if (h < 240) {
    [rPrime, gPrime, bPrime] = [0, x, c];
  } else if (h < 300) {
    [rPrime, gPrime, bPrime] = [x, 0, c];
  } else {
    [rPrime, gPrime, bPrime] = [c, 0, x];
  }

  return {
    r: (rPrime + m) * 255,
    g: (gPrime + m) * 255,
    b: (bPrime + m) * 255,
  };
}

function linearizeChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.x, in the [0, 1] range. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const rLin = linearizeChannel(r);
  const gLin = linearizeChannel(g);
  const bLin = linearizeChannel(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/** Contrast ratio between two colors per WCAG 2.x, in the [1, 21] range. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsAAContrast(
  hexA: string,
  hexB: string,
  minContrast: number = AA_NORMAL_TEXT_CONTRAST,
): boolean {
  return contrastRatio(hexA, hexB) >= minContrast;
}

/**
 * Finds the nearest shade of `hex` (walking lightness in HSL space) that reaches `minContrast`
 * against `against`. Searches both darker and lighter directions and returns whichever compliant
 * shade is closest to the original lightness. Returns the original color unchanged if it already
 * complies, and falls back to pure black/white if no shade of the original hue/saturation can
 * reach the target (extreme cases at very low saturation).
 */
export function nearestAACompliantShade(
  hex: string,
  against: string,
  minContrast: number = AA_NORMAL_TEXT_CONTRAST,
): string {
  if (meetsAAContrast(hex, against, minContrast)) {
    return hex;
  }

  const hsl = rgbToHsl(hexToRgb(hex));
  const step = 1;

  let darkerMatch: number | null = null;
  for (let l = hsl.l - step; l >= 0; l -= step) {
    const candidate = rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }));
    if (meetsAAContrast(candidate, against, minContrast)) {
      darkerMatch = l;
      break;
    }
  }

  let lighterMatch: number | null = null;
  for (let l = hsl.l + step; l <= 100; l += step) {
    const candidate = rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }));
    if (meetsAAContrast(candidate, against, minContrast)) {
      lighterMatch = l;
      break;
    }
  }

  if (darkerMatch === null && lighterMatch === null) {
    // Even the extremes of this hue/saturation can't reach the target contrast (e.g. a very
    // low-saturation color against a mid-tone surface). Fall back to whichever pole is legible.
    return relativeLuminance(against) > 0.5 ? '#000000' : '#FFFFFF';
  }

  if (darkerMatch === null) {
    return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: lighterMatch as number }));
  }
  if (lighterMatch === null) {
    return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: darkerMatch }));
  }

  const darkerDistance = Math.abs(hsl.l - darkerMatch);
  const lighterDistance = Math.abs(hsl.l - lighterMatch);
  const nearestLightness = darkerDistance <= lighterDistance ? darkerMatch : lighterMatch;
  return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: nearestLightness }));
}

export interface BrandAccentSurfaces {
  /** The page/paper surface the accent color is drawn or read against (e.g. as a link or
   * selected-state color). Defaults to white for light mode, near-black for dark mode. */
  surface: string;
  /** The color used for text/icons painted on top of a solid accent fill (e.g. button labels).
   * White in light mode; near-black in dark mode. The two constraints must pull the same way:
   * in light mode a darker accent helps both, in dark mode a lighter one does. (White text on
   * the accent in dark mode would need a dark accent that fails against the dark surface.) */
  onAccentText: string;
}

export function defaultSurfacesForMode(mode: 'light' | 'dark'): BrandAccentSurfaces {
  return mode === 'light'
    ? { surface: colorTokens.neutral[0], onAccentText: colorTokens.neutral[0] }
    : { surface: colorTokens.neutral[950], onAccentText: colorTokens.neutral[950] };
}

export interface ResolvedBrandAccent {
  /** The color to use as `palette.primary.main`. Equal to the tenant color when it already
   * passes AA; otherwise the nearest compliant shade of it; otherwise the built-in default. */
  color: string;
  /** True when `color` differs from the requested tenant color. */
  wasAdjusted: boolean;
  /** True when the tenant color was unusable (missing/malformed) and the built-in default was
   * used as the starting point instead. */
  usedFallback: boolean;
}

/**
 * Resolves the color to use as the tenant's brand accent (`palette.primary.main`).
 *
 * Pure function: given the same inputs it always returns the same output, so it can be unit
 * tested without a DOM or a theme instance. Validates the tenant's chosen color, then makes sure
 * it is legible both as a fill (against `onAccentText`) and as a foreground element on the app's
 * surface (against `surface`), adjusting lightness to the nearest WCAG AA-compliant shade for
 * whichever check is stricter.
 */
export function resolveBrandAccent(
  tenantColor: string | null | undefined,
  mode: 'light' | 'dark' = 'light',
  surfaces: BrandAccentSurfaces = defaultSurfacesForMode(mode),
  /** The built-in accent to start from without a usable tenant color (the design system's teal). */
  fallbackColor: string = colorTokens.primary.main,
): ResolvedBrandAccent {
  const usedFallback = !isValidHexColor(tenantColor);
  const startingColor = usedFallback ? fallbackColor : tenantColor;

  const shadeForFill = nearestAACompliantShade(
    startingColor,
    surfaces.onAccentText,
    AA_NORMAL_TEXT_CONTRAST + CONTRAST_SAFETY_MARGIN,
  );
  const shadeForSurface = nearestAACompliantShade(
    shadeForFill,
    surfaces.surface,
    AA_LARGE_TEXT_CONTRAST + CONTRAST_SAFETY_MARGIN,
  );

  return {
    color: shadeForSurface,
    wasAdjusted: shadeForSurface.toLowerCase() !== startingColor.toLowerCase(),
    usedFallback,
  };
}
