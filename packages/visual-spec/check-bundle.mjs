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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/*
 * The browser bundle SHOULD contain Lexical — but exactly once. Lexical stamps
 * `LexicalEditor.version` on each module copy and treats a second copy as a foreign
 * editor (error #195), which degrades silently: the document still renders, and then
 * every keystroke is dropped because the update listener belongs to the other instance.
 * `dirty` never flips, so Publish stays disabled and the author cannot publish at all.
 * Nothing in the type checker or the vitest suite can see this — vitest resolves one
 * copy and never builds — so the emitted bundle is the only place it is observable.
 * Held single by `resolve.dedupe: ['lexical']` in vite.config.ts.
 */
const UI_ASSETS = 'dist/ui/assets';
const LEXICAL_STAMP = /version\s*=\s*["']\d+\.\d+\.\d+\+[a-z.]+["']/g;
if (!existsSync(UI_ASSETS)) {
  console.error(`✗ ${UI_ASSETS} missing — run \`npm run build\` first`);
  failed = true;
} else {
  const copies = [];
  for (const name of readdirSync(UI_ASSETS).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(resolve(UI_ASSETS, name), 'utf8');
    for (const hit of source.matchAll(LEXICAL_STAMP)) copies.push(`${name}: ${hit[0]}`);
  }
  if (copies.length !== 1) {
    failed = true;
    console.error(
      `✗ ${UI_ASSETS}: expected exactly 1 Lexical module copy, found ${copies.length}` +
        `${copies.length > 0 ? ` — ${copies.join(', ')}` : ''}`,
    );
    console.error('  Two copies means Lexical error #195: the editor renders and then ignores every keystroke.');
    console.error("  Fix by keeping `resolve.dedupe: ['lexical']` in vite.config.ts, not by deleting this check.");
  }
}

if (failed) {
  console.error('\nNode-reachable output must not reference react / react-dom / @lyfie/luthor (R-12.6, R-3.3).');
  process.exit(1);
}
console.log(`✓ ${ENTRIES.join(', ')} carry no react / react-dom / @lyfie/luthor references`);
console.log(`✓ ${UI_ASSETS} carries exactly one Lexical module copy`);
