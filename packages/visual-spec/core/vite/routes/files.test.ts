import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { titleFromMarkdown } from '../../collaboration/document-record';
import type { CommentDoc } from '../../editing/comment-doc';
import { treeStore } from '../tree-store';
import type { CommentDocStore } from './comments';
import { type FileWriteStore, handleFilesRequest } from './files';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vs-files-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function writeStore(dir = base): FileWriteStore & { invalidations: number } {
  const real = treeStore(dir);
  const wrapper = {
    invalidations: 0,
    resolve: (p: string) => real.resolve(p),
    resolveForWrite: (p: string) => real.resolveForWrite!(p),
    invalidate: () => {
      wrapper.invalidations += 1;
      real.invalidate?.();
    },
  };
  return wrapper;
}

function memoryComments(initial: CommentDoc = { version: 1, comments: [] }): CommentDocStore & { doc: CommentDoc } {
  const holder = {
    doc: initial,
    async read() {
      return holder.doc;
    },
    async write(d: CommentDoc) {
      holder.doc = d;
    },
  };
  return holder;
}

/** Every file under `dir` with its bytes — the fixture for "nothing changed on disk". */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const abs = join(entry.parentPath, entry.name);
    if (entry.isFile()) out[abs.slice(dir.length)] = await readFile(abs, 'utf8');
    else if (entry.isDirectory()) out[`${abs.slice(dir.length)}/`] = '';
  }
  return out;
}

const create = (store: FileWriteStore, path: unknown, comments = memoryComments()) =>
  handleFilesRequest(store, comments, 'POST', '/create', { path } as Record<string, unknown>);

const rename = (store: FileWriteStore, from: unknown, to: unknown, comments: CommentDocStore = memoryComments()) =>
  handleFilesRequest(store, comments, 'POST', '/rename', { from, to } as Record<string, unknown>);

describe('create — refusals cost nothing on disk', () => {
  it.each([
    ['missing path', undefined],
    ['empty path', ''],
    ['whitespace-only path', '   '],
    ['traversal', '../escape.md'],
    ['absolute path', '/etc/passwd.md'],
    ['NUL byte', 'a\0b.md'],
    ['non-markdown extension', 'notes/kickoff.txt'],
  ])('refuses %s with 400 and leaves the directory byte-identical', async (_label, path) => {
    await writeFile(join(base, 'existing.md'), '# existing\n');
    const before = await snapshot(base);

    const res = await create(writeStore(), path);

    expect(res.status).toBe(400);
    expect(await snapshot(base)).toEqual(before);
  });

  it('names the extension it refused and does not rewrite it (R-1.4)', async () => {
    const res = await create(writeStore(), 'notes/kickoff.txt');
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toContain('.txt');
    expect((res.json as { error: string }).error).toContain('notes/kickoff.txt');
    expect(await readdir(base)).toEqual([]);
  });

  it('refuses a target reached through a symlink that leaves the served directory (R-1.5)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vs-outside-'));
    await symlink(outside, join(base, 'link'));
    const before = await snapshot(outside);

    const res = await create(writeStore(), 'link/deep/nested.md');

    expect(res.status).toBe(400);
    expect(await snapshot(outside)).toEqual(before);
    await rm(outside, { recursive: true, force: true });
  });
});

describe('create — the happy path', () => {
  it('appends .md to an extensionless path (R-1.3)', async () => {
    const res = await create(writeStore(), 'notes/kickoff');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ path: 'notes/kickoff.md' });
    expect(await readFile(join(base, 'notes', 'kickoff.md'), 'utf8')).toBe('# kickoff\n\n');
  });

  it('creates missing parents, seeds a resolvable title, and reports path + root (R-1.9, R-1.10)', async () => {
    const store = writeStore();
    const res = await create(store, 'notes/2026/kickoff.md');

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ path: 'notes/2026/kickoff.md', root: store.resolve('.') });

    const dirs = await snapshot(base);
    expect(Object.keys(dirs)).toContain('/notes/');
    expect(Object.keys(dirs)).toContain('/notes/2026/');

    const content = await readFile(join(base, 'notes', '2026', 'kickoff.md'), 'utf8');
    expect(content).toBe('# kickoff\n\n');
    expect(titleFromMarkdown(content, 'fallback')).toBe('kickoff');

    expect(store.invalidations).toBe(1); // R-3.1
  });

  it('answers exactly one 200 and one 409 for two concurrent creates of the same path (R-1.8)', async () => {
    const store = writeStore();
    const results = await Promise.all([create(store, 'race.md'), create(store, 'race.md')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('leaves an existing file byte-identical and answers 409 naming it (R-1.7)', async () => {
    await writeFile(join(base, 'kickoff.md'), '# hand written\n\nbody\n');
    const res = await create(writeStore(), 'kickoff.md');

    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toContain('kickoff.md');
    expect(await readFile(join(base, 'kickoff.md'), 'utf8')).toBe('# hand written\n\nbody\n');
  });

  it('refuses every write when the store cannot resolve one', async () => {
    const real = treeStore(base);
    const noWrites: FileWriteStore = { resolve: (p) => real.resolve(p) };
    const res = await create(noWrites, 'a.md');
    expect(res.status).toBe(500);
    expect(await readdir(base)).toEqual([]);
  });
});

describe('rename — refusals', () => {
  it('answers 404 for a missing from and touches nothing (R-2.3)', async () => {
    await writeFile(join(base, 'kept.md'), '# kept\n');
    const before = await snapshot(base);

    const res = await rename(writeStore(), 'gone.md', 'other.md');

    expect(res.status).toBe(404);
    expect(await snapshot(base)).toEqual(before);
  });

  it('answers 400 for a directory from and touches nothing (R-2.10)', async () => {
    await mkdir(join(base, 'notes'));
    const before = await snapshot(base);

    const res = await rename(writeStore(), 'notes', 'archive');

    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/director/);
    expect(await snapshot(base)).toEqual(before);
  });

  it('applies the extension rule to `to` and the escape guard to both (R-2.2)', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    const before = await snapshot(base);
    const store = writeStore();

    expect((await rename(store, 'a.md', 'b.txt')).status).toBe(400);
    expect((await rename(store, 'a.md', '../b.md')).status).toBe(400);
    expect((await rename(store, '../a.md', 'b.md')).status).toBe(400);

    expect(await snapshot(base)).toEqual(before);
  });
});

describe('rename — the move', () => {
  it('carries the original bytes to the new path and removes the old one (R-2.8)', async () => {
    await writeFile(join(base, 'a.md'), '# a\n\noriginal body\n');
    const store = writeStore();

    const res = await rename(store, 'a.md', 'b.md');

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ path: 'b.md' });
    expect(await readFile(join(base, 'b.md'), 'utf8')).toBe('# a\n\noriginal body\n');
    expect(await readdir(base)).toEqual(['b.md']);
    expect(store.invalidations).toBe(1);
  });

  it('answers 409 and leaves both files byte-identical when `to` exists (R-2.4)', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    await writeFile(join(base, 'c.md'), '# c\n');
    const before = await snapshot(base);

    const res = await rename(writeStore(), 'a.md', 'c.md');

    expect(res.status).toBe(409);
    expect(await snapshot(base)).toEqual(before);
  });

  it('never reaches for fs.rename, which overwrites silently (R-2.5)', async () => {
    const src = await readFile(fileURLToPath(new URL('./files.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/\brename\s*\(/); // no bare rename() call — renameFile( does not match
    expect(src).not.toMatch(/\.rename(Sync)?\s*\(/);
    const imports = src.match(/from 'node:fs[^']*'/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of src.split('\n').filter((l) => l.includes("from 'node:fs"))) {
      expect(line).not.toMatch(/[{,]\s*rename\s*[,}]/);
    }
  });
});

describe('rename — the review moves with the document', () => {
  it('rewrites only the records pinned to `from`, preserving every other field (R-2.6, R-2.7)', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    const doc: CommentDoc = {
      version: 1,
      comments: [
        {
          id: 'c-00000001',
          workflow: 'visual-spec',
          target: { path: 'a.md', kind: 'range', startLine: 3, endLine: 5, snippet: 'the line', heading: 'Intro' },
          comment: 'tighten this',
          selectedContent: 'the line and the next',
          status: 'open',
          ts: 'T0',
        },
        {
          id: 'c-00000002',
          workflow: 'architecture-review',
          target: { path: 'a.md', kind: 'file' },
          comment: 'needs an owner',
          status: 'applied',
          result: 'assigned to the platform team',
          ts: 'T1',
        },
        {
          id: 'c-00000003',
          workflow: 'visual-spec',
          target: { path: 'other.md', kind: 'file' },
          comment: 'leave me alone',
          status: 'open',
          ts: 'T2',
        },
      ],
    };
    const comments = memoryComments(doc);
    const untouchedBefore = JSON.stringify(doc.comments[2]);

    const res = await rename(writeStore(), 'a.md', 'b.md', comments);
    expect(res.status).toBe(200);

    const [moved, applied, untouched] = comments.doc.comments;
    expect(moved).toEqual({
      id: 'c-00000001',
      workflow: 'visual-spec',
      target: { path: 'b.md', kind: 'range', startLine: 3, endLine: 5, snippet: 'the line', heading: 'Intro' },
      comment: 'tighten this',
      selectedContent: 'the line and the next',
      status: 'open',
      ts: 'T0',
    });
    expect(applied).toEqual({
      id: 'c-00000002',
      workflow: 'architecture-review',
      target: { path: 'b.md', kind: 'file' },
      comment: 'needs an owner',
      status: 'applied',
      result: 'assigned to the platform team',
      ts: 'T1',
    });
    expect(JSON.stringify(untouched)).toBe(untouchedBefore);
  });

  it('leaves the sidecar alone when the move fails', async () => {
    await writeFile(join(base, 'a.md'), '# a\n');
    await writeFile(join(base, 'c.md'), '# c\n');
    const comments = memoryComments({
      version: 1,
      comments: [
        { id: 'c-00000004', workflow: 'visual-spec', target: { path: 'a.md', kind: 'file' }, comment: 'x', status: 'open', ts: 'T0' },
      ],
    });
    const before = JSON.stringify(comments.doc);

    expect((await rename(writeStore(), 'a.md', 'c.md', comments)).status).toBe(409);
    expect(JSON.stringify(comments.doc)).toBe(before);
  });
});

describe('the surface of handleFilesRequest', () => {
  it('exposes create and rename and nothing else (R-2.9)', async () => {
    const store = writeStore();
    const comments = memoryComments();
    await writeFile(join(base, 'a.md'), '# a\n');

    for (const [method, pathname] of [
      ['POST', '/delete'],
      ['DELETE', '/a.md'],
      ['POST', '/remove'],
      ['POST', '/move'],
      ['GET', '/create'],
      ['GET', '/rename'],
      ['POST', ''],
    ] as const) {
      const res = await handleFilesRequest(store, comments, method, pathname, { path: 'a.md', from: 'a.md', to: 'b.md' });
      expect(res.status, `${method} ${pathname}`).toBe(404);
    }

    // Unchanged: no unrouted method reached the filesystem.
    expect(await readdir(base)).toEqual(['a.md']);
  });

  it('keeps the only unlink as the source-removal half of rename', async () => {
    const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'files.ts'), 'utf8');
    expect(src.match(/\bunlink\s*\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/\brm\s*\(|\brmdir\s*\(|\bunlinkSync\s*\(/);
  });
});
