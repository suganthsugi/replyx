import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The theme tokens of contracts/theme-tokens.md: present in both themes, readable (WCAG 2.2 AA) and
// the only colors the illustrations use (FR-015, FR-017, SC-006).

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const css = readFileSync(join(ROOT, 'app/global.css'), 'utf8');

/** The `--rx-*` declarations of the first rule whose selector is exactly `selector`. */
function tokens(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/(--rx-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
}

const THEMES = { light: tokens(':root'), dark: tokens('.dark') };

const ALL = [
  '--rx-bg', '--rx-surface', '--rx-surface-2', '--rx-border', '--rx-text', '--rx-text-2', '--rx-primary',
  '--rx-primary-text', '--rx-ai', '--rx-ai-glow', '--rx-ai-glow-2', '--rx-warning', '--rx-level-fast',
  '--rx-level-standard', '--rx-level-advanced',
];
const TEXT = ['--rx-text', '--rx-text-2', '--rx-primary-text', '--rx-warning'];
const STROKES = ['--rx-ai', '--rx-primary', '--rx-level-fast', '--rx-level-standard', '--rx-level-advanced'];

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe.each(Object.entries(THEMES))('%s theme', (_, t) => {
  it('defines every token', () => {
    for (const name of ALL) expect(t[name], name).toBeTruthy();
  });

  it.each(TEXT)('%s is at least 4.5:1 on the background and on surfaces', (name) => {
    for (const bg of ['--rx-bg', '--rx-surface']) expect(contrast(t[name]!, t[bg]!), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STROKES)('%s is at least 3:1 on the background', (name) => {
    expect(contrast(t[name]!, t['--rx-bg']!), name).toBeGreaterThanOrEqual(3);
  });

  it('white text on a light primary fill, or background-colored text on a dark one, is at least 4.5:1', () => {
    const fg = t === THEMES.light ? t['--rx-surface']! : t['--rx-bg']!;
    expect(contrast(fg, t['--rx-primary-text']!)).toBeGreaterThanOrEqual(4.5);
  });
});

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

it('illustrations use theme tokens, never hex colors', () => {
  const sources = ['components/flow', 'components/illustrations'].flatMap((d) => files(join(ROOT, d))).filter((f) => /\.tsx?$/.test(f));
  for (const file of sources) {
    const hex = readFileSync(file, 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(hex, `${file.slice(ROOT.length)} has hard-coded colors`).toBeNull();
  }
});
