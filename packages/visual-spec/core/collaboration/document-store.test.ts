import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationDocument } from './document-protocol';
import { DOCUMENT_ID_RE, type DocumentStore, fsDocumentStore, localDocumentPath, resolveNodeIn } from './document-store';

const here = dirname(fileURLToPath(import.meta.url));

const doc = (over: Partial<CollaborationDocument> = {}): CollaborationDocument => ({
  documentId: 'd-11112222',
  documentPath: 'docs/tasks/post-it-notes.md',
  title: 'Post-it Notes',
  frontmatter: { status: 'draft' },
  nodes: [{ id: 'n-1', type: 'paragraph', version: 1, content: 'The user can pin a note' }],
  doc: {
    root: {
      type: 'root',
      children: [
        { id: 'n-0', type: 'heading', tag: 'h1', children: [] },
        {
          id: 'n-1',
          type: 'paragraph',
          children: [{ id: 'n-1-a', type: 'text', text: 'The user can pin a note' }],
        },
      ],
    },
  },
  ...over,
});

let base: string;
let store: DocumentStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vs-document-store-'));
  store = fsDocumentStore(base);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('DocumentStore', () => {
  // R-3.1 — read / write / list.
  it('writes then reads a document back (R-3.1)', async () => {
    await store.write(doc());
    const back = await store.read('d-11112222');
    expect(back?.documentId).toBe('d-11112222');
    expect(back?.documentPath).toBe('docs/tasks/post-it-notes.md');
    expect(back?.nodes).toHaveLength(1);
  });

  // R-3.1 — an absent document is `null`, not a throw, matching `GitHubAdapter.getFile`.
  it('reads an unknown document as null (R-3.1)', async () => {
    await expect(store.read('d-nope')).resolves.toBeNull();
  });

  // R-3.1 — list.
  it('lists every persisted documentId, sorted (R-3.1)', async () => {
    await store.write(doc({ documentId: 'd-bbb' }));
    await store.write(doc({ documentId: 'd-aaa' }));
    await expect(store.list()).resolves.toEqual(['d-aaa', 'd-bbb']);
  });

  it('lists nothing when no document has ever been written (R-3.1)', async () => {
    await expect(store.list()).resolves.toEqual([]);
  });

  // R-3.5 — local file-backed implementation at `documents/<documentId>.json`.
  it('stores at documents/<documentId>.json (R-3.5)', async () => {
    await store.write(doc());
    expect(await readdir(join(base, 'documents'))).toEqual(['d-11112222.json']);
    const raw = await readFile(join(base, 'documents', 'd-11112222.json'), 'utf8');
    expect(JSON.parse(raw).documentId).toBe('d-11112222');
  });

  // R-3.5 — the id is a single path segment, so it cannot escape the documents dir.
  it('rejects a documentId that could traverse out of the documents dir (R-3.5)', async () => {
    expect(DOCUMENT_ID_RE.test('../../etc/passwd')).toBe(false);
    await expect(store.read('../../etc/passwd')).rejects.toThrow(/invalid documentId/);
  });

  // R-2.1 — the canonical persisted form is the 1.1 envelope wrapping the Luthor
  // JsonDocument. Nothing here defines a node schema, and unknown fields (R-1.8)
  // survive the store layer because read/write go through the 1.1 helpers.
  it('round-trips unknown envelope and node fields through the store (R-2.1)', async () => {
    const source = doc() as CollaborationDocument & { experimentalFlag?: unknown };
    source.experimentalFlag = { kept: true };
    source.nodes = [{ id: 'n-1', type: 'paragraph', version: 1, content: 'hi', futureField: [1, 2] }];
    (source.doc.root.children as Record<string, unknown>[])[0].unknownNodeKey = 'survives';

    await store.write(source);
    const back = (await store.read('d-11112222')) as CollaborationDocument & { experimentalFlag?: unknown };

    expect(back.experimentalFlag).toEqual({ kept: true });
    expect(back.nodes[0].futureField).toEqual([1, 2]);
    expect((back.doc.root.children as Record<string, unknown>[])[0].unknownNodeKey).toBe('survives');
    expect(back.doc).toEqual(source.doc);
  });

  // R-3.4 — a nodeId resolves to a JSON location: structural path + the node itself.
  it('resolves a nodeId to its path in doc.root and the node (R-3.4)', async () => {
    await store.write(doc());
    const hit = await store.resolveNode('d-11112222', 'n-1');
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.path).toEqual([1]);
    expect(hit.node.type).toBe('paragraph');
  });

  // R-3.4 — the path indexes `children` at every level, so nested blocks resolve too.
  it('resolves a nested nodeId to a multi-segment path (R-3.4)', () => {
    const hit = resolveNodeIn(doc(), 'n-1-a');
    expect(hit).toMatchObject({ found: true, path: [1, 0] });
  });

  // R-3.8 — an unresolved nodeId is reported, not thrown.
  it('reports an unknown nodeId as unresolved instead of throwing (R-3.8)', async () => {
    await store.write(doc());
    await expect(store.resolveNode('d-11112222', 'n-ghost')).resolves.toEqual({ found: false });
    expect(resolveNodeIn(doc(), '')).toEqual({ found: false });
  });

  // R-3.8 — resolving against a document that does not exist is the same orphan report.
  it('reports unresolved when the document itself is missing (R-3.8)', async () => {
    await expect(store.resolveNode('d-missing', 'n-1')).resolves.toEqual({ found: false });
  });

  // R-3.2 — the store has NO Markdown surface. Markdown generation happens in the
  // browser (LLD §12), so the server never needs a serializer, and generated Markdown
  // is write-only (R-2.10) so nothing parses it back. Asserted on both the runtime
  // shape and the module's exported names so a Markdown method cannot grow back.
  it('exposes no Markdown method or field (R-3.2)', async () => {
    const markdownish = /markdown|render|serializ/i;
    for (const key of Object.keys(store)) expect(key).not.toMatch(markdownish);

    const module = await import('./document-store');
    for (const key of Object.keys(module)) expect(key).not.toMatch(markdownish);

    // Interface member names are erased at runtime, so read them off the declaration.
    const source = await readFile(join(here, 'document-store.ts'), 'utf8');
    const body = /export interface DocumentStore \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(body).not.toBe('');
    const members = [...body.matchAll(/^\s{2}(\w+)[(<]/gm)].map((m) => m[1]);
    expect(members).toEqual(['read', 'write', 'list', 'resolveNode']);
  });

  // R-3.7 — collaboration JSON is never routed through `SurfaceStore`, whose contract
  // assumes text. Asserted at the import level so the seam cannot be reintroduced.
  it('does not import surface-store (R-3.7)', async () => {
    const source = await readFile(join(here, 'document-store.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1]);
    // `./node-location` appears three times: the value import this module uses, plus the
    // two re-exports that keep `resolveNodeIn` / `NodeResolution` importable from here.
    // That module is deliberately pure — splitting it out is what let the browser bundle
    // reach `resolveNodeIn` without dragging `node:fs/promises` along (`ui/browser-safety.test.ts`).
    expect([...new Set(specifiers)]).toEqual(['node:fs/promises', 'node:path', './document-protocol', './node-location']);
    expect(specifiers.some((s) => s.includes('surface-store'))).toBe(false);
  });

  // R-3.5 — a hand-authored file on disk is readable without a prior write.
  it('reads a document written to disk out of band (R-3.5)', async () => {
    await mkdir(join(base, 'documents'), { recursive: true });
    await writeFile(join(base, 'documents', 'd-manual.json'), JSON.stringify(doc({ documentId: 'd-manual' })), 'utf8');
    const back = await store.read('d-manual');
    expect(back?.documentId).toBe('d-manual');
  });
});

/**
 * Seam guard: task 2.1 writes `nodeId` under the NodeState `$` key, not on a bare
 * `id`/`nodeId` field. `resolveNode` originally matched only the bare fields, so a
 * real editor-produced document resolved nothing. Pins the `$` read so the gap
 * cannot silently reopen.
 */
describe('resolveNodeIn — NodeState `$` key (task 2.1 seam)', () => {
  const withState = (): CollaborationDocument =>
    ({
        documentId: 'doc-1',
        documentPath: 'docs/a.md',
        title: 'A',
        frontmatter: {},
        nodes: [],
        doc: {
          root: {
            type: 'root',
            children: [
              { type: 'paragraph', version: 1, $: { nodeId: 'n-alpha' }, children: [] },
              {
                type: 'quote',
                version: 1,
                $: { nodeId: 'n-beta' },
                children: [{ type: 'paragraph', version: 1, $: { nodeId: 'n-gamma' }, children: [] }],
              },
            ],
          },
        },
    }) as unknown as CollaborationDocument;

  it('resolves an id carried under `$`, the shape a real editor emits', () => {
    const r = resolveNodeIn(withState(), 'n-alpha');
    expect(r.found).toBe(true);
    if (r.found) expect(r.path).toEqual([0]);
  });

  it('resolves a nested id carried under `$`', () => {
    const r = resolveNodeIn(withState(), 'n-gamma');
    expect(r.found).toBe(true);
    if (r.found) expect(r.path).toEqual([1, 0]);
  });

  it('still reports an unknown id as unresolved rather than throwing', () => {
    expect(resolveNodeIn(withState(), 'n-missing')).toEqual({ found: false });
  });
});

/*
 * The convention had one definition inline in `fsDocumentStore`, and then a second caller
 * appeared that must agree with it exactly: the prompt handing comments to an agent has to
 * name the file the agent will edit, and the agent runs with the store's base directory as
 * its cwd. The obvious field to reach for, `document.documentPath`, is the path on the
 * BRANCH — identical today only because the create form builds it the same way. These pin
 * that the store and the prompt derive from the same function, so they cannot drift.
 */
describe('localDocumentPath — one definition of where a document lives', () => {
  it('is the path fsDocumentStore actually writes to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vs-doc-path-'));
    const store = fsDocumentStore(dir);
    await store.write({
      documentId: 'guia',
      documentPath: 'a/completely/different/path.json',
      title: 'x',
      frontmatter: {},
      nodes: [],
      doc: { root: {} },
    } as CollaborationDocument);

    // Written where the convention says, NOT where `documentPath` claims.
    await expect(readFile(join(dir, localDocumentPath('guia')), 'utf8')).resolves.toContain('"documentId"');
    await rm(dir, { recursive: true, force: true });
  });

  it('honours a non-default documents directory', () => {
    expect(localDocumentPath('guia', 'specs')).toBe('specs/guia.json');
  });
});
