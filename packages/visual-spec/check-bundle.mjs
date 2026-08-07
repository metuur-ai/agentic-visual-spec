/**
 * check-bundle.mjs — R-12.6, build-output layer.
 *
 * Greps the *emitted* Node-reachable bundles (the CLI and the Vite plugin host,
 * plus any tsup chunk they pull in) for react / react-dom / Luthor references.
 * The static layer (core/bundle-guard.test.ts) catches a stray import in the
 * TypeScript sources; this catches anything a bundler inlines behind its back.
 *
 * Run AFTER `npm run build`:  npm run check:bundle
 * dist/ui/** is deliberately not checked — the browser bundle SHOULD contain react.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ENTRIES = ['dist/cli.js', 'dist/vite/index.js', 'dist/index.js'];
const FORBIDDEN = /['"](react|react-dom|@lyfie\/luthor)(\/[^'"]*)?['"]|react-dom\/server/g;

/** dist entry + every relative chunk it imports, transitively. */
function bundleFiles(entry) {
  const files = [];
  const seen = new Set();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    files.push([file, source]);
    for (const match of source.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), match[1]));
    }
  }
  return files;
}

let failed = false;
for (const entry of ENTRIES) {
  if (!existsSync(entry)) {
    console.error(`✗ ${entry} missing — run \`npm run build\` first`);
    failed = true;
    continue;
  }
  for (const [file, source] of bundleFiles(entry)) {
    const hits = [...source.matchAll(FORBIDDEN)];
    if (hits.length === 0) continue;
    failed = true;
    console.error(
      `✗ ${entry}: ${hits.length} browser-ecosystem reference(s) in ${relative(process.cwd(), file)}` +
        ` — ${[...new Set(hits.map((h) => h[0]))].slice(0, 5).join(', ')}`,
    );
  }
}

if (failed) {
  console.error('\nNode-reachable output must not reference react / react-dom / @lyfie/luthor (R-12.6, R-3.3).');
  process.exit(1);
}
console.log(`✓ ${ENTRIES.join(', ')} carry no react / react-dom / @lyfie/luthor references`);
