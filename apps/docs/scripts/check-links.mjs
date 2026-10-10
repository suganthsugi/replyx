// Checks every internal link in the static export (research R9, SC-004).
//
//   pnpm --filter docs check:links        (after `pnpm --filter docs build`)
//
// Walks out/**/*.html, collects href values that start with `/` or `#`, and checks that each
// target exists in out/ (a file, `<path>.html`, or `<path>/index.html`) and that any `#fragment`
// matches an id in the target page. Prints every broken link with the page it was found on and
// exits 1 if there are any. No dependencies: attributes are read with regular expressions, which
// is enough for the HTML Next writes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));

if (!existsSync(OUT)) {
  console.error('check-links: out/ not found; run `pnpm --filter docs build` first.');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const htmlFiles = walk(OUT).filter((f) => f.endsWith('.html'));

/** URL path of an exported page, e.g. out/guides/triage/index.html -> /guides/triage/ */
function pagePath(file) {
  const rel = relative(OUT, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel.replace(/\.html$/, '')}`;
}

/** File in out/ that serves a URL path, or null. Mirrors the server's try_files order. */
function resolveTarget(path) {
  const clean = decodeURIComponent(path).replace(/^\/+/, '');
  const candidates = clean === '' ? ['index.html'] : [clean, `${clean}.html`, join(clean, 'index.html')];
  for (const candidate of candidates) {
    const full = join(OUT, candidate);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const html = readFileSync(file, 'utf8');
    idCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeEntities(m[1]))));
  }
  return idCache.get(file);
}

function decodeEntities(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const broken = [];
let checked = 0;

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/\shref="([^"]*)"/g)) {
    const href = decodeEntities(match[1]);
    if (!href.startsWith('/') && !href.startsWith('#')) continue;
    if (href.startsWith('//')) continue; // protocol-relative: external
    checked += 1;

    const [beforeHash, fragment] = href.split('#', 2);
    const path = (beforeHash ?? '').split('?')[0];
    const target = path === '' ? file : resolveTarget(path);

    if (!target) {
      broken.push({ from: pagePath(file), href, reason: 'no such page or file' });
      continue;
    }
    if (fragment && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(fragment))) {
      broken.push({ from: pagePath(file), href, reason: `no element with id "${fragment}"` });
    }
  }
}

if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken internal link(s) in ${htmlFiles.length} pages:`);
  for (const b of broken) console.error(`  ${b.from} -> ${b.href} (${b.reason})`);
  process.exit(1);
}

console.log(`check-links: ${checked} internal links in ${htmlFiles.length} pages, all resolve.`);
