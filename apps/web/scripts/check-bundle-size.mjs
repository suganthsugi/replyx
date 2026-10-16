// Customer bundle budget (T266, research D21, plan "customer bundle < 150 KB gzipped").
//
// Reads the Vite manifest of a production build (`pnpm --filter web build`) and adds up, gzipped,
// everything a customer downloads: the entry chunk, `src/routes/CustomerArea.tsx`, everything they
// import statically and any chunk they load lazily, with their CSS. Workspace and console chunks are
// never counted because the customer area never imports them. Exits 1 above the budget.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 150 * 1024;
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));

const roots = ['index.html', 'src/routes/CustomerArea.tsx'];
for (const root of roots) {
  if (manifest[root] === undefined) {
    console.error(`check-bundle-size: ${root} is not in the manifest; was the build made with build.manifest?`);
    process.exit(2);
  }
}

const files = new Set();
const seen = new Set();
function visit(key, followDynamic) {
  if (seen.has(key)) return;
  seen.add(key);
  const chunk = manifest[key];
  if (chunk === undefined) return;
  files.add(chunk.file);
  for (const css of chunk.css ?? []) files.add(css);
  for (const imported of chunk.imports ?? []) visit(imported, followDynamic);
  if (followDynamic) for (const lazy of chunk.dynamicImports ?? []) visit(lazy, true);
}
// The entry's lazy imports are the three areas; only the customer one is followed.
visit('index.html', false);
visit('src/routes/CustomerArea.tsx', true);

let total = 0;
const rows = [...files].sort().map((file) => {
  const size = gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
  total += size;
  return { file, kb: (size / 1024).toFixed(1) };
});
console.table(rows);
const verdict = `customer bundle: ${(total / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_BYTES / 1024} KB)`;
if (total > BUDGET_BYTES) {
  console.error(`check-bundle-size: over budget, ${verdict}`);
  process.exit(1);
}
console.log(`check-bundle-size: ok, ${verdict}`);
