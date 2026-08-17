/**
 * record-store.test.ts — where a collaboration document lives locally.
 *
 * The claim under test is the one the rest of the collaboration layer rests on: the
 * Markdown is a real file at `<baseDir>/<documentPath>`, not a field inside a sidecar.
 * That is what lets the apply agent — spawned with `baseDir` as its cwd and handed
 * `documentPath` — open the file under review (`core/bundle-guard.test.ts` pins the
 * pairing in both hosts). A store that kept the bytes anywhere else would send it to a
 * file that is not there.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCollaborationRecord, titleFromMarkdown } from './document-record';
import { DEFAULT_META_DIR, fsCollaborationStore } from './record-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vs-record-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (over: Record<string, unknown> = {}) => ({
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'Spec',
  markdown: '# Spec\n\nhello\n',
  ...over,
});

describe('the Markdown is a file in the tree, at its own path', () => {
  it('writes the bytes to <baseDir>/<documentPath>, verbatim', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record());
    expect(await readFile(join(dir, 'docs/spec.md'), 'utf8')).toBe('# Spec\n\nhello\n');
  });

  it('keeps the bookkeeping in a sidecar, with no copy of the content in it', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record({ github: { owner: 'acme', repo: 'docs', branch: 'vs/doc-1', pullNumber: 7, resolved: false } }));
    const meta = JSON.parse(await readFile(join(dir, DEFAULT_META_DIR, 'doc-1.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toEqual({
      documentId: 'doc-1',
      documentPath: 'docs/spec.md',
      title: 'Spec',
      github: { owner: 'acme', repo: 'docs', branch: 'vs/doc-1', pullNumber: 7, resolved: false },
    });
    // R-0.2 — no parallel representation of the document, not even a cached copy of it.
    expect(meta).not.toHaveProperty('markdown');
  });

  it('reads back what it wrote, both halves', async () => {
    const store = fsCollaborationStore(dir);
    const written = record({ github: { owner: 'acme', repo: 'docs', branch: 'b', resolved: false } });
    await store.write(written);
    expect(await store.read('doc-1')).toEqual(written);
  });

  /*
   * The whole point of the layout: an agent edits the `.md` in place and the next read
   * sees it. Under the retired JSON format the local copy lived at a path of the store's
   * own choosing, so the agent had to be told a different path from the one on the branch.
   */
  it('sees an edit made to the file directly — which is how the apply agent works', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record());
    await writeFile(join(dir, 'docs/spec.md'), '# Spec\n\nrewritten by the agent\n', 'utf8');
    expect((await store.read('doc-1'))?.markdown).toBe('# Spec\n\nrewritten by the agent\n');
  });

  it('an absent document reads as null, not as a throw', async () => {
    expect(await fsCollaborationStore(dir).read('doc-nope')).toBeNull();
  });

  /* `open` writes the sidecar and the file together, but a half-written pair must render. */
  it('a record whose file is missing reads as an empty document', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record());
    await rm(join(dir, 'docs/spec.md'));
    expect((await store.read('doc-1'))?.markdown).toBe('');
  });
});

describe('listing', () => {
  it('lists the ids in the sidecar directory, sorted, and nothing else', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record({ documentId: 'zeta', documentPath: 'z.md' }));
    await store.write(record({ documentId: 'alpha', documentPath: 'a.md' }));
    await mkdir(join(dir, DEFAULT_META_DIR), { recursive: true });
    await writeFile(join(dir, DEFAULT_META_DIR, 'notes.txt'), 'not a document', 'utf8');
    expect(await store.list()).toEqual(['alpha', 'zeta']);
  });

  it('an absent directory lists as empty', async () => {
    expect(await fsCollaborationStore(dir).list()).toEqual([]);
  });
});

describe('both identifiers are untrusted, and both are checked', () => {
  it('refuses a documentId that is not a single path segment', async () => {
    const store = fsCollaborationStore(dir);
    await expect(store.read('../../etc/passwd')).rejects.toThrow(/invalid documentId/);
    await expect(store.write(record({ documentId: 'a/b' }))).rejects.toThrow(/invalid documentId/);
  });

  it('refuses a documentPath that would escape the content directory', async () => {
    const store = fsCollaborationStore(dir);
    await expect(store.write(record({ documentPath: '../escaped.md' }))).rejects.toThrow(/invalid documentPath/);
    await expect(store.write(record({ documentPath: '/etc/passwd' }))).rejects.toThrow(/invalid documentPath/);
  });

  it('allows an ordinary nested path', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record({ documentPath: 'a/b/c/spec.md' }));
    expect(await readFile(join(dir, 'a/b/c/spec.md'), 'utf8')).toBe('# Spec\n\nhello\n');
  });
});

describe('titles come out of the bytes, because there is nowhere else', () => {
  it('takes the first heading', () => {
    expect(titleFromMarkdown('\n\n## Payment rules\n\ntext\n', 'doc-1')).toBe('Payment rules');
  });

  it('falls back when there is no heading at all', () => {
    expect(titleFromMarkdown('just prose\n', 'doc-1')).toBe('doc-1');
  });

  it('a new record with no title is named by its id', () => {
    expect(newCollaborationRecord({ documentId: 'doc-1', documentPath: 'a.md' })).toEqual({
      documentId: 'doc-1',
      documentPath: 'a.md',
      title: 'doc-1',
      markdown: '',
    });
  });
});

/*
 * R-8.29 — companion files travel with the document, and the store treats them exactly
 * as it treats the document: bytes at their own path in the tree, paths in the sidecar.
 *
 * The claim that matters is the *asymmetry that is not there*. If companions were held
 * as content inside the sidecar, the tree and the record would hold two copies of one
 * file, the apply agent would edit the tree's, and the next commit would send the
 * sidecar's — silently discarding the work. So these pin bytes-on-disk, paths-in-meta.
 */
describe('companion files are files, on the same terms as the document', () => {
  const withCompanions = () =>
    record({
      companions: [
        { path: 'docs/rules.md', markdown: '# Rules\n' },
        { path: 'notes/context.md', markdown: '# Context\n' },
      ],
    });

  it('writes each companion to its own path in the tree', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(withCompanions());
    expect(await readFile(join(dir, 'docs/rules.md'), 'utf8')).toBe('# Rules\n');
    expect(await readFile(join(dir, 'notes/context.md'), 'utf8')).toBe('# Context\n');
  });

  it('keeps only the paths in the sidecar, never the bytes', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(withCompanions());
    const raw = await readFile(join(dir, DEFAULT_META_DIR, 'doc-1.json'), 'utf8');
    expect(JSON.parse(raw).companions).toEqual([{ path: 'docs/rules.md' }, { path: 'notes/context.md' }]);
    expect(raw).not.toContain('# Rules');
  });

  it('reads the bytes back from the tree, so an edit on disk is what comes out', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(withCompanions());
    // The apply agent's edit: the file changes, the sidecar does not.
    await writeFile(join(dir, 'docs/rules.md'), '# Rules\n\nedited by the agent\n', 'utf8');

    const read = await store.read('doc-1');
    expect(read?.companions).toEqual([
      { path: 'docs/rules.md', markdown: '# Rules\n\nedited by the agent\n' },
      { path: 'notes/context.md', markdown: '# Context\n' },
    ]);
  });

  it('reads a companion whose file has gone as empty, rather than failing the document', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record({ companions: [{ path: 'docs/rules.md', markdown: '# Rules\n' }] }));
    await rm(join(dir, 'docs/rules.md'));

    const read = await store.read('doc-1');
    expect(read?.markdown).toBe('# Spec\n\nhello\n');
    expect(read?.companions).toEqual([{ path: 'docs/rules.md', markdown: '' }]);
  });

  it('says nothing about companions when there are none', async () => {
    const store = fsCollaborationStore(dir);
    await store.write(record());
    const meta = JSON.parse(await readFile(join(dir, DEFAULT_META_DIR, 'doc-1.json'), 'utf8'));
    expect('companions' in meta).toBe(false);
    expect((await store.read('doc-1'))?.companions).toBeUndefined();
  });

  /* R-8.32 — the containment rule is the document's, applied to every file. */
  it('refuses a companion path that would escape the content directory', async () => {
    const store = fsCollaborationStore(dir);
    await expect(store.write(record({ companions: [{ path: '../escaped.md', markdown: 'x' }] }))).rejects.toThrow(
      /invalid documentPath/,
    );
  });
});
