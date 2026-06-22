/**
 * md-store.ts — filesystem boundary for Markdown surfaces. A surface id is a
 * relative path under the content dir without the .md extension (e.g.
 * "tasks/post-it-notes"). Reuses the SurfaceStore interface so the route handlers
 * are storage-agnostic.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SurfaceStore } from './surface-store';

/** Nested ids allowed; reject traversal and absolute paths. */
export function assertMdId(id: string): void {
  if (!id || id.includes('..') || id.startsWith('/') || id.includes('\0')) {
    throw new Error(`invalid surfaceId: ${id}`);
  }
}

async function walkMarkdown(dir: string, root: string, acc: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(abs, root, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const id = relative(root, abs).split(sep).join('/').replace(/\.md$/, '');
      acc.push(id);
    }
  }
}

export function mdSurfaceStore(contentDir: string): SurfaceStore {
  const entryPath = (id: string) => {
    assertMdId(id);
    return join(contentDir, `${id}.md`);
  };
  return {
    async read(id) {
      return readFile(entryPath(id), 'utf8');
    },
    async write(id, source) {
      return writeFile(entryPath(id), source, 'utf8');
    },
    async list() {
      const acc: string[] = [];
      await walkMarkdown(contentDir, contentDir, acc);
      return acc.sort();
    },
  };
}
