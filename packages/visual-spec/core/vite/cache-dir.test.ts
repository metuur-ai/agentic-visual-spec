/**
 * cache-dir.test.ts — the Vite host must not litter the directory it serves.
 *
 * Vite's dep optimizer writes its cache (`deps`, `deps_temp_*`) into `cacheDir`,
 * which it derives from `root`. When this plugin is mounted with the Vite root set
 * to the user's content directory — how the plugin host is embedded, and how
 * `host-parity.test.ts` runs it — that default puts a `.vite/` folder inside the
 * user's workspace: serve `~/docs` and `~/docs/.vite` shows up. It is hidden from
 * the file tree by DEFAULT_IGNORE, so it was invisible rather than absent.
 *
 * This starts the host over a real temporary directory, serves a page so the
 * optimizer actually runs, and reads the directory back. Without the `config` hook
 * in md-plugin.ts, `.vite` is there.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { type ViteDevServer, createServer as createViteServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { visualSpecMarkdown } from './md-plugin';

let fixture = '';
let vite: ViteDevServer | undefined;

/**
 * A served directory with just enough of an app in it that requesting `/` makes
 * Vite run its optimizer — an empty folder proves nothing about a cache that is
 * only written when there is work to do.
 */
async function serve(contentDir?: string): Promise<number> {
  await writeFile(join(fixture, 'a.md'), '# a\n');
  await writeFile(join(fixture, 'index.html'), '<html><body><script type="module" src="/main.js"></script></body></html>');
  await writeFile(join(fixture, 'main.js'), "import { useState } from 'react';\nconsole.log(useState);\n");
  vite = await createViteServer({
    configFile: false,
    root: fixture,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: visualSpecMarkdown({ contentDir: contentDir ?? fixture }),
  });
  await vite.listen();
  return (vite.httpServer?.address() as AddressInfo).port;
}

/** Drive the requests that make the optimizer flush, then let it settle. */
async function exercise(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/`);
  await fetch(`http://127.0.0.1:${port}/main.js`);
  await new Promise((r) => setTimeout(r, 1500));
}

afterEach(async () => {
  await vite?.close();
  vite = undefined;
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = '';
});

describe('the Vite host keeps its dependency cache out of the served directory', () => {
  it('writes no .vite into the directory it is serving', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'vs-cache-'));
    const port = await serve();
    await exercise(port);

    const entries = await readdir(fixture);
    expect(entries).not.toContain('.vite');
    // `deps_temp_*` is written as a sibling of `deps`, so it lands in the served
    // directory too whenever the cache does — assert on the shape, not one name.
    expect(entries.filter((e) => e.startsWith('.vite') || e.startsWith('deps'))).toEqual([]);
  }, 60_000);

  it('points cacheDir at a location outside the served directory', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'vs-cache-'));
    await serve();
    const rel = relative(fixture, vite?.config.cacheDir ?? '');
    expect(rel.startsWith('..')).toBe(true);
  }, 60_000);

  it('leaves an explicit cacheDir alone — that is the caller\'s decision', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'vs-cache-'));
    await writeFile(join(fixture, 'a.md'), '# a\n');
    const chosen = join(fixture, 'my-cache');
    vite = await createViteServer({
      configFile: false,
      root: fixture,
      cacheDir: chosen,
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: visualSpecMarkdown({ contentDir: fixture }),
    });
    expect(vite.config.cacheDir).toBe(chosen);
  }, 60_000);
});
