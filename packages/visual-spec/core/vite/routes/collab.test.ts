/**
 * collab.test.ts — the `/__vs/collab/*` route family (task 7.2).
 *
 * REQUIREMENT IDs (docs/ears/github-pr-collaborative-documents.md)
 *   R-7.1  — the full route family exists and is reachable in both hosts
 *   R-7.2  — `/__vs/comments` semantics unchanged (asserted structurally here; the
 *            behavioural guard is `core/editing/local-mode.regression.test.ts`)
 *   R-7.5  — a collaborative comment is persisted against `nodeId`
 *   R-7.8  — no collaboration configuration → routes report unavailable, never 500
 *   R-8.4  — `GET /:id` is a recoverable status snapshot
 *   R-8.9  — publish requires `json` + `markdown` (see also R-12.7)
 *   R-9.13 — the request guard is registered ahead of the collab handler in both hosts
 *   R-9.16 — publish is exposed only because the guard is already in place
 *
 * No real network and no `gh`: the preflight, the document store, the comment store and
 * every job body are injected.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationDocument } from '../../collaboration/document-protocol';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { DocumentStore } from '../../collaboration/document-store';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { JobEvent, JobSync, SseSink } from '../../collaboration/job-hub';
import type { ResolvedVisualSpecConfig } from '../../config';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { type CollabAuthorizer, type CollabDeps, type CollabJobBodies, type CollabRouteResult, createCollabRoutes } from './collab';
import type { CommentDocStore } from './comments';

/** Test double for the cases that are not about gating; individual tests override it. */
const TEST_ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = (rel: string) => readFileSync(resolve(pkgRoot, rel), 'utf8');

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;

const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO } };
const DISABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: null };

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

function document(overrides: Partial<CollaborationDocument> = {}): CollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'docs/spec.md',
    title: 'Spec',
    frontmatter: {},
    nodes: [],
    doc: { root: {} },
    github: { owner: 'acme', repo: 'specs', branch: 'vs/doc-1', pullNumber: 7, resolved: false },
    ...overrides,
  };
}

function memoryDocuments(docs: CollaborationDocument[] = []): DocumentStore {
  const map = new Map(docs.map((d) => [d.documentId, d]));
  return {
    async read(id) {
      return map.get(id) ?? null;
    },
    async write(doc) {
      map.set(doc.documentId, doc);
    },
    async list() {
      return [...map.keys()].sort();
    },
    async resolveNode() {
      return { found: false };
    },
  };
}

/** A `CommentDocStore` with the intent methods, standing in for `githubCommentStore`. */
function memoryComments(seed: CommentRecord[] = []) {
  let comments = [...seed];
  let seq = 0;
  const store: CommentDocStore = {
    async read(): Promise<CommentDoc> {
      return { version: 1, comments };
    },
    async write(doc) {
      comments = [...doc.comments];
    },
    async addComment(record) {
      seq += 1;
      const saved = { ...record, id: `c-0000000${seq}` };
      comments = [...comments, saved];
      return saved;
    },
    async updateComment(id, patch) {
      const found = comments.find((c) => c.id === id);
      if (!found) return null;
      const next = { ...found, ...patch } as CommentRecord;
      comments = comments.map((c) => (c.id === id ? next : c));
      return next;
    },
    async deleteComment(id) {
      comments = comments.filter((c) => c.id !== id);
    },
  };
  return { store, all: () => comments };
}

/** An `SseSink` that records what the hub wrote. */
function sink() {
  const frames: (JobEvent | JobSync)[] = [];
  const state: { head: [number, Record<string, string>] | null } = { head: null };
  const s: SseSink = {
    writeHead(status: number, headers: Record<string, string>) {
      state.head = [status, headers as Record<string, string>];
    },
    write(chunk: string) {
      frames.push(JSON.parse(chunk.replace(/^data: /, '').trim()));
    },
    on() {},
    end() {},
    writableEnded: false,
  };
  return Object.assign(s, { frames, state });
}

function router(overrides: Partial<CollabDeps> = {}) {
  const documents = overrides.documents ?? (() => memoryDocuments([document()]));
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents,
    preflight: async () => OK_PREFLIGHT,
    authorize: TEST_ALLOW_ALL,
    ...overrides,
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  sse?: SseSink,
): Promise<CollabRouteResult> => r.handle({ method, pathname, query: {}, body, ...(sse ? { sse } : {}) });

/* ================================================================== *
 * R-7.8 — availability, and never a 500 when collaboration is off
 * ================================================================== */
describe('R-7.8 — collaboration availability', () => {
  it('reports not-configured when no collaboration block exists', async () => {
    const r = router({ config: () => DISABLED });
    const res = await call(r, 'GET', '');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ available: false, reason: 'not-configured' });
  });

  it('reports available with the repo and the authenticated login, and no credential', async () => {
    const res = await call(router(), 'GET', '');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ available: true, repo: { ...REPO }, login: 'octocat', scopes: ['repo'] });
    expect(JSON.stringify(res.json)).not.toMatch(/token|ghp_|secret/i);
  });

  it('surfaces a preflight failure as unavailable, not as an error', async () => {
    const r = router({
      preflight: async () => ({ available: false, reason: 'missing_scope', message: 'needs "repo"', missingScopes: ['repo'] }),
    });
    const res = await call(r, 'GET', '');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ available: false, reason: 'missing_scope', missingScopes: ['repo'] });
  });

  it('answers every GitHub-touching route 503 with the availability payload, never 500', async () => {
    const r = router({ config: () => DISABLED });
    const routes: [string, string, Record<string, unknown>][] = [
      ['POST', '/start', { documentId: 'doc-1', documentPath: 'a.md' }],
      ['POST', '/open', { documentId: 'doc-1', pullNumber: 7 }],
      ['POST', '/doc-1/sync', {}],
      ['POST', '/doc-1/publish', { json: {}, markdown: '# x' }],
      ['POST', '/doc-1/reconcile', {}],
      ['POST', '/doc-1/ready', {}],
      ['POST', '/doc-1/comments', { comment: 'hi' }],
      ['POST', '/doc-1/comments/c-00000001/reply', { comment: 'hi' }],
      ['PATCH', '/doc-1/comments/c-00000001', { comment: 'hi' }],
    ];
    for (const [method, path, body] of routes) {
      const res = await call(r, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.json).toMatchObject({ available: false, reason: 'not-configured' });
    }
  });

  it('probes the preflight once and reuses the answer', async () => {
    const preflight = vi.fn(async () => OK_PREFLIGHT);
    const r = router({ preflight });
    await call(r, 'GET', '');
    await call(r, 'GET', '');
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed preflight, so a transient failure does not pin every route to 503', async () => {
    // `preflightCollaboration` *resolves* `unavailable(...)` rather than rejecting, and
    // `classify` cannot tell a rate-limit 403 from a permissions 403 — so a single
    // throttled probe used to 503 every gated route for the life of the process.
    let fails = true;
    const preflight = vi.fn(
      async (): Promise<CollaborationPreflight> =>
        fails ? { available: false, reason: 'missing_scope', message: 'needs "repo"', missingScopes: ['repo'] } : OK_PREFLIGHT,
    );
    const r = router({ preflight });

    expect((await call(r, 'GET', '')).json).toMatchObject({ available: false, reason: 'missing_scope' });
    expect((await call(r, 'GET', '')).json).toMatchObject({ available: false, reason: 'missing_scope' });
    expect(preflight).toHaveBeenCalledTimes(2);

    fails = false;
    expect((await call(r, 'GET', '')).json).toMatchObject({ available: true, login: 'octocat' });
    expect(preflight).toHaveBeenCalledTimes(3);
  });

  it('reuses a successful preflight within the TTL and re-probes once it expires', async () => {
    const preflight = vi.fn(async () => OK_PREFLIGHT);
    let ms = 1_000;
    const r = router({ preflight, preflightTtlMs: 60_000, clock: () => ms });

    await call(r, 'GET', '');
    ms += 59_000;
    await call(r, 'GET', '');
    expect(preflight).toHaveBeenCalledTimes(1);

    ms += 2_000;
    await call(r, 'GET', '');
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it('re-probes immediately when the env credential changes, without waiting for the TTL', async () => {
    // U-6: keyed on owner/repo#base alone, a token swap kept resolving the *previous*
    // login out of the cache for the life of the entry. The clock never moves here.
    const preflight = vi.fn(async () => OK_PREFLIGHT);
    const env: Record<string, string | undefined> = { GH_TOKEN: 'token-one' };
    const r = router({ preflight, preflightTtlMs: 60_000, clock: () => 1_000, env });

    await call(r, 'GET', '');
    await call(r, 'GET', '');
    expect(preflight).toHaveBeenCalledTimes(1);

    env.GH_TOKEN = 'token-two';
    await call(r, 'GET', '');
    expect(preflight).toHaveBeenCalledTimes(2);

    // And the first credential's entry is still keyed separately, not clobbered.
    env.GH_TOKEN = 'token-one';
    await call(r, 'GET', '');
    expect(preflight).toHaveBeenCalledTimes(2);
  });
});

/* ================================================================== *
 * R-7.1 — the route family
 * ================================================================== */
describe('R-7.1 — POST /start', () => {
  it('starts a create job and hands the injected body its input', async () => {
    const create = vi.fn<CollabJobBodies['create']>(() => async () => {});
    const r = router({ bodies: { create } });
    const res = await call(r, 'POST', '/start', { documentId: 'doc-2', documentPath: 'docs/new.md', title: 'New', idempotencyKey: 'k1' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'create' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      documentId: 'doc-2',
      documentPath: 'docs/new.md',
      title: 'New',
      repo: { ...REPO },
      idempotencyKey: 'k1',
    });
  });

  it('rejects a missing or traversal documentId with 400', async () => {
    const r = router();
    expect((await call(r, 'POST', '/start', { documentPath: 'a.md' })).status).toBe(400);
    expect((await call(r, 'POST', '/start', { documentId: '../etc', documentPath: 'a.md' })).status).toBe(400);
    expect((await call(r, 'POST', '/start', { documentId: 'doc-1' })).status).toBe(400);
  });

  it('rejects a second job for the same document with 409', async () => {
    const r = router({ bodies: { create: () => () => new Promise<void>(() => {}) } });
    expect((await call(r, 'POST', '/start', { documentId: 'doc-1', documentPath: 'a.md' })).status).toBe(200);
    expect((await call(r, 'POST', '/start', { documentId: 'doc-1', documentPath: 'a.md' })).status).toBe(409);
  });
});

describe('R-7.1 — POST /open', () => {
  it('starts a sync-kind job carrying the pull number', async () => {
    const open = vi.fn<CollabJobBodies['open']>(() => async () => {});
    const r = router({ bodies: { open } });
    const res = await call(r, 'POST', '/open', { documentId: 'doc-1', pullNumber: 42 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'sync' });
    expect(open.mock.calls[0]![0]).toMatchObject({ documentId: 'doc-1', pullNumber: 42 });
  });

  it('rejects a missing or non-integer pullNumber with 400', async () => {
    const r = router();
    expect((await call(r, 'POST', '/open', { documentId: 'doc-1' })).status).toBe(400);
    expect((await call(r, 'POST', '/open', { documentId: 'doc-1', pullNumber: '7' })).status).toBe(400);
    expect((await call(r, 'POST', '/open', { documentId: 'doc-1', pullNumber: 0 })).status).toBe(400);
  });
});

describe('R-7.1 / R-8.4 — GET /:id', () => {
  it('returns the job snapshot plus the stored document summary', async () => {
    const res = await call(router(), 'GET', '/doc-1');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      documentId: 'doc-1',
      state: 'draft',
      running: false,
      job: null,
      document: { documentId: 'doc-1', documentPath: 'docs/spec.md', title: 'Spec' },
    });
  });

  it('reports document: null for a document that has never been created', async () => {
    const res = await call(router(), 'GET', '/doc-unknown');
    expect(res.status).toBe(200);
    expect((res.json as { document: unknown }).document).toBeNull();
  });

  it('rejects an invalid documentId with 400 rather than letting the hub throw', async () => {
    const res = await call(router(), 'GET', '/..');
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toContain('invalid documentId');
  });
});

describe('R-7.1 / R-8.2 — GET /:id/events', () => {
  it('subscribes the response and marks the result streamed', async () => {
    const s = sink();
    const res = await call(router(), 'GET', '/doc-1/events', {}, s);
    expect(res.streamed).toBe(true);
    expect(s.state.head?.[0]).toBe(200);
    expect(s.state.head?.[1]['content-type']).toContain('text/event-stream');
    expect(s.frames[0]).toMatchObject({ type: 'sync', documentId: 'doc-1', state: 'draft' });
  });

  it('rejects with 400 when the host supplied no streaming sink', async () => {
    expect((await call(router(), 'GET', '/doc-1/events')).status).toBe(400);
  });
});

describe('R-7.1 / R-8.6 / R-8.7 — POST /:id/sync', () => {
  it('starts a sync job carrying the current document', async () => {
    const sync = vi.fn<CollabJobBodies['sync']>(() => async () => {});
    const r = router({ bodies: { sync } });
    const res = await call(r, 'POST', '/doc-1/sync', {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: 'sync' });
    expect(sync.mock.calls[0]![0]).toMatchObject({ documentId: 'doc-1', document: { documentPath: 'docs/spec.md' } });
  });
});

describe('R-8.18 / R-8.15 — the 8.4 recovery routes', () => {
  it('starts a reconcile job for the addressed document', async () => {
    const reconcile = vi.fn<CollabJobBodies['reconcile']>(() => async () => {});
    const res = await call(router({ bodies: { reconcile } }), 'POST', '/doc-1/reconcile', {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: 'reconcile' });
    expect(reconcile.mock.calls[0]![0]).toMatchObject({ documentId: 'doc-1', repo: { ...REPO } });
  });

  it('starts a ready job for the addressed document', async () => {
    const markReady = vi.fn<CollabJobBodies['markReady']>(() => async () => {});
    const res = await call(router({ bodies: { markReady } }), 'POST', '/doc-1/ready', {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: 'ready' });
    expect(markReady.mock.calls[0]![0]).toMatchObject({ documentId: 'doc-1', repo: { ...REPO } });
  });

  it('both are author-only: a refusing authorizer is honoured before the body runs', async () => {
    const reconcile = vi.fn<CollabJobBodies['reconcile']>(() => async () => {});
    const markReady = vi.fn<CollabJobBodies['markReady']>(() => async () => {});
    const r = router({
      bodies: { reconcile, markReady },
      authorize: (op) =>
        op === 'reconcile' || op === 'mark-ready' ? { ok: false, status: 403, error: 'author-only operation' } : { ok: true },
    });
    expect((await call(r, 'POST', '/doc-1/reconcile', {})).status).toBe(403);
    expect((await call(r, 'POST', '/doc-1/ready', {})).status).toBe(403);
    expect(reconcile).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
  });

  it('answers 503 with the availability payload when collaboration is off', async () => {
    const r = router({ config: () => DISABLED });
    for (const path of ['/doc-1/reconcile', '/doc-1/ready']) {
      const res = await call(r, 'POST', path, {});
      expect(res.status, path).toBe(503);
      expect(res.json).toMatchObject({ available: false, reason: 'not-configured' });
    }
  });
});

/* ================================================================== *
 * R-8.9 / R-12.7 — publish payload validation is route-layer
 * ================================================================== */
describe('R-8.9 / R-12.7 — publish payload validation', () => {
  it('rejects a payload missing json', async () => {
    const res = await call(router(), 'POST', '/doc-1/publish', { markdown: '# Title' });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe('missing json');
  });

  it('rejects a payload missing markdown', async () => {
    const res = await call(router(), 'POST', '/doc-1/publish', { json: { root: {} } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe('missing markdown');
  });

  it('rejects a non-string markdown', async () => {
    const res = await call(router(), 'POST', '/doc-1/publish', { json: { root: {} }, markdown: 42 });
    expect(res.status).toBe(400);
  });

  it('rejects an incomplete payload even with collaboration unconfigured — it is malformed, not unauthorized', async () => {
    const res = await call(router({ config: () => DISABLED }), 'POST', '/doc-1/publish', { markdown: '# x' });
    expect(res.status).toBe(400);
  });

  it('starts a publish job when both artifacts are present, passing the bytes through untouched', async () => {
    const publish = vi.fn<CollabJobBodies['publish']>(() => async () => {});
    const r = router({ bodies: { publish } });
    const res = await call(r, 'POST', '/doc-1/publish', { json: { root: { children: [] } }, markdown: '# Title\n' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: 'publish' });
    // R-8.12 — the Markdown reaches the body byte-for-byte; nothing parses or rewrites it.
    expect(publish.mock.calls[0]![0]).toMatchObject({ markdown: '# Title\n', json: { root: { children: [] } } });
  });

  it('accepts an empty markdown string — emptiness is the body’s business, presence is this layer’s', async () => {
    const publish = vi.fn<CollabJobBodies['publish']>(() => async () => {});
    const res = await call(router({ bodies: { publish } }), 'POST', '/doc-1/publish', { json: {}, markdown: '' });
    expect(res.status).toBe(200);
  });
});

/* ================================================================== *
 * R-7.5 — collaborative comments anchor on nodeId
 * ================================================================== */
describe('R-7.1 / R-7.5 — comment routes', () => {
  const withComments = (seed: CommentRecord[] = []) => {
    const mem = memoryComments(seed);
    return { mem, r: router({ commentStore: () => mem.store }) };
  };

  it('persists a comment against nodeId as its primary identity', async () => {
    const { mem, r } = withComments();
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'tighten this', nodeId: 'n-7' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, id: 'c-00000001' });
    const saved = mem.all()[0]! as CommentRecord & { collab?: { nodeId?: string } };
    expect(saved.collab?.nodeId).toBe('n-7');
    expect(saved.comment).toBe('tighten this');
    // R-1.7 — `CommentTarget` is unchanged, so the record stays a valid CommentRecord.
    expect(saved.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
  });

  it('accepts a document-level comment with no nodeId', async () => {
    const { mem, r } = withComments();
    expect((await call(r, 'POST', '/doc-1/comments', { comment: 'overall: good' })).status).toBe(200);
    expect((mem.all()[0] as { collab?: unknown }).collab).toBeUndefined();
  });

  it('rejects an empty comment with 400', async () => {
    const { r } = withComments();
    expect((await call(r, 'POST', '/doc-1/comments', {})).status).toBe(400);
    expect((await call(r, 'POST', '/doc-1/comments', { comment: '   ' })).status).toBe(400);
  });

  it('404s on an unknown document', async () => {
    const { r } = withComments();
    const res = await call(r, 'POST', '/doc-nope/comments', { comment: 'x' });
    expect(res.status).toBe(404);
  });

  it('409s when the document has no pull request yet', async () => {
    // No injected comment store: the default path derives one from the document's own
    // GitHub binding, and a document without one cannot host a conversation.
    const r = router({ documents: () => memoryDocuments([document({ github: undefined })]) });
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'x' });
    expect(res.status).toBe(409);
  });

  it('replies inherit the parent thread’s nodeId and record replyTo', async () => {
    const parent = {
      id: 'c-00000001',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'tighten this',
      status: 'open',
      ts: 'T0',
      collab: { nodeId: 'n-7' },
    } as unknown as CommentRecord;
    const { mem, r } = withComments([parent]);
    const res = await call(r, 'POST', '/doc-1/comments/c-00000001/reply', { comment: 'done' });
    expect(res.status).toBe(200);
    const saved = mem.all()[1]! as CommentRecord & { collab?: { nodeId?: string; replyTo?: string } };
    expect(saved.collab).toEqual({ replyTo: 'c-00000001', nodeId: 'n-7' });
  });

  it('404s a reply to an unknown comment and 400s a malformed commentId', async () => {
    const { r } = withComments();
    expect((await call(r, 'POST', '/doc-1/comments/c-deadbeef/reply', { comment: 'x' })).status).toBe(404);
    expect((await call(r, 'POST', '/doc-1/comments/nope/reply', { comment: 'x' })).status).toBe(400);
  });

  it('PATCH updates a comment and 404s an unknown one', async () => {
    const parent = {
      id: 'c-00000001',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'old',
      status: 'open',
      ts: 'T0',
    } as unknown as CommentRecord;
    const { mem, r } = withComments([parent]);
    const res = await call(r, 'PATCH', '/doc-1/comments/c-00000001', { comment: 'new', status: 'applied' });
    expect(res.status).toBe(200);
    expect(mem.all()[0]!.comment).toBe('new');
    expect(mem.all()[0]!.status).toBe('applied');
    expect((await call(r, 'PATCH', '/doc-1/comments/c-000000ff', { comment: 'x' })).status).toBe(404);
  });
});

/* ================================================================== *
 * R-7.3 / R-7.4 / R-5.7 / R-6.5 — the two read routes the UI mounts on
 * ================================================================== */
describe('GET /:id/document — the whole CollaborationDocument (R-7.3 / R-7.4)', () => {
  it('serves the full document, not the `GET /:id` summary', async () => {
    const node = { id: 'n-1', type: 'paragraph', version: 3, content: 'a claim' };
    const doc = document({ frontmatter: { status: 'draft' }, nodes: [node] });
    const r = router({ documents: () => memoryDocuments([doc]) });
    const res = await call(r, 'GET', '/doc-1/document');
    expect(res.status).toBe(200);
    expect(res.json).toEqual(doc);
    // The four fields `GET /:id` projects are not the whole story — these are the ones
    // it drops, and the reason this route exists.
    const body = res.json as CollaborationDocument;
    expect(body.doc).toEqual({ root: {} });
    expect(body.nodes).toEqual([node]);
    expect(body.frontmatter).toEqual({ status: 'draft' });
  });

  it('leaves `GET /:id` a summary — the SSE `sync` frame body must not grow', async () => {
    const res = await call(router(), 'GET', '/doc-1');
    expect(Object.keys((res.json as { document: object }).document).sort()).toEqual([
      'documentId',
      'documentPath',
      'github',
      'title',
    ]);
  });

  it('404s an unknown document, like its siblings', async () => {
    expect((await call(router(), 'GET', '/doc-nope/document')).status).toBe(404);
  });

  it('503s with the availability snapshot when collaboration is off (R-7.8)', async () => {
    const res = await call(router({ config: () => DISABLED }), 'GET', '/doc-1/document');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ available: false, reason: 'not-configured' });
  });

  it('is gated on `read` and answers the authorizer’s own verdict (R-9.8)', async () => {
    const seen: string[] = [];
    const deny: CollabAuthorizer = (op) => {
      seen.push(op);
      return { ok: false, status: 403, error: 'nope' };
    };
    const res = await call(router({ authorize: deny }), 'GET', '/doc-1/document');
    expect(seen).toEqual(['read']);
    expect(res).toEqual({ status: 403, json: { error: 'nope' } });
  });
});

describe('GET /:id/comments — the conversation (R-5.7 / R-6.5)', () => {
  const withComments = (seed: CommentRecord[] = []) => {
    const mem = memoryComments(seed);
    return { mem, r: router({ commentStore: () => mem.store }) };
  };

  it('round-trips what POST wrote: the records come back whole, in order', async () => {
    const { r } = withComments();
    await call(r, 'POST', '/doc-1/comments', { comment: 'tighten this', nodeId: 'n-7' });
    await call(r, 'POST', '/doc-1/comments', { comment: 'overall: good' });
    await call(r, 'POST', '/doc-1/comments/c-00000001/reply', { comment: 'done' });

    const res = await call(r, 'GET', '/doc-1/comments');
    expect(res.status).toBe(200);
    const listed = res.json as (CommentRecord & { collab?: Record<string, string> })[];
    expect(listed.map((c) => c.id)).toEqual(['c-00000001', 'c-00000002', 'c-00000003']);
    expect(listed.map((c) => c.comment)).toEqual(['tighten this', 'overall: good', 'done']);
    // R-7.5 — the anchor survives the read, which is the whole point for the panel.
    expect(listed[0]!.collab).toEqual({ nodeId: 'n-7' });
    // R-5.7 — the node-less comment is present, not discarded.
    expect(listed[1]!.collab).toBeUndefined();
    expect(listed[2]!.collab).toEqual({ replyTo: 'c-00000001', nodeId: 'n-7' });
    expect(listed[0]!.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
  });

  it('reflects a PATCH, so the panel and the store never disagree', async () => {
    const { r } = withComments();
    await call(r, 'POST', '/doc-1/comments', { comment: 'tighten this' });
    await call(r, 'PATCH', '/doc-1/comments/c-00000001', { status: 'applied', result: 'fixed' });
    const listed = (await call(r, 'GET', '/doc-1/comments')).json as CommentRecord[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe('applied');
  });

  it('answers an empty list, not a 404, when nothing has been said yet', async () => {
    const { r } = withComments();
    const res = await call(r, 'GET', '/doc-1/comments');
    expect(res).toEqual({ status: 200, json: [] });
  });

  it('404s an unknown document', async () => {
    const { r } = withComments();
    expect((await call(r, 'GET', '/doc-nope/comments')).status).toBe(404);
  });

  it('409s when the document has no pull request yet, like the POST route', async () => {
    const r = router({ documents: () => memoryDocuments([document({ github: undefined })]) });
    expect((await call(r, 'GET', '/doc-1/comments')).status).toBe(409);
  });

  it('503s when collaboration is off (R-7.8)', async () => {
    const res = await call(router({ config: () => DISABLED }), 'GET', '/doc-1/comments');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ available: false });
  });

  it('is gated on `read` and answers the authorizer’s own verdict (R-9.8)', async () => {
    const seen: string[] = [];
    const deny: CollabAuthorizer = (op) => {
      seen.push(op);
      return { ok: false, status: 401, error: 'who are you' };
    };
    const { mem } = withComments();
    const r = router({ commentStore: () => mem.store, authorize: deny });
    const res = await call(r, 'GET', '/doc-1/comments');
    expect(seen).toEqual(['read']);
    expect(res).toEqual({ status: 401, json: { error: 'who are you' } });
  });

  it('gates before it reads — a denied request never touches the store', async () => {
    const mem = memoryComments();
    const commentStore = vi.fn(async () => mem.store);
    const r = router({ commentStore, authorize: () => ({ ok: false, status: 403, error: 'nope' }) });
    await call(r, 'GET', '/doc-1/comments');
    expect(commentStore).not.toHaveBeenCalled();
  });
});

describe('unmatched routes', () => {
  it('404s an unknown path and an unsupported method', async () => {
    const r = router();
    expect((await call(r, 'GET', '/doc-1/nope')).status).toBe(404);
    expect((await call(r, 'DELETE', '/doc-1')).status).toBe(404);
    expect((await call(r, 'POST', '/doc-1/comments/c-00000001')).status).toBe(404);
  });
});

/* ================================================================== *
 * Job body injection — 8.2 / 8.3 have not landed yet
 * ================================================================== */
describe('the un-injected job bodies fail loudly rather than reporting success', () => {
  it('a stubbed create reports job-error over SSE, not job-done ok', async () => {
    const r = router();
    const s = sink();
    await call(r, 'GET', '/doc-1/events', {}, s);
    await call(r, 'POST', '/start', { documentId: 'doc-1', documentPath: 'a.md' });
    await new Promise((done) => setTimeout(done, 0));
    const kinds = s.frames.map((f) => f.type);
    expect(kinds).toContain('job-error');
    const doneFrame = s.frames.find((f) => f.type === 'job-done') as { ok: boolean } | undefined;
    expect(doneFrame?.ok).toBe(false);
  });
});

/* ================================================================== *
 * R-9.9 / R-9.10 — the seam task 9.2 fills in
 * ================================================================== */
describe('role-enforcement seam (task 9.2)', () => {
  it('an authorizer that refuses an operation is honoured before any store or job is touched', async () => {
    const publish = vi.fn<CollabJobBodies['publish']>(() => async () => {});
    const r = router({
      bodies: { publish },
      authorize: (op) => (op === 'publish' ? { ok: false, status: 403, error: 'author-only operation' } : { ok: true }),
    });
    const res = await call(r, 'POST', '/doc-1/publish', { json: {}, markdown: '# x' });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'author-only operation' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('every operation reaches the authorizer with the document it applies to', async () => {
    const seen: string[] = [];
    const mem = memoryComments();
    const r = router({
      commentStore: () => mem.store,
      bodies: {
        create: () => async () => {},
        open: () => async () => {},
        sync: () => async () => {},
        publish: () => async () => {},
        reconcile: () => async () => {},
        markReady: () => async () => {},
      },
      authorize: (op, ctx) => {
        seen.push(`${op}:${ctx.documentId}`);
        return { ok: true };
      },
    });
    await call(r, 'POST', '/start', { documentId: 'doc-2', documentPath: 'a.md' });
    await call(r, 'POST', '/open', { documentId: 'doc-3', pullNumber: 1 });
    await call(r, 'POST', '/doc-1/sync');
    await call(r, 'POST', '/doc-1/publish', { json: {}, markdown: '' });
    await call(r, 'POST', '/doc-1/comments', { comment: 'x' });
    await call(r, 'POST', '/doc-1/reconcile', {});
    await call(r, 'POST', '/doc-1/ready', {});
    expect(seen).toEqual([
      'create:doc-2',
      'open:doc-3',
      'sync:doc-1',
      'publish:doc-1',
      'comment:doc-1',
      'reconcile:doc-1',
      'mark-ready:doc-1',
    ]);
  });
});

/* ================================================================== *
 * R-7.2 — the local comment path is not on this route's wire
 * ================================================================== */
describe('R-7.2 — /__vs/comments is untouched', () => {
  it('the collab router never calls handleCommentsRequest nor builds the sidecar store', () => {
    // Code, not prose: the doc comment above `createCollabRoutes` names both on purpose.
    const code = src('core/vite/routes/collab.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code).not.toContain('handleCommentsRequest');
    expect(code).not.toContain('fileCommentStore');
    expect(code).not.toContain('/__vs/comments');
  });

  it('routes/comments.ts declares no collaboration route', () => {
    const text = src('core/vite/routes/comments.ts');
    expect(text).not.toContain('/__vs/collab');
    expect(text).not.toContain('collab');
  });
});

/* ================================================================== *
 * R-9.13 / R-9.15 / R-9.16 — the guard sits ahead of /__vs/collab in BOTH hosts
 * ================================================================== */
describe('R-9.13 / R-9.15 / R-9.16 — the request guard covers /__vs/collab in both hosts', () => {
  it('the standalone server guards every /__vs path before dispatching, collab included', () => {
    const text = src('src/server.ts');
    const guard = text.indexOf("url.pathname.startsWith('/__vs/')");
    const collab = text.indexOf("'/__vs/collab'");
    expect(guard).toBeGreaterThan(-1);
    expect(collab).toBeGreaterThan(-1);
    // The guard's prefix check covers `/__vs/collab/*`, and it runs first.
    expect(guard).toBeLessThan(collab);
    expect(text).toContain('checkRequest(req.headers)');
  });

  it('the Vite host registers the guard middleware before the collab middleware', () => {
    const text = src('core/vite/md-plugin.ts');
    const guard = text.indexOf("server.middlewares.use('/__vs', (req, res, next)");
    const collab = text.indexOf("server.middlewares.use('/__vs/collab'");
    expect(guard).toBeGreaterThan(-1);
    expect(collab).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(collab);
  });

  it('both hosts share one guard implementation', () => {
    expect(src('src/server.ts')).toContain("from '../core/vite/request-guard'");
    expect(src('core/vite/md-plugin.ts')).toContain("from './request-guard'");
  });
});

/* ================================================================== *
 * R-7.6 — the routing itself lives in shared code both hosts call
 * ================================================================== */
describe('R-7.6 — both hosts mount the same router with no host-specific logic', () => {
  for (const host of ['src/server.ts', 'core/vite/md-plugin.ts']) {
    it(`${host} calls createCollabRoutes and delegates every path decision to collab.handle`, () => {
      const text = src(host);
      expect(text).toContain('createCollabRoutes');
      expect(text).toContain('collab.handle(');
      expect(text).toContain('createJobHubRegistry()');
      // No host may recognise a collaboration sub-path of its own.
      expect(text).not.toMatch(/['"`]\/__vs\/collab\/(start|open|events|sync|publish|comments)/);
      expect(text).not.toMatch(/collab[\s\S]{0,400}?sub === '\/(start|open|sync|publish|events|comments)'/);
    });
  }
});
