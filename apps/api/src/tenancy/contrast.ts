/**
 * WCAG 2.2 AA contrast for `tenant_settings.brand_colors.primary` (T183, contracts/operations.yaml
 * `/settings`, constitution XI): the color fills the customer chat bubble/button, so it must read
 * against white text. This is a server-side twin of `apps/web/src/theme/brand-accent.ts` — same
 * math, deliberately re-derived rather than imported (the web module also reasons about theme
 * surfaces the API has no notion of) — kept as pure functions so it is unit testable without a
 * DOM or a database.
 */

export const AA_NORMAL_TEXT_CONTRAST = 4.5;
/** The button/bubble fill is always read against white text (not a themed surface). */
export const WHITE = '#ffffff';

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

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

export function isValidHexColor(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = hex.trim().toLowerCase();
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function toHexByte(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
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
    if (max === rNorm) h = 60 * (((gNorm - bNorm) / delta) % 6);
    else if (max === gNorm) h = 60 * ((bNorm - rNorm) / delta + 2);
    else h = 60 * ((rNorm - gNorm) / delta + 4);
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
  if (h < 60) [rPrime, gPrime, bPrime] = [c, x, 0];
  else if (h < 120) [rPrime, gPrime, bPrime] = [x, c, 0];
  else if (h < 180) [rPrime, gPrime, bPrime] = [0, c, x];
  else if (h < 240) [rPrime, gPrime, bPrime] = [0, x, c];
  else if (h < 300) [rPrime, gPrime, bPrime] = [x, 0, c];
  else [rPrime, gPrime, bPrime] = [c, 0, x];

  return { r: (rPrime + m) * 255, g: (gPrime + m) * 255, b: (bPrime + m) * 255 };
}

function linearizeChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.x, in [0, 1]. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/** Contrast ratio between two colors per WCAG 2.x, in [1, 21]. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsAAContrast(hex: string, against: string = WHITE, minContrast: number = AA_NORMAL_TEXT_CONTRAST): boolean {
  return contrastRatio(hex, against) >= minContrast;
}

/**
 * The nearest shade of `hex` (walking lightness in HSL space, darker and lighter) that reaches
 * `minContrast` against `against`, picking whichever direction lands closest to the original
 * lightness. Falls back to black/white if no shade of the hue/saturation can reach the target
 * (very low saturation colors). Used only to suggest a passing color in the 400 response — the
 * tenant's own choice is never silently replaced.
 */
export function nearestAACompliantShade(hex: string, against: string = WHITE, minContrast: number = AA_NORMAL_TEXT_CONTRAST): string {
  if (meetsAAContrast(hex, against, minContrast)) return hex;

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
    return relativeLuminance(against) > 0.5 ? '#000000' : '#ffffff';
  }
  if (darkerMatch === null) return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: lighterMatch as number }));
  if (lighterMatch === null) return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: darkerMatch }));

  const nearest = Math.abs(hsl.l - darkerMatch) <= Math.abs(hsl.l - lighterMatch) ? darkerMatch : lighterMatch;
  return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: nearest }));
}
