/**
 * dev.mjs — `pnpm --filter visual-spec dev <specs-dir>`.
 *
 * Starts the Vite dev server (full UI hot-reload + live markdown reload) rooted
 * at this package but serving specs from <specs-dir>. The directory is passed to
 * the Vite config via VS_CONTENT_DIR; comments are written next to the specs.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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

const server = await createServer();
await server.listen();
console.log(`\n  visual-spec (dev) — specs: ${dir}\n`);
server.printUrls();
