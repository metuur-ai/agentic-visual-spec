import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
