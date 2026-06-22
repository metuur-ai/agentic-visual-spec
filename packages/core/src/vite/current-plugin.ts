/**
 * current-plugin.ts — the deictic cursor bridge. Receives selection updates the
 * browser sends over HMR and atomically writes
 * `node_modules/.visual-spec/current.json` so an agent can resolve "this element".
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

type CurrentPayload = {
  surfaceId?: string;
  pageIndex?: number;
  selection?: { line: number; column: number; tagName: string; text: string } | null;
};

export function currentPlugin(): Plugin {
  let root = process.cwd();
  let seq = 0;
  const currentPath = () => join(root, 'node_modules', '.visual-spec', 'current.json');

  return {
    name: 'visual-spec:current',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.ws.on('visual-spec:current', (data: CurrentPayload) => {
        const path = currentPath();
        const payload = { ...data, updatedAt: new Date().toISOString() };
        // Unique temp name per write so concurrent updates don't race on rename;
        // swallow errors so a transient write failure never crashes the dev server.
        const tmp = `${path}.${process.pid}.${seq++}.tmp`;
        void (async () => {
          try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
            await rename(tmp, path); // atomic swap
          } catch (err) {
            server.config.logger.warn(`[visual-spec] current.json write failed: ${(err as Error).message}`);
          }
        })();
      });
    },
  };
}
