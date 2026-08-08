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
import { GitHubError, type CreateReviewCommentInput, type GitHubAdapter } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { JobEvent, JobSync, SseSink } from '../../collaboration/job-hub';
import {
  reviewCommentIdFor,
  reviewRecordIdFor,
  type ReviewComment,
  type ReviewThreadRecord,
  type ThreadResolution,
} from '../../collaboration/review-comments';
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
  /*
   * `setResolved` is what the route uses for a status change, because on GitHub a
   * resolution is a marker reply rather than a field (R-5.12). The stub stood in for
   * `githubCommentStore` without it, so these tests passed while the real Resolve button
   * did nothing — the stub was more capable than production in exactly the wrong place.
   * Modelled the same way the real one behaves on read-back: the parent reads resolved.
   */
  const setResolved = async (id: string, resolved: boolean): Promise<CommentRecord | null> => {
    const found = comments.find((c) => c.id === id);
    if (!found) return null;
    const next = { ...found, status: resolved ? 'applied' : 'open' } as CommentRecord;
    comments = comments.map((c) => (c.id === id ? next : c));
    return next;
  };
  return { store: Object.assign(store, { setResolved }), all: () => comments };
}

/* ------------------------------------------------------------------ *
 * The review-comment double (R-4.8 / R-12.3 — nothing here execs `gh`)
 * ------------------------------------------------------------------ */

/** The head sha `getPullRequest` reports unless a test moves it. */
const HEAD_SHA = 'a'.repeat(40);

/** One review comment as GitHub returns it, with the projection's fields filled in. */
function reviewComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 900001,
    inReplyToId: null,
    path: 'docs/spec.md',
    line: 12,
    startLine: null,
    originalLine: 12,
    side: 'RIGHT',
    subjectType: 'line',
    commitId: HEAD_SHA,
    originalCommitId: HEAD_SHA,
    diffHunk: '@@ -10,3 +10,3 @@',
    body: 'tighten this',
    user: 'octocat',
    createdAt: 'T0',
    updatedAt: 'T0',
    htmlUrl: 'https://github.com/acme/specs/pull/7#discussion_r900001',
    ...over,
  };
}

/**
 * A `GitHubAdapter` standing in for the four methods the review-comment routes call, and
 * recording what they were called with.
 *
 * `createFails` / `replyFails` are consumed one per attempt, which is what makes the
 * R-7.13 retry observable: a single queued 422 fails the first create and lets the second
 * through, so a route that retried twice, or not at all, fails here.
 */
function reviewAdapter(
  options: {
    list?: ReviewComment[];
    resolution?: ThreadResolution[] | Error;
    createFails?: (Error | null)[];
    replyFails?: (Error | null)[];
  } = {},
) {
  const creates: CreateReviewCommentInput[] = [];
  const replies: { commentId: number; body: string }[] = [];
  const pulls: number[] = [];
  const createFails = [...(options.createFails ?? [])];
  const replyFails = [...(options.replyFails ?? [])];
  let headSha = HEAD_SHA;
  let nextId = 900100;

  const adapter = {
    async getPullRequest(_repo: unknown, pullNumber: number) {
      pulls.push(pullNumber);
      return { number: pullNumber, headSha, state: 'open' };
    },
    async createReviewComment(_repo: unknown, _pullNumber: number, input: CreateReviewCommentInput) {
      creates.push(input);
      const fail = createFails.shift();
      if (fail) throw fail;
      nextId += 1;
      return reviewComment({
        id: nextId,
        path: input.path,
        body: input.body,
        commitId: input.commitId,
        ...(input.line === undefined
          ? { subjectType: 'file' as const, line: null }
          : { line: input.line, startLine: input.startLine ?? null }),
      });
    },
    async replyToReviewComment(_repo: unknown, _pullNumber: number, commentId: number, body: string) {
      replies.push({ commentId, body });
      const fail = replyFails.shift();
      if (fail) throw fail;
      nextId += 1;
      return reviewComment({ id: nextId, inReplyToId: commentId, body });
    },
    async listReviewComments() {
      return options.list ?? [];
    },
    async listThreadResolution() {
      if (options.resolution instanceof Error) throw options.resolution;
      return options.resolution ?? [];
    },
  } as unknown as GitHubAdapter;

  return {
    adapter,
    creates,
    replies,
    pulls,
    lastId: () => nextId,
    setHeadSha: (sha: string) => {
      headSha = sha;
    },
  };
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

  /*
   * R-9.7 as a display hint. The verdict path is unchanged and still authoritative; these
   * three cover the only thing the snapshot may say: yes, no, or nothing at all.
   */
  it('carries canPublish when the authorizer can answer the write-access question', async () => {
    const authorize: CollabAuthorizer = () => ({ ok: true });
    authorize.writeAccess = async () => ({ write: true });
    const res = await call(router({ authorize }), 'GET', '');
    expect(res.json).toMatchObject({ available: true, canPublish: true });
    expect(res.json).not.toHaveProperty('publishBlocked');
  });

  it('tells a reviewer their session is comment-only', async () => {
    const authorize: CollabAuthorizer = () => ({ ok: true });
    authorize.writeAccess = async () => ({
      write: false,
      reason: 'no_write_access',
      message: 'Your credential has no write access to acme/docs.',
    });
    const res = await call(router({ authorize }), 'GET', '');
    expect(res.json).toMatchObject({ available: true, canPublish: false });
  });

  /*
   * R-12.5 — "no" has two causes and they need different words. A missing write grant is
   * a role fact the reviewer can live with; a repo that cannot be found is a config error
   * no later step explains, so the snapshot must carry the reason, not just the boolean.
   */
  it('names why publishing is blocked, distinguishing no grant from no repo', async () => {
    const blocked = async (reason: 'no_write_access' | 'no_repo', message: string) => {
      const authorize: CollabAuthorizer = () => ({ ok: true });
      authorize.writeAccess = async () => ({ write: false as const, reason, message });
      return (await call(router({ authorize }), 'GET', '')).json;
    };

    expect(await blocked('no_write_access', 'No write access to acme/docs.')).toMatchObject({
      canPublish: false,
      publishBlocked: { reason: 'no_write_access', message: 'No write access to acme/docs.' },
    });
    expect(await blocked('no_repo', 'acme/docs was not found.')).toMatchObject({
      canPublish: false,
      publishBlocked: { reason: 'no_repo', message: 'acme/docs was not found.' },
    });
  });

  it('omits canPublish rather than guessing when write access is undeterminable', async () => {
    const authorize: CollabAuthorizer = () => ({ ok: true });
    authorize.writeAccess = async () => ({ write: null, reason: 'unknown' });
    const res = await call(router({ authorize }), 'GET', '');
    expect(res.json).toMatchObject({ available: true });
    expect(res.json).not.toHaveProperty('canPublish');
    expect(res.json).not.toHaveProperty('publishBlocked');
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

  /*
   * The `create` body commits whatever `store.read(documentId)` returns and throws when
   * that is null, so a route that only started the job accepted work no job could finish.
   * The document has to exist before the branch does.
   */
  it('materializes the document before the job runs', async () => {
    const store = memoryDocuments();
    const create = vi.fn<CollabJobBodies['create']>(() => async () => {});
    const r = router({ documents: () => store, bodies: { create } });

    const res = await call(r, 'POST', '/start', {
      documentId: 'doc-new',
      documentPath: 'documents/doc-new.json',
      title: 'Payment rules',
    });
    expect(res.status).toBe(200);

    const seeded = await store.read('doc-new');
    expect(seeded).toMatchObject({
      documentId: 'doc-new',
      documentPath: 'documents/doc-new.json',
      title: 'Payment rules',
      nodes: [],
    });
    // Not `{ root: {} }` — that root has no `type` and `injectJSON` throws on it, which
    // would strand the author in an editor that never loaded.
    expect((seeded?.doc.root as { type?: string }).type).toBe('root');
    expect((seeded?.doc.root as { children?: unknown[] }).children).toHaveLength(1);
  });

  it('leaves an existing document alone, so a retried start cannot blank it', async () => {
    const existing = document({ documentId: 'doc-1', title: 'Written already' });
    const store = memoryDocuments([existing]);
    const r = router({ documents: () => store, bodies: { create: () => async () => {} } });

    await call(r, 'POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json', title: 'Blank' });

    expect(await store.read('doc-1')).toBe(existing);
  });

  it('seeds nothing when authorization refuses, so a reviewer leaves no trace', async () => {
    const store = memoryDocuments();
    const authorize: CollabAuthorizer = () => ({ ok: false, status: 403, error: 'author only' });
    const r = router({ documents: () => store, authorize });

    expect((await call(r, 'POST', '/start', { documentId: 'doc-new', documentPath: 'a.json' })).status).toBe(403);
    expect(await store.read('doc-new')).toBeNull();
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
  /*
   * The kind is not cosmetic. `use-collab-document.ts` reads it off the `job-done` frame
   * to decide what to re-read, and skips the document for comment-only kinds — `sync` is
   * one of those. While open wore that label a reviewer sat looking at the seed document
   * until they reloaded the page, which is the one thing R-11.2 exists to prevent. The
   * browser half of this pairing is pinned in `use-collab-document.test.ts`.
   */
  it('starts an open-kind job carrying the pull number', async () => {
    const open = vi.fn<CollabJobBodies['open']>(() => async () => {});
    const r = router({ bodies: { open } });
    const res = await call(r, 'POST', '/open', { documentId: 'doc-1', pullNumber: 42 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'open' });
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
 * R-5.4 / R-7.5 — collaborative comments are PR REVIEW comments,
 * anchored on path + line
 * ================================================================== */
describe('R-7.1 / R-7.5 — comment routes', () => {
  const withReview = (options: Parameters<typeof reviewAdapter>[0] = {}) => {
    const fake = reviewAdapter(options);
    return { fake, r: router({ adapter: () => fake.adapter }) };
  };

  /*
   * R-4.13 is the reason `getPullRequest` is on the create path at all. A sha held from
   * open is stale the moment anyone pushes, and a comment posted against a stale sha is
   * born outdated — GitHub answers `line: null` immediately. Pinned on the second create
   * seeing the *moved* head, because that is the case a cached sha would get wrong while
   * the first create still looked correct.
   */
  it('re-reads the head sha at creation time and sends it as commit_id (R-4.13)', async () => {
    const { fake, r } = withReview();
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'tighten this', startLine: 12 });
    expect(res.status).toBe(200);
    expect(fake.creates[0]).toMatchObject({ path: 'docs/spec.md', body: 'tighten this', line: 12, startLine: 12, commitId: HEAD_SHA });

    fake.setHeadSha('b'.repeat(40));
    await call(r, 'POST', '/doc-1/comments', { comment: 'and this', startLine: 20 });
    expect(fake.creates[1]?.commitId).toBe('b'.repeat(40));
    // One read per create, never one read reused for both.
    expect(fake.pulls).toEqual([7, 7]);
  });

  it('sends the selected range, and a single line when the selection is one line', async () => {
    const { fake, r } = withReview();
    await call(r, 'POST', '/doc-1/comments', { comment: 'range', startLine: 12, endLine: 15 });
    expect(fake.creates[0]).toMatchObject({ line: 15, startLine: 12, side: 'RIGHT' });
    await call(r, 'POST', '/doc-1/comments', { comment: 'one line', startLine: 12 });
    expect(fake.creates[1]).toMatchObject({ line: 12, startLine: 12 });
  });

  it('answers the projected thread, keyed by the c-<8hex> id PATCH parses', async () => {
    const { fake, r } = withReview();
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'tighten this', startLine: 12 });
    const body = res.json as { ok: boolean; id: string; comment: ReviewThreadRecord };
    expect(body.ok).toBe(true);
    // The bijection: the record id decodes back to the REST integer GitHub returned.
    expect(body.id).toBe(reviewRecordIdFor(fake.lastId()));
    expect(reviewCommentIdFor(body.id)).toBe(fake.lastId());
    expect(body.comment.github.reviewCommentId).toBe(fake.lastId());
    // R-5.16 — projected onto the unchanged `CommentTarget`.
    expect(body.comment.target).toEqual({ path: 'docs/spec.md', kind: 'range', startLine: 12 });
    expect(body.comment.comment).toBe('tighten this');
    expect(body.comment.status).toBe('open');
  });

  /*
   * The routing tag the panel's "Apply via" control sets. R-5.4 forbids writing a
   * machine-readable reference into the body, so GitHub has nowhere to keep it: it rides
   * on the response and nowhere else. Asserted on both sides — present in the answer,
   * absent from what was posted — because carrying it in the body is the tempting wrong
   * fix, and it is the one this requirement rules out.
   */
  it('carries the routing tag on the answer, and never into the comment body', async () => {
    const { fake, r } = withReview();
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'hand this off', startLine: 12, workflow: 'research' });
    expect((res.json as { comment: ReviewThreadRecord }).comment.workflow).toBe('research');
    expect(fake.creates[0]?.body).toBe('hand this off');
  });

  it('omits the tag when the caller sent none, rather than inventing one', async () => {
    const { r } = withReview();
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'no tag', startLine: 12 });
    expect((res.json as { comment: ReviewThreadRecord }).comment.workflow).toBe('visual-spec');
  });

  /*
   * A comment with no line is file-level BY INTENT — the document-level note R-5.7 keeps
   * visible — so it carries no `degraded` disclosure and no restated line reference. That
   * distinction is the whole content of R-7.12 versus R-7.13.
   */
  it('accepts a document-level comment with no line, posting it file-level without a disclosure', async () => {
    const { fake, r } = withReview();
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'overall: good' });
    expect(res.status).toBe(200);
    expect(fake.creates[0]).toEqual({ path: 'docs/spec.md', body: 'overall: good', commitId: HEAD_SHA });
    expect((res.json as { degraded?: unknown }).degraded).toBeUndefined();
    expect((res.json as { comment: ReviewThreadRecord }).comment.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
  });

  it('comments on the document’s own path unless the caller names another', async () => {
    const { fake, r } = withReview();
    await call(r, 'POST', '/doc-1/comments', { comment: 'x', startLine: 3 });
    expect(fake.creates[0]?.path).toBe('docs/spec.md');
    await call(r, 'POST', '/doc-1/comments', { comment: 'x', startLine: 3, path: 'docs/other.md' });
    expect(fake.creates[1]?.path).toBe('docs/other.md');
  });

  it('rejects an empty comment and a line that is not a line with 400', async () => {
    const { r } = withReview();
    expect((await call(r, 'POST', '/doc-1/comments', {})).status).toBe(400);
    expect((await call(r, 'POST', '/doc-1/comments', { comment: '   ' })).status).toBe(400);
    expect((await call(r, 'POST', '/doc-1/comments', { comment: 'x', startLine: 0 })).status).toBe(400);
    expect((await call(r, 'POST', '/doc-1/comments', { comment: 'x', startLine: 1.5 })).status).toBe(400);
    expect((await call(r, 'POST', '/doc-1/comments', { comment: 'x', startLine: 9, endLine: 4 })).status).toBe(400);
  });

  it('404s on an unknown document', async () => {
    const { r } = withReview();
    expect((await call(r, 'POST', '/doc-nope/comments', { comment: 'x' })).status).toBe(404);
  });

  it('409s when the document has no pull request yet', async () => {
    // The review context is derived from the document's own binding; without one there is
    // no pull request to host a conversation.
    const r = router({ documents: () => memoryDocuments([document({ github: undefined })]) });
    expect((await call(r, 'POST', '/doc-1/comments', { comment: 'x' })).status).toBe(409);
  });

  it('reports a refused create with GitHub’s own cause, and keeps the user’s text out of it (R-7.14)', async () => {
    const { r } = withReview({ createFails: [new GitHubError('createReviewComment', 'Not Found', 404)] });
    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'tighten this', startLine: 12 });
    expect(res).toEqual({ status: 404, json: { error: 'Not Found' } });
  });

  /* ---------------------------------------------------------------- *
   * R-7.15 — replies are native
   * ---------------------------------------------------------------- */

  it('replies through the replies endpoint, keyed on the thread root’s integer id', async () => {
    const { fake, r } = withReview();
    const res = await call(r, 'POST', '/doc-1/comments/c-000dbba1/reply', { comment: 'done' });
    expect(res.status).toBe(200);
    // `c-000dbba1` is 900001 in hex — the same integer `in_reply_to_id` and the reply
    // endpoint are keyed on (R-5.19).
    expect(fake.replies).toEqual([{ commentId: 900001, body: 'done' }]);
    // Nothing computed an anchor: the reply inherits the thread's (R-7.15).
    expect(fake.creates).toEqual([]);
    expect((res.json as { comment: ReviewThreadRecord }).comment.comment).toBe('done');
  });

  it('404s a reply to a root GitHub does not know, and 400s a malformed commentId', async () => {
    const { r } = withReview({ replyFails: [new GitHubError('replyToReviewComment', 'Not Found', 404)] });
    expect((await call(r, 'POST', '/doc-1/comments/c-000dbba1/reply', { comment: 'x' })).status).toBe(404);
    expect((await call(r, 'POST', '/doc-1/comments/nope/reply', { comment: 'x' })).status).toBe(400);
  });

  /* ---------------------------------------------------------------- *
   * PATCH keeps its store — the record-id bijection is the seam
   * ---------------------------------------------------------------- */

  it('PATCH updates a comment and 404s an unknown one', async () => {
    const parent = {
      id: 'c-00000001',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'old',
      status: 'open',
      ts: 'T0',
    } as unknown as CommentRecord;
    const mem = memoryComments([parent]);
    const r = router({ commentStore: () => mem.store });
    const res = await call(r, 'PATCH', '/doc-1/comments/c-00000001', { comment: 'new', status: 'applied' });
    expect(res.status).toBe(200);
    expect(mem.all()[0]!.comment).toBe('new');
    expect(mem.all()[0]!.status).toBe('applied');
    expect((await call(r, 'PATCH', '/doc-1/comments/c-000000ff', { comment: 'x' })).status).toBe(404);
  });

  /*
   * The panel's Resolve button sends exactly this — a status and no text. It used to be
   * served by `updateComment`, which documents that it cannot express status and returns
   * the record untouched, so the route answered 200 and nothing resolved.
   *
   * R-5.13 draws the line this test sits on: `status` is the LOCAL apply-agent flag
   * (R-5.21), and nothing on this path writes resolution to GitHub. The review-comment
   * routes have no resolve call at all — resolving happens on github.com.
   */
  it('routes a status-only PATCH through setResolved — the resolve the panel actually sends', async () => {
    const parent = {
      id: 'c-00000001',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'needs work',
      status: 'open',
      ts: 'T0',
    } as unknown as CommentRecord;
    const mem = memoryComments([parent]);
    const r = router({ commentStore: () => mem.store });
    const setResolved = vi.spyOn(mem.store as { setResolved: (id: string, r: boolean) => unknown }, 'setResolved');

    const res = await call(r, 'PATCH', '/doc-1/comments/c-00000001', { status: 'applied' });

    expect(res.status).toBe(200);
    expect(setResolved).toHaveBeenCalledWith('c-00000001', true);
    expect(mem.all()[0]!.status).toBe('applied');
    // The answer is the parent as it now reads, never the marker reply resolution creates.
    expect((res.json as { comment: CommentRecord }).comment.id).toBe('c-00000001');

    await call(r, 'PATCH', '/doc-1/comments/c-00000001', { status: 'open' });
    expect(setResolved).toHaveBeenLastCalledWith('c-00000001', false);
    expect(mem.all()[0]!.status).toBe('open');
  });

  /*
   * R-5.13 as a source fact, not just a behavioural one. There is no GitHub operation for
   * resolving a review thread on the REST surface and none in the adapter, so the guard
   * that matters is that nothing here ever reaches for one.
   */
  it('never writes resolution state to GitHub (R-5.13)', () => {
    const source = src('core/vite/routes/collab.ts');
    expect(source).not.toMatch(/resolveReviewThread|unresolveReviewThread|isResolved\s*:/);
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

describe('GET /:id/comments — the conversation (R-5.7 / R-5.12 / R-5.20)', () => {
  const ROOT = reviewComment({ id: 900001, body: 'tighten this', line: 12 });
  const REPLY = reviewComment({ id: 900002, inReplyToId: 900001, body: 'done', createdAt: 'T1' });
  const ORPHAN = reviewComment({ id: 900003, inReplyToId: 800000, body: 'its root was deleted', createdAt: 'T2' });
  const FILE_LEVEL = reviewComment({ id: 900004, subjectType: 'file', line: null, body: 'overall: good', createdAt: 'T3' });

  const listing = (options: Parameters<typeof reviewAdapter>[0]) => router({ adapter: () => reviewAdapter(options).adapter });

  it('groups the whole list into threads and folds replies onto their root (R-5.17 / R-5.20)', async () => {
    const r = listing({ list: [ROOT, REPLY, ORPHAN, FILE_LEVEL] });
    const res = await call(r, 'GET', '/doc-1/comments');
    expect(res.status).toBe(200);
    const threads = res.json as ReviewThreadRecord[];
    // Three threads, not four: the reply is not a record of its own (R-5.20).
    expect(threads.map((t) => t.id)).toEqual([
      reviewRecordIdFor(900001),
      reviewRecordIdFor(900003),
      reviewRecordIdFor(900004),
    ]);
    expect(threads[0]!.replies.map((rep) => rep.body)).toEqual(['done']);
    // R-5.18 — the reply whose root is gone is promoted, never dropped.
    expect(threads[1]!.comment).toBe('its root was deleted');
    // R-5.7 / R-6.12 — the file-level thread is present and anchored to the document.
    expect(threads[2]!.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
    expect(threads[2]!.github.isOutdated).toBe(false);
  });

  it('joins GitHub’s resolution state onto the thread by its root’s integer id (R-4.15 / R-5.12)', async () => {
    const r = listing({
      list: [ROOT, REPLY, FILE_LEVEL],
      resolution: [
        { rootCommentId: 900001, isResolved: true, isOutdated: false },
        { rootCommentId: 900004, isResolved: false, isOutdated: false },
      ],
    });
    const threads = (await call(r, 'GET', '/doc-1/comments')).json as ReviewThreadRecord[];
    expect(threads[0]!.github.isResolved).toBe(true);
    expect(threads[1]!.github.isResolved).toBe(false);
  });

  /*
   * R-4.12 / R-5.15 — resolution is a GraphQL read next to a REST one and fails on its
   * own. When it does the conversation is still served, and every thread says "unknown"
   * rather than "unresolved": those two answers drive different UI and a different Ready
   * gate (R-8.25), and flattening them is a silent wrong answer.
   */
  it('serves the conversation when the resolution read fails, reporting unknown rather than unresolved', async () => {
    const r = listing({ list: [ROOT, REPLY], resolution: new GitHubError('listThreadResolution', 'graphql exploded') });
    const res = await call(r, 'GET', '/doc-1/comments');
    expect(res.status).toBe(200);
    const threads = res.json as ReviewThreadRecord[];
    expect(threads).toHaveLength(1);
    expect(threads[0]!.github.isResolved).toBeUndefined();
    expect('isResolved' in threads[0]!.github).toBe(false);
  });

  it('marks a thread that lost its line outdated, and carries no line for it (R-6.5)', async () => {
    const outdated = reviewComment({ id: 900005, line: null, originalLine: 12, originalCommitId: 'a'.repeat(40) });
    const threads = (await call(listing({ list: [outdated] }), 'GET', '/doc-1/comments')).json as ReviewThreadRecord[];
    expect(threads[0]!.github.isOutdated).toBe(true);
    // `original_line` is a line in a different commit and is never used as a position.
    expect(threads[0]!.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
  });

  it('answers an empty list, not a 404, when nothing has been said yet', async () => {
    expect(await call(listing({}), 'GET', '/doc-1/comments')).toEqual({ status: 200, json: [] });
  });

  it('404s an unknown document', async () => {
    expect((await call(listing({}), 'GET', '/doc-nope/comments')).status).toBe(404);
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
    const fake = reviewAdapter({ list: [ROOT] });
    const res = await call(router({ adapter: () => fake.adapter, authorize: deny }), 'GET', '/doc-1/comments');
    expect(seen).toEqual(['read']);
    expect(res).toEqual({ status: 401, json: { error: 'who are you' } });
  });

  it('gates before it reads — a denied request never reaches GitHub', async () => {
    const fake = reviewAdapter({ list: [ROOT] });
    const adapter = vi.fn(() => fake.adapter);
    const r = router({ adapter, authorize: () => ({ ok: false, status: 403, error: 'nope' }) });
    await call(r, 'GET', '/doc-1/comments');
    expect(adapter).not.toHaveBeenCalled();
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
