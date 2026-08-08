/**
 * dev.mjs — `pnpm --filter visual-spec dev <specs-dir>`.
 *
 * Starts the Vite dev server (full UI hot-reload + live markdown reload) rooted
 * at this package but serving specs from <specs-dir>. The directory is passed to
 * the Vite config via VS_CONTENT_DIR; comments are written next to the specs.
 *
 * Alongside Vite it runs two watchers over the same TypeScript sources:
 * `tsup --watch` (keeps dist/ current, so the library entry points consumed via
 * visual-spec/{config,vite,app,editing} reflect core/ edits) and
 * `tsc --noEmit --watch` (type errors Vite's transpile-only pipeline skips).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: pnpm --filter visual-spec dev <specs-dir>');
  process.exit(1);
}

const dir = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
if (!existsSync(dir)) {
  console.error(`Directory not found: ${dir}`);
  process.exit(1);
}

// Read by vite.config.ts; must be set before the config loads.
process.env.VS_CONTENT_DIR = dir;

// Local .bin so the watchers resolve regardless of the cwd `dev` was run from.
const bin = (name) => join(fileURLToPath(new URL('./node_modules/.bin/', import.meta.url)), name);
const watchers = [
  spawn(bin('tsup'), ['--watch'], { stdio: 'inherit' }),
  spawn(bin('tsc'), ['--noEmit', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
];

const server = await createServer();
await server.listen();
console.log(`\n  visual-spec (dev) — specs: ${dir}\n`);
server.printUrls();

// Vite owns the terminal; without this the watchers survive Ctrl-C as orphans.
const shutdown = () => {
  for (const w of watchers) w.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
