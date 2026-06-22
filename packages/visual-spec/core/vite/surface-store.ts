/**
 * surface-store.ts — the filesystem boundary for surface sources. Route handlers
 * depend on this interface, not on `fs` directly, so they're testable against an
 * in-memory or temp-dir store. The Vite middleware wires the real fs store.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A surface id is a single path segment — guards against traversal. */
export const SURFACE_ID_RE = /^[a-z0-9][a-z0-9-_]*$/i;

export interface SurfaceStore {
  read(surfaceId: string): Promise<string>;
  write(surfaceId: string, source: string): Promise<void>;
  list(): Promise<string[]>;
}

export function fsSurfaceStore(root: string, surfacesDir = 'surfaces'): SurfaceStore {
  const entryPath = (id: string) => {
    if (!SURFACE_ID_RE.test(id)) throw new Error(`invalid surfaceId: ${id}`);
    return join(root, surfacesDir, id, 'index.tsx');
  };
  return {
    async read(id) {
      return readFile(entryPath(id), 'utf8');
    },
    async write(id, source) {
      return writeFile(entryPath(id), source, 'utf8');
    },
    async list() {
      const entries = await readdir(join(root, surfacesDir), { withFileTypes: true });
      return entries.filter((d) => d.isDirectory()).map((d) => d.name);
    },
  };
}

/** In-memory store — handy for tests and previews. */
export function memorySurfaceStore(seed: Record<string, string> = {}): SurfaceStore {
  const map = new Map(Object.entries(seed));
  return {
    async read(id) {
      const v = map.get(id);
      if (v == null) throw new Error(`surface not found: ${id}`);
      return v;
    },
    async write(id, source) {
      map.set(id, source);
    },
    async list() {
      return [...map.keys()];
    },
  };
}
