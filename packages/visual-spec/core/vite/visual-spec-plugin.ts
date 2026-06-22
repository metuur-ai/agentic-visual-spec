/**
 * visual-spec-plugin.ts — discover surfaces and expose them as a virtual module.
 * `surfaces/<id>/index.tsx` → `virtual:visual-spec/surfaces` with `surfaceIds`,
 * `surfaceMeta`, and `loadSurface(id)` (a switch of dynamic imports).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:visual-spec/surfaces';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function visualSpecPlugin(opts: { surfacesDir?: string } = {}): Plugin {
  const surfacesDir = opts.surfacesDir ?? 'surfaces';
  let root = process.cwd();

  async function discover(): Promise<string[]> {
    try {
      const entries = await readdir(join(root, surfacesDir), { withFileTypes: true });
      return entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }

  return {
    name: 'visual-spec:surfaces',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      const ids = await discover();
      const cases = ids
        .map((sid) => `    case ${JSON.stringify(sid)}: return import(${JSON.stringify(`/${surfacesDir}/${sid}/index.tsx`)});`)
        .join('\n');
      return `
export const surfaceIds = ${JSON.stringify(ids)};
export const surfaceMeta = {};
export async function loadSurface(id) {
  switch (id) {
${cases}
    default: throw new Error('unknown surface: ' + id);
  }
}
`;
    },
  };
}
