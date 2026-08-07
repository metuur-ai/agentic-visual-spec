/**
 * github-document-store.test.ts — the GitHub-specific half of task 3.2 (R-3.6): which
 * endpoints the store chooses, how it obtains a blob sha, and what a lost race
 * surfaces as. Interface *parity* with the local store is proved separately, by the
 * shared suite in `document-store.contract.test.ts`.
 *
 * Everything here replays recorded `gh api` responses through the injectable executor
 * (R-4.8 / R-12.3). No live repo, no network, and no git subprocess anywhere on the
 * path — commits are Contents API `PUT`s (LLD Constraints).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CollaborationDocument } from './document-protocol';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor, GhResult } from './github-executor';
import { DocumentWriteConflictError, githubDocumentStore } from './github-document-store';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf8');

const repo = { owner: 'acme', repo: 'docs' };
const branch = 'vs/collab';

type Call = { args: string[]; input?: string };

/** Same recorded-response executor shape as `github-adapter.test.ts`. */
function recorder(responses: Array<Partial<GhResult>>): { exec: GhExecutor; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const r = responses[i++] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, calls };
}

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;

const store = (responses: Array<Partial<GhResult>>, documentsDir?: string) => {
  const { exec, calls } = recorder(responses);
  const config = { repo, branch, ...(documentsDir ? { documentsDir } : {}) };
  return { store: githubDocumentStore(createGitHubAdapter(exec), config), calls };
};

const doc: CollaborationDocument = {
  documentId: 'd-11112222',
  documentPath: 'docs/tasks/post-it-notes.md',
  title: 'Post-it Notes',
  frontmatter: { status: 'draft' },
  nodes: [{ id: 'n-1', type: 'paragraph', version: 1, content: 'hi' }],
  doc: { root: { type: 'root', children: [{ id: 'n-1', type: 'paragraph', children: [] }] } },
};

/** `contents-get.json` decodes to this document body. */
const notFound = { stdout: fixture('error-not-found.json'), exitCode: 1 };

describe('githubDocumentStore — read (R-3.6)', () => {
  it('reads documents/<id>.json from the PR branch through the Contents API', async () => {
    const { store: s, calls } = store([{ stdout: fixture('contents-get.json') }]);
    const back = await s.read('doc-1');

    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/contents/documents/doc-1.json?ref=vs/collab');
    expect(calls[0]?.args).toContain('GET');
    expect(back?.documentId).toBe('doc-1');
  });

  // R-3.8 / R-3.1 — an absent document is `null`, matching the local store.
  it('reads a missing document as null, not a throw', async () => {
    const { store: s } = store([notFound]);
    await expect(s.read('d-missing')).resolves.toBeNull();
  });

  it('scopes reads to a custom documents directory', async () => {
    const { store: s, calls } = store([{ stdout: fixture('contents-get.json') }], 'specs/collab');
    await s.read('doc-1');
    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/contents/specs/collab/doc-1.json?ref=vs/collab');
  });

  // The Contents endpoint is built from the id, so the id must not be able to shape it.
  it('rejects a documentId that could escape the documents directory', async () => {
    const { store: s, calls } = store([]);
    await expect(s.read('../../../etc/passwd')).rejects.toThrow(/invalid documentId/);
    expect(calls).toEqual([]);
  });
});

describe('githubDocumentStore — list (R-3.6)', () => {
  // The directory listing is the answer. No manifest file is read, written, or
  // consulted: GitHub is the system of record and a manifest would be a second one.
  it('lists documents from the Contents directory listing, sorted', async () => {
    const { store: s, calls } = store([{ stdout: fixture('contents-dir.json') }]);
    await expect(s.list()).resolves.toEqual(['d-aaa', 'd-bbb']);

    expect(calls).toHaveLength(1);
    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/contents/documents?ref=vs/collab');
    expect(calls.some((c) => JSON.stringify(c.args).includes('manifest'))).toBe(false);
  });

  it('ignores non-JSON files and subdirectories in the listing', async () => {
    const { store: s } = store([{ stdout: fixture('contents-dir.json') }]);
    const ids = await s.list();
    expect(ids).not.toContain('README');
    expect(ids).not.toContain('archive');
  });

  it('lists nothing when the documents directory does not exist on the branch', async () => {
    const { store: s } = store([notFound]);
    await expect(s.list()).resolves.toEqual([]);
  });
});

describe('githubDocumentStore — write (R-3.6)', () => {
  // Read-before-write: the Contents API needs the current blob sha to replace a file
  // and the store holds no cache, so it reads the path on the branch first.
  it('reads the current blob sha, then PUTs the update carrying it', async () => {
    const { store: s, calls } = store([{ stdout: fixture('contents-get.json') }, { stdout: fixture('contents-put.json') }]);
    await s.write(doc);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain('GET');
    expect(endpointOf(calls[1]?.args ?? [])).toBe('/repos/acme/docs/contents/documents/d-11112222.json');
    const body = JSON.parse(calls[1]?.input ?? '{}') as Record<string, string>;
    expect(body.sha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(body.branch).toBe('vs/collab');
    expect(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')).documentId).toBe('d-11112222');
  });

  // Create path: the read answered 404, so the PUT carries no `sha` at all.
  it('PUTs with no sha when the document does not yet exist on the branch', async () => {
    const { store: s, calls } = store([notFound, { stdout: fixture('contents-put.json') }]);
    await s.write(doc);

    const body = JSON.parse(calls[1]?.input ?? '{}') as Record<string, string>;
    expect('sha' in body).toBe(false);
    expect(body.message).toBe('docs: create d-11112222');
  });

  it('labels the commit as an update when the document already existed', async () => {
    const { store: s, calls } = store([{ stdout: fixture('contents-get.json') }, { stdout: fixture('contents-put.json') }]);
    await s.write(doc);
    expect((JSON.parse(calls[1]?.input ?? '{}') as Record<string, string>).message).toBe('docs: update d-11112222');
  });

  // R-8.x owns conflict STATES; the store's job is to make the race distinguishable.
  // A stale sha (409) surfaces as a typed DocumentWriteConflictError, never a generic
  // throw — the interface returns `void`, so a typed error is the only channel that
  // does not change the shape other tasks are building against.
  it('surfaces a stale-sha 409 as DocumentWriteConflictError, not a generic error', async () => {
    const { store: s } = store([
      { stdout: fixture('contents-get.json') },
      { stdout: fixture('error-sha-conflict.json'), stderr: 'gh: Conflict (HTTP 409)', exitCode: 1 },
    ]);

    const err = await s.write(doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentWriteConflictError);
    const conflict = err as DocumentWriteConflictError;
    expect(conflict.documentId).toBe('d-11112222');
    expect(conflict.path).toBe('documents/d-11112222.json');
    expect(conflict.branch).toBe('vs/collab');
    expect(conflict.expectedSha).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(conflict.cause.status).toBe(409);
  });

  // The create-side race: the read saw nothing, so no sha was sent, but the file now
  // exists. GitHub answers 422 "sha wasn't supplied" — the same lost race, reported
  // identically, with `expectedSha` undefined to record that it was a create.
  it('surfaces a create-race 422 as the same conflict, with no expectedSha', async () => {
    const { store: s } = store([
      notFound,
      { stdout: fixture('error-sha-missing.json'), stderr: 'gh: Unprocessable Entity (HTTP 422)', exitCode: 1 },
    ]);

    const err = await s.write(doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentWriteConflictError);
    expect((err as DocumentWriteConflictError).expectedSha).toBeUndefined();
  });

  // Anything that is not the race stays a GitHubError — the conflict type must not
  // become a catch-all that hides permission or validation failures.
  it('leaves a non-conflict failure as a GitHubError', async () => {
    const { store: s } = store([
      { stdout: fixture('contents-get.json') },
      { stdout: JSON.stringify({ message: 'Resource not accessible', status: '403' }), exitCode: 1 },
    ]);

    const err = await s.write(doc).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DocumentWriteConflictError);
    expect((err as Error).name).toBe('GitHubError');
  });

  // R-4.9 — the conflict message is built from an already-scrubbed GitHubError, so no
  // credential material can ride out on it.
  it('carries no credential material in the conflict message', async () => {
    const { store: s } = store([
      { stdout: fixture('contents-get.json') },
      {
        stdout: JSON.stringify({ message: 'sha mismatch; Authorization: ghp_abcdefghijklmnopqrstuvwxyz012345', status: '409' }),
        exitCode: 1,
      },
    ]);

    const err = (await s.write(doc).catch((e: unknown) => e)) as DocumentWriteConflictError;
    expect(err.message).not.toContain('ghp_');
    expect(err.message).toContain('[redacted]');
  });
});

describe('githubDocumentStore — resolveNode (R-3.4 / R-3.8)', () => {
  it('resolves a nodeId to its path inside the document read from the branch', async () => {
    const body = Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');
    const { store: s } = store([{ stdout: JSON.stringify({ path: 'x', sha: 's', content: body }) }]);

    const hit = await s.resolveNode('d-11112222', 'n-1');
    expect(hit).toMatchObject({ found: true, path: [0] });
  });

  it('reports an unresolved nodeId rather than throwing', async () => {
    const body = Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');
    const { store: s } = store([{ stdout: JSON.stringify({ path: 'x', sha: 's', content: body }) }]);
    await expect(s.resolveNode('d-11112222', 'n-ghost')).resolves.toEqual({ found: false });
  });

  it('reports unresolved when the document is missing from the branch', async () => {
    const { store: s } = store([notFound]);
    await expect(s.resolveNode('d-missing', 'n-1')).resolves.toEqual({ found: false });
  });
});

describe('githubDocumentStore — boundaries', () => {
  // R-3.2 — no Markdown anywhere in this implementation: no render, no serializer,
  // no `.md` path, and no export whose name suggests one.
  it('has no Markdown surface (R-3.2)', async () => {
    const module = await import('./github-document-store');
    for (const key of Object.keys(module)) expect(key).not.toMatch(/markdown|render|serializ/i);

    const source = readFileSync(`${here}github-document-store.ts`, 'utf8');
    // The one `serialize*` reference is the 1.1 envelope helper, which emits JSON.
    expect(source).not.toMatch(/\.md\b|jsonToMarkdown|markdownToInjectable|canonicalizeMarkdown/);
  });

  // R-3.7 — collaboration JSON is never routed through `SurfaceStore`, and LLD §7:
  // commits go through the Contents API, so no git subprocess may appear here.
  it('imports no surface-store and spawns no git (R-3.7)', () => {
    const source = readFileSync(`${here}github-document-store.ts`, 'utf8');
    const specifiers = [...source.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['./document-protocol', './document-store', './github-adapter']);
    expect(source).not.toMatch(/child_process|spawn\(|execFile|['"`]git['"`]/);
  });

  // Resolution is reused from 3.1, not reimplemented — two lookup implementations
  // would be two places for orphan handling to diverge.
  it('reuses resolveNodeIn and DOCUMENT_ID_RE from document-store', () => {
    const source = readFileSync(`${here}github-document-store.ts`, 'utf8');
    expect(source).toContain('resolveNodeIn');
    expect(source).toContain('DOCUMENT_ID_RE');
    expect(source).not.toMatch(/function resolveNodeIn|const DOCUMENT_ID_RE/);
  });
});
