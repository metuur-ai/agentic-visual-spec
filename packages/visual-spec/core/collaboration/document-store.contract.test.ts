/**
 * document-store.contract.test.ts — ONE suite, run against BOTH `DocumentStore`
 * implementations (R-3.5 local, R-3.6 GitHub).
 *
 * This file is the actual proof that the routes are backend-agnostic. A GitHub store
 * that merely compiles against the interface is not interchangeable with the local one;
 * a GitHub store that passes the same behavioural suite is. Every test below is written
 * once and executed twice, so a divergence — a throw where the other returns `null`, a
 * different `list()` ordering, a lost unknown field — fails here rather than in a route
 * that silently behaves differently in collaboration mode.
 *
 * The GitHub backend runs against the real `createGitHubAdapter` driven by a fake `gh`
 * executor holding an in-memory branch (R-4.8 / R-12.3). No network, no live repo, no
 * git subprocess — the fake speaks only the Contents API endpoints the store uses.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationDocument } from './document-protocol';
import { type DocumentStore, fsDocumentStore } from './document-store';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor } from './github-executor';
import { githubDocumentStore } from './github-document-store';

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

/**
 * A fake `gh` speaking the Contents API against an in-memory branch. It answers only
 * what the store asks for: GET a file, GET a directory, PUT a file. Anything else is a
 * 404, so a store that reached for another endpoint would fail loudly here.
 */
function fakeGhBranch(): GhExecutor {
  const files = new Map<string, { content: string; sha: string }>();
  let nextSha = 0;
  const fail = (status: number, message: string) => ({
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
    exitCode: 1,
  });

  return async (args, input) => {
    const method = args[args.indexOf('--method') + 1];
    const endpoint = (args[args.length - (input === undefined ? 1 : 3)] ?? '').replace(/\?.*$/, '');
    const path = /^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/.exec(endpoint)?.[1];
    if (path === undefined) return fail(404, 'Not Found');

    if (method === 'GET') {
      const hit = files.get(path);
      if (hit) {
        const body = { path, sha: hit.sha, type: 'file', content: Buffer.from(hit.content, 'utf8').toString('base64') };
        return { stdout: JSON.stringify(body), stderr: '', exitCode: 0 };
      }
      const children = [...files.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map(([p, f]) => ({ name: p.slice(path.length + 1), path: p, sha: f.sha, type: 'file' }));
      if (children.length === 0) return fail(404, 'Not Found');
      return { stdout: JSON.stringify(children), stderr: '', exitCode: 0 };
    }

    if (method === 'PUT') {
      const body = JSON.parse(input ?? '{}') as { content: string; sha?: string };
      const existing = files.get(path);
      // The two answers `write()` must translate into a conflict.
      if (existing && !body.sha) return fail(422, 'Invalid request. "sha" wasn\'t supplied.');
      if (existing && body.sha !== existing.sha) return fail(409, `${path} does not match ${body.sha}`);
      const sha = `sha${(nextSha += 1)}`;
      files.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return {
        stdout: JSON.stringify({ content: { path, sha }, commit: { sha: `commit${nextSha}` } }),
        stderr: '',
        exitCode: 0,
      };
    }

    return fail(404, 'Not Found');
  };
}

type Backend = { name: string; make(): Promise<DocumentStore>; cleanup(): Promise<void> };

let tempDir = '';

const backends: Backend[] = [
  {
    name: 'fsDocumentStore (R-3.5)',
    async make() {
      tempDir = await mkdtemp(join(tmpdir(), 'vs-store-contract-'));
      return fsDocumentStore(tempDir);
    },
    async cleanup() {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    },
  },
  {
    name: 'githubDocumentStore (R-3.6)',
    async make() {
      return githubDocumentStore(createGitHubAdapter(fakeGhBranch()), {
        repo: { owner: 'acme', repo: 'docs' },
        branch: 'vs/collab',
      });
    },
    async cleanup() {
      /* in-memory; the executor is discarded with the store */
    },
  },
];

for (const backend of backends) {
  describe(`DocumentStore contract — ${backend.name}`, () => {
    let store: DocumentStore;

    beforeEach(async () => {
      store = await backend.make();
    });
    afterEach(async () => {
      await backend.cleanup();
    });

    // R-3.1 — read / write.
    it('writes then reads a document back', async () => {
      await store.write(doc());
      const back = await store.read('d-11112222');
      expect(back?.documentId).toBe('d-11112222');
      expect(back?.documentPath).toBe('docs/tasks/post-it-notes.md');
      expect(back?.nodes).toHaveLength(1);
    });

    // R-3.8 / R-3.1 — a missing document reads as `null`, it does not throw. Both
    // backends have to agree on this: it is the branch every caller writes first.
    it('reads an unknown document as null instead of throwing', async () => {
      await expect(store.read('d-nope')).resolves.toBeNull();
    });

    // R-3.1 — a second write replaces the first. On GitHub this is the read-before-write
    // path picking up the current blob sha; on disk it is a plain overwrite.
    it('overwrites an existing document on a second write', async () => {
      await store.write(doc());
      await store.write(doc({ title: 'Renamed' }));
      expect((await store.read('d-11112222'))?.title).toBe('Renamed');
    });

    // R-3.1 — list.
    it('lists every persisted documentId, sorted', async () => {
      await store.write(doc({ documentId: 'd-bbb' }));
      await store.write(doc({ documentId: 'd-aaa' }));
      await expect(store.list()).resolves.toEqual(['d-aaa', 'd-bbb']);
    });

    it('lists nothing when no document has ever been written', async () => {
      await expect(store.list()).resolves.toEqual([]);
    });

    // R-2.1 / R-1.8 — unknown envelope and node fields survive the store layer, on both
    // backends, because both persist through the 1.1 parse/serialize helpers.
    it('round-trips unknown envelope and node fields', async () => {
      const source = doc() as CollaborationDocument & { experimentalFlag?: unknown };
      source.experimentalFlag = { kept: true };
      source.nodes = [{ id: 'n-1', type: 'paragraph', version: 1, content: 'hi', futureField: [1, 2] }];
      (source.doc.root.children as Record<string, unknown>[])[0].unknownNodeKey = 'survives';

      await store.write(source);
      const back = (await store.read('d-11112222')) as CollaborationDocument & { experimentalFlag?: unknown };

      expect(back.experimentalFlag).toEqual({ kept: true });
      expect(back.nodes[0].futureField).toEqual([1, 2]);
      expect(back.doc).toEqual(source.doc);
    });

    // R-3.4 — a nodeId resolves to a structural path plus the node itself.
    it('resolves a nodeId to its path in doc.root and the node', async () => {
      await store.write(doc());
      const hit = await store.resolveNode('d-11112222', 'n-1');
      expect(hit.found).toBe(true);
      if (!hit.found) return;
      expect(hit.path).toEqual([1]);
      expect(hit.node.type).toBe('paragraph');
    });

    // R-3.8 — an unresolved nodeId is reported, never thrown.
    it('reports an unknown nodeId as unresolved instead of throwing', async () => {
      await store.write(doc());
      await expect(store.resolveNode('d-11112222', 'n-ghost')).resolves.toEqual({ found: false });
    });

    // R-3.8 — same report when the document itself is absent.
    it('reports unresolved when the document itself is missing', async () => {
      await expect(store.resolveNode('d-missing', 'n-1')).resolves.toEqual({ found: false });
    });

    // R-3.5 / R-3.6 — the id is one path segment on both backends, so it can escape
    // neither the documents directory nor the Contents endpoint.
    it('rejects a documentId that could traverse out of the documents dir', async () => {
      await expect(store.read('../../etc/passwd')).rejects.toThrow(/invalid documentId/);
    });

    // R-3.2 — neither implementation grows a Markdown surface.
    it('exposes no Markdown method', () => {
      expect(Object.keys(store).sort()).toEqual(['list', 'read', 'resolveNode', 'write']);
      for (const key of Object.keys(store)) expect(key).not.toMatch(/markdown|render|serializ/i);
    });
  });
}
