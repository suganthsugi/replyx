import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Every page must be ordered in its folder's meta.json (data-model "Docs Page") and carry the
// frontmatter the docs-style skill requires: a one-line `title` with no trailing period and a
// one-line `description`.

const CONTENT = fileURLToPath(new URL('../content/docs/', import.meta.url));

interface Meta {
  pages?: string[];
}

function folders(dir: string): string[] {
  return [dir, ...readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? folders(full) : [];
  })];
}

function readMeta(dir: string): Meta | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
  } catch {
    return null;
  }
}

function frontmatter(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return Object.fromEntries(
    block
      .split(/\r?\n/)
      .map((line) => /^(\w+):\s*(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]!.trim()]),
  );
}

const dirs = folders(CONTENT);
const pages = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => /\.mdx?$/.test(name))
    .map((name) => ({ dir, file: join(dir, name), slug: parse(name).name })),
);

describe('docs content', () => {
  it('has the migrated pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(20);
  });

  it.each(dirs.map((dir) => [dir.slice(CONTENT.length) || '(root)', dir]))('%s lists every page and folder in meta.json', (_, dir) => {
    const meta = readMeta(dir);
    expect(meta, `${dir} has no meta.json`).not.toBeNull();
    const listed = new Set(meta!.pages ?? []);
    const entries = readdirSync(dir)
      .filter((name) => /\.mdx?$/.test(name) || statSync(join(dir, name)).isDirectory())
      .map((name) => parse(name).name);
    for (const entry of entries) expect(listed, `${entry} is missing from ${join(dir, 'meta.json')}`).toContain(entry);
  });

  it.each(pages.map((p) => [p.file.slice(CONTENT.length), p.file]))('%s has a title and a description', (_, file) => {
    const fm = frontmatter(file);
    expect(fm.title, 'title').toBeTruthy();
    expect(fm.title!.endsWith('.'), 'title ends with a period').toBe(false);
    expect(fm.description, 'description').toBeTruthy();
  });
});
