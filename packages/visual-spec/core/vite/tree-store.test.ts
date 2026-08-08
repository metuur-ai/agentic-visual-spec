import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectKind, treeStore } from './tree-store';

describe('detectKind', () => {
  it('classifies by extension and known basenames', () => {
    expect(detectKind('README.md')).toBe('markdown');
    expect(detectKind('logo.PNG')).toBe('image');
    expect(detectKind('login.ts')).toBe('code');
    expect(detectKind('notes.txt')).toBe('text');
    expect(detectKind('Dockerfile')).toBe('code');
    expect(detectKind('.gitignore')).toBe('text');
    expect(detectKind('LICENSE')).toBe('text'); // extensionless → text (NUL-sniffed on read)
    expect(detectKind('archive.zip')).toBe('binary');
  });
});

describe('treeStore', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-tree-'));
    await mkdir(join(base, 'src'), { recursive: true });
    await mkdir(join(base, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(base, 'secret'), { recursive: true });
    await writeFile(join(base, 'README.md'), '# hi');
    await writeFile(join(base, 'src', 'app.ts'), 'export const x = 1;');
    await writeFile(join(base, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');
    await writeFile(join(base, 'secret', 'keys.txt'), 'shh');
    await writeFile(join(base, 'visual-spec-comments.json'), '{"version":1,"comments":[]}');
    await writeFile(join(base, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(join(base, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    await writeFile(join(base, '.visualspecignore'), 'secret/\n');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('walks the tree, excluding built-ins and .visualspecignore entries', async () => {
    const paths = (await treeStore(base).tree()).map((e) => e.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('src');
    expect(paths).toContain('src/app.ts');
    // built-in excludes
    expect(paths).not.toContain('node_modules');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths).not.toContain('visual-spec-comments.json');
    // .visualspecignore exclude
    expect(paths.some((p) => p.startsWith('secret'))).toBe(false);
  });

  it('tags each entry with type and kind (size is fetched per-file, not walked)', async () => {
    const entries = await treeStore(base).tree();
    const app = entries.find((e) => e.path === 'src/app.ts')!;
    expect(app).toMatchObject({ type: 'file', kind: 'code' });
    expect(entries.find((e) => e.path === 'src')!.type).toBe('dir');
  });

  it('reports size when a file is opened', async () => {
    const f = await treeStore(base).file('src/app.ts');
    expect(f.size).toBeGreaterThan(0);
  });

  it('reads text content', async () => {
    const f = await treeStore(base).file('src/app.ts');
    expect(f).toMatchObject({ kind: 'code', content: 'export const x = 1;' });
  });

  it('returns metadata (no content) for images', async () => {
    const f = await treeStore(base).file('logo.png');
    expect(f).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect('content' in f).toBe(false);
  });

  it('downgrades NUL-containing files to binary', async () => {
    const f = await treeStore(base).file('data.bin');
    expect(f.kind).toBe('binary');
  });

  it('rejects path traversal', async () => {
    await expect(treeStore(base).file('../etc/passwd')).rejects.toThrow(/escapes base/);
    expect(() => treeStore(base).resolve('../../x')).toThrow(/escapes base/);
  });
});

describe('treeStore.resolveForWrite', () => {
  let base: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-write-'));
    outside = await mkdtemp(join(tmpdir(), 'vs-outside-'));
    await mkdir(join(base, 'notes'), { recursive: true });
    // A symlink *inside* base pointing out of it: the case the string-level guard
    // in resolve() cannot see.
    await symlink(outside, join(base, 'escape-link'), 'dir');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('rejects traversal', async () => {
    await expect(treeStore(base).resolveForWrite!('../escape.md')).rejects.toThrow(/escapes base/);
  });

  it('rejects absolute paths', async () => {
    await expect(treeStore(base).resolveForWrite!('/etc/passwd')).rejects.toThrow(/escapes base/);
  });

  it('rejects a target under a symlink that leaves base, without touching disk', async () => {
    await expect(treeStore(base).resolveForWrite!('escape-link/deep/pwned.md')).rejects.toThrow(
      /escapes base/,
    );
    // R-1.6: the refusal must land before any directory is created.
    expect(await readdir(outside)).toEqual([]);
  });

  it('returns a guarded absolute path for a legitimate nested target', async () => {
    const abs = await treeStore(base).resolveForWrite!('notes/2026/kickoff.md');
    expect(abs).toBe(join(base, 'notes', '2026', 'kickoff.md'));
    // Resolving does not create anything either.
    expect(await readdir(join(base, 'notes'))).toEqual([]);
  });
});

describe('treeStore.invalidate', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-invalidate-'));
    await writeFile(join(base, 'README.md'), '# hi');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('keeps serving the cached walk within the TTL when not invalidated', async () => {
    const store = treeStore(base);
    expect((await store.tree()).map((e) => e.path)).toEqual(['README.md']);
    await writeFile(join(base, 'stale.md'), '# stale');
    // Without invalidation the 3s TTL hides the new file — this is the guard that
    // makes the next test mean something.
    expect((await store.tree()).map((e) => e.path)).toEqual(['README.md']);
  });

  it('re-walks on the next tree() after invalidate()', async () => {
    const store = treeStore(base);
    await store.tree();
    await writeFile(join(base, 'fresh.md'), '# fresh');
    store.invalidate!();
    expect(await store.tree()).toContainEqual(
      expect.objectContaining({ path: 'fresh.md', type: 'file' }),
    );
  });
});
