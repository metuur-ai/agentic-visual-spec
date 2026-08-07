/**
 * authorization.test.ts — role classification and author-only enforcement (task 9.2).
 *
 * REQUIREMENT IDs (docs/ears/github-pr-collaborative-documents.md)
 *   R-9.5  — identity resolved from the credential
 *   R-9.6  — comments attributed to the acting account; identity never in the body
 *   R-9.7  — author == identity matches the PR author AND write access; reviewer otherwise
 *   R-9.8  — a reviewer reads, comments and replies with no write access
 *   R-9.9  — the committing operations are author-only, enforced server-side
 *   R-9.10 — a reviewer's author-only request is rejected even with the UI control hidden
 *   R-9.11 — hiding a UI control never satisfies an authorization requirement
 *
 * HOW R-9.10 / R-9.11 ARE MADE CONCRETE. Every table row below goes through
 * `createCollabRoutes(...).handle(...)` — the HTTP surface — with no UI, no React and no
 * browser anywhere in the process. A control that is hidden client-side is not part of
 * this test's world, which is precisely the point: the route is the enforcement point.
 *
 * No real network and no `gh`: the preflight is injected and every `gh api` call goes
 * through a recorded-response `GhExecutor` keyed by endpoint (R-4.8 / R-12.3).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from './credentials';
import type { CollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import { createJobHubRegistry } from './job-hub';
import type { GhExecutor } from './github-executor';
import { createGitHubAdapter } from './github-adapter';
import { githubCommentStore } from './comment-projection';
import type { ResolvedVisualSpecConfig } from '../config';
import type { CommentDoc, CommentRecord } from '../editing/comment-doc';
import type { CommentDocStore } from '../vite/routes/comments';
import {
  type CollabDeps,
  type CollabOperation,
  type CollabRouteResult,
  createCollabRoutes,
} from '../vite/routes/collab';
import { OPERATION_POLICY, createCollabAuthorizer } from './authorization';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf8');

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO } };

/** R-9.5 — the identity every check below compares against comes from here and nowhere else. */
const PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

/* ------------------------------------------------------------------ *
 * Recorded `gh` — dispatched by endpoint, because the number of calls
 * is exactly what several of these tests are asserting.
 * ------------------------------------------------------------------ */

type GhStub = { exec: GhExecutor; endpoints: string[] };

function gh(routes: Record<string, { stdout?: string; stderr?: string; exitCode?: number | null }>): GhStub {
  const endpoints: string[] = [];
  const exec: GhExecutor = async (args) => {
    const endpoint = args[args.length - 1] as string;
    endpoints.push(endpoint);
    const r = routes[endpoint];
    if (!r) return { stdout: '', stderr: `no recorded response for ${endpoint}`, exitCode: 1 };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, endpoints };
}

const REPO_ENDPOINT = '/repos/acme/specs';
const PULL_ENDPOINT = '/repos/acme/specs/pulls/7';

const asReviewer = () => gh({ [REPO_ENDPOINT]: { stdout: fixture('repo-read-only.json') } });
const asAuthor = () =>
  gh({
    [REPO_ENDPOINT]: { stdout: fixture('repo-write-access.json') },
    [PULL_ENDPOINT]: { stdout: fixture('pull-author-octocat.json') },
  });

/* ------------------------------------------------------------------ *
 * Router harness
 * ------------------------------------------------------------------ */

function document(): CollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'docs/spec.md',
    title: 'Spec',
    frontmatter: {},
    nodes: [],
    doc: { root: {} },
    github: { owner: 'acme', repo: 'specs', branch: 'vs/doc-1', pullNumber: 7, resolved: false },
  };
}

function memoryDocuments(docs: CollaborationDocument[]): DocumentStore {
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

const SEED: CommentRecord = {
  id: 'c-00000001',
  workflow: 'visual-spec',
  target: { path: 'docs/spec.md', kind: 'file' },
  comment: 'seed',
  status: 'open',
  ts: '2026-08-07T09:00:00Z',
};

function memoryComments(): CommentDocStore {
  let comments: CommentRecord[] = [SEED];
  let seq = 1;
  return {
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
      return { ...found, ...patch } as CommentRecord;
    },
  };
}

/** A router with the REAL authorizer wired in, exactly as both hosts wire it. */
function router(exec: GhExecutor, overrides: Partial<CollabDeps> = {}) {
  const documents = memoryDocuments([document()]);
  const comments = memoryComments();
  const r = createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents: () => documents,
    preflight: async () => PREFLIGHT,
    commentStore: () => comments,
    bodies: {
      create: () => async () => {},
      open: () => async () => {},
      sync: () => async () => {},
      publish: () => async () => {},
    },
    authorize: createCollabAuthorizer({ exec, documents: () => documents }),
    ...overrides,
  });
  return r;
}

const call = (r: ReturnType<typeof router>, method: string, pathname: string, body: Record<string, unknown> = {}) =>
  r.handle({ method, pathname, query: {}, body }) as Promise<CollabRouteResult>;

/* ------------------------------------------------------------------ *
 * The table. EVERY `CollabOperation` appears exactly once — enforced
 * below, so a newly added operation forces a decision here rather than
 * defaulting silently to permitted.
 * ------------------------------------------------------------------ */

type Row = {
  op: CollabOperation;
  /** What a REVIEWER credential (read-only) gets. */
  reviewer: 'allowed' | 'denied';
  /** The HTTP request that reaches the authorizer with this op, if one does. */
  route: { method: string; path: string; body?: Record<string, unknown> } | null;
};

const TABLE: Row[] = [
  // R-9.8 — the reviewer half of the model. None of these needs write access.
  { op: 'read', reviewer: 'allowed', route: null },
  { op: 'sync', reviewer: 'allowed', route: { method: 'POST', path: '/doc-1/sync' } },
  { op: 'open', reviewer: 'allowed', route: { method: 'POST', path: '/open', body: { documentId: 'doc-1', pullNumber: 7 } } },
  { op: 'comment', reviewer: 'allowed', route: { method: 'POST', path: '/doc-1/comments', body: { comment: 'a note' } } },
  {
    op: 'reply',
    reviewer: 'allowed',
    route: { method: 'POST', path: '/doc-1/comments/c-00000001/reply', body: { comment: 'agreed' } },
  },
  {
    op: 'edit-comment',
    reviewer: 'allowed',
    route: { method: 'PATCH', path: '/doc-1/comments/c-00000001', body: { status: 'applied' } },
  },
  // R-9.9 — the two operations in this family that commit.
  {
    op: 'create',
    reviewer: 'denied',
    route: { method: 'POST', path: '/start', body: { documentId: 'doc-2', documentPath: 'docs/new.md' } },
  },
  {
    op: 'publish',
    reviewer: 'denied',
    route: { method: 'POST', path: '/doc-1/publish', body: { json: { root: {} }, markdown: '# Spec' } },
  },
  // R-8.18 / R-8.15 — recovery is the author's own repair of their own document.
  {
    op: 'reconcile',
    reviewer: 'denied',
    route: { method: 'POST', path: '/doc-1/reconcile', body: {} },
  },
  {
    op: 'mark-ready',
    reviewer: 'denied',
    route: { method: 'POST', path: '/doc-1/ready', body: {} },
  },
];

describe('OPERATION_POLICY covers every operation exactly once', () => {
  it('the table and the policy agree, with no operation left undecided', () => {
    const inTable = TABLE.map((row) => row.op).sort();
    expect(inTable).toEqual([...new Set(inTable)]); // no duplicates
    expect(inTable).toEqual(Object.keys(OPERATION_POLICY).sort());
  });

  it('reviewer-permitted rows are exactly the any-role operations', () => {
    for (const row of TABLE) {
      expect(OPERATION_POLICY[row.op]).toBe(row.reviewer === 'allowed' ? 'any-role' : 'author-only');
    }
  });
});

/* ================================================================== *
 * R-9.8 / R-9.9 / R-9.10 / R-9.11 — the reviewer-token table, driven
 * through the route layer with no UI in the picture.
 * ================================================================== */
describe('a reviewer credential attempting every operation (R-9.8 … R-9.11)', () => {
  for (const row of TABLE) {
    if (!row.route) {
      it(`${row.op}: reaches no route today, and the authorizer permits it directly`, async () => {
        const verdict = await createCollabAuthorizer({
          exec: asReviewer().exec,
          documents: () => memoryDocuments([document()]),
        })(row.op, { documentId: 'doc-1', login: 'octocat', repo: { ...REPO } });
        expect(verdict).toEqual({ ok: true });
      });
      continue;
    }

    const { method, path, body } = row.route;
    if (row.reviewer === 'allowed') {
      it(`${row.op}: a reviewer's ${method} ${path} is served, and costs no permission probe`, async () => {
        const stub = asReviewer();
        const res = await call(router(stub.exec), method, path, body ?? {});
        expect(res.status).toBe(200);
        // R-9.8 — "SHALL NOT require write access": the check is never even made.
        expect(stub.endpoints).toEqual([]);
      });
    } else {
      it(`${row.op}: a reviewer's ${method} ${path} is rejected server-side with 403`, async () => {
        const stub = asReviewer();
        const res = await call(router(stub.exec), method, path, body ?? {});
        expect(res.status).toBe(403);
        expect((res.json as { error: string }).error).toContain('author only');
        expect((res.json as { error: string }).error).toContain('no write access');
        // The refusal is decided before the PR is ever fetched: no write access is
        // already disqualifying, whoever opened the pull request.
        expect(stub.endpoints).toEqual([REPO_ENDPOINT]);
      });
    }
  }

  it('the same rejection happens with no UI anywhere in the process (R-9.11)', async () => {
    // A hidden control cannot be part of the answer: this file imports no UI module and
    // the request below is a bare object handed to the router.
    const source = readFileSync(new URL('authorization.ts', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      '',
    );
    expect(source).not.toMatch(/from '[^']*\/ui\//);
    expect(source).not.toMatch(/from '(react|react-dom|@lyfie\/luthor)/);

    const res = await call(router(asReviewer().exec), 'POST', '/doc-1/publish', { json: {}, markdown: '# x' });
    expect(res.status).toBe(403);
  });
});

/* ================================================================== *
 * R-9.7 — classification
 * ================================================================== */
describe('R-9.7 — author requires BOTH identity and write access', () => {
  it('author: identity matches the PR author and the credential carries write access', async () => {
    const stub = asAuthor();
    const res = await call(router(stub.exec), 'POST', '/doc-1/publish', { json: { root: {} }, markdown: '# Spec' });
    expect(res.status).toBe(200);
    expect(stub.endpoints).toEqual([REPO_ENDPOINT, PULL_ENDPOINT]);
  });

  it('reviewer: write access but a different PR author is NOT an author', async () => {
    const stub = gh({
      [REPO_ENDPOINT]: { stdout: fixture('repo-write-access.json') },
      [PULL_ENDPOINT]: { stdout: fixture('pull-author-other.json') },
    });
    const res = await call(router(stub.exec), 'POST', '/doc-1/publish', { json: {}, markdown: '# x' });
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toContain('opened by hubot');
    expect((res.json as { error: string }).error).toContain('authenticates as octocat');
  });

  it('reviewer: matching identity without write access is NOT an author', async () => {
    // `pull-author-octocat` names the acting login, so identity alone would pass.
    const stub = gh({
      [REPO_ENDPOINT]: { stdout: fixture('repo-read-only.json') },
      [PULL_ENDPOINT]: { stdout: fixture('pull-author-octocat.json') },
    });
    const res = await call(router(stub.exec), 'POST', '/doc-1/publish', { json: {}, markdown: '# x' });
    expect(res.status).toBe(403);
  });

  it('write access alone decides when there is no pull request to differ from (create)', async () => {
    const stub = asAuthor();
    // `doc-2` does not exist yet — `create` is the operation that opens its PR, and
    // whoever opens it becomes its author.
    const res = await call(router(stub.exec), 'POST', '/start', { documentId: 'doc-2', documentPath: 'docs/new.md' });
    expect(res.status).toBe(200);
    expect(stub.endpoints).toEqual([REPO_ENDPOINT]);
  });

  it('R-9.5 — the login compared is the credential identity the preflight resolved', async () => {
    const seen: string[] = [];
    const stub = asAuthor();
    const documents = memoryDocuments([document()]);
    const authorize = createCollabAuthorizer({ exec: stub.exec, documents: () => documents });
    const r = createCollabRoutes({
      jobs: createJobHubRegistry(),
      config: () => ENABLED,
      documents: () => documents,
      preflight: async () => PREFLIGHT,
      bodies: { publish: () => async () => {} },
      authorize: (op, ctx) => {
        seen.push(ctx.login);
        return authorize(op, ctx);
      },
    });
    await call(r, 'POST', '/doc-1/publish', { json: {}, markdown: '# x' });
    expect(seen).toEqual([PREFLIGHT.available ? PREFLIGHT.login : '']);
  });
});

/* ================================================================== *
 * Fail closed
 * ================================================================== */
describe('an undeterminable role fails closed', () => {
  const cases: [name: string, routes: Parameters<typeof gh>[0]][] = [
    ['gh cannot be started at all', { [REPO_ENDPOINT]: { exitCode: null, stderr: 'gh not found on PATH' } }],
    ['the repository is not found', { [REPO_ENDPOINT]: { exitCode: 1, stdout: fixture('error-not-found.json') } }],
    ['the repository payload carries no permissions', { [REPO_ENDPOINT]: { stdout: '{"name":"specs"}' } }],
    ['the response is not JSON at all', { [REPO_ENDPOINT]: { stdout: '<html>proxy error</html>' } }],
    [
      'the pull request is not found',
      {
        [REPO_ENDPOINT]: { stdout: fixture('repo-write-access.json') },
        [PULL_ENDPOINT]: { exitCode: 1, stdout: fixture('error-not-found.json') },
      },
    ],
    [
      'the pull request names no author',
      {
        [REPO_ENDPOINT]: { stdout: fixture('repo-write-access.json') },
        [PULL_ENDPOINT]: { stdout: '{"number":7}' },
      },
    ],
  ];

  for (const [name, routes] of cases) {
    it(`refuses an author-only operation with 403 when ${name}`, async () => {
      const res = await call(router(gh(routes).exec), 'POST', '/doc-1/publish', { json: {}, markdown: '# x' });
      expect(res.status).toBe(403);
      expect((res.json as { error: string }).error).toContain('role could not be determined');
    });

    it(`still serves a reviewer-permitted operation when ${name}`, async () => {
      // Reviewer operations ask nothing, so a GitHub outage cannot block reading or
      // commenting — the failure is scoped to the decisions that actually need it.
      const res = await call(router(gh(routes).exec), 'POST', '/doc-1/comments', { comment: 'a note' });
      expect(res.status).toBe(200);
    });
  }

  it('a document store that throws is undeterminable, not permitted', async () => {
    const broken: DocumentStore = {
      async read() {
        throw new Error('disk gone');
      },
      async write() {},
      async list() {
        return [];
      },
      async resolveNode() {
        return { found: false };
      },
    };
    const verdict = await createCollabAuthorizer({ exec: asAuthor().exec, documents: () => broken })('publish', {
      documentId: 'doc-1',
      login: 'octocat',
      repo: { ...REPO },
    });
    expect(verdict).toEqual({ ok: false, status: 403, error: expect.stringContaining('role could not be determined') });
  });
});

/* ================================================================== *
 * Caching and its invalidation
 * ================================================================== */
describe('caching — a stale author verdict is bounded, a stale reviewer verdict is not costly', () => {
  it('the repo permission is probed once inside the TTL and re-probed after it', async () => {
    let clock = 1_000;
    const stub = asAuthor();
    const documents = memoryDocuments([document()]);
    const authorize = createCollabAuthorizer({
      exec: stub.exec,
      documents: () => documents,
      permissionTtlMs: 60_000,
      now: () => clock,
    });
    const ctx = { documentId: 'doc-1', login: 'octocat', repo: { ...REPO } };

    await authorize('publish', ctx);
    await authorize('publish', ctx);
    // Two calls, one permission probe and one PR probe.
    expect(stub.endpoints).toEqual([REPO_ENDPOINT, PULL_ENDPOINT]);

    clock += 60_001;
    await authorize('publish', ctx);
    // The permission is re-probed; the PR author is not, because it cannot change.
    expect(stub.endpoints).toEqual([REPO_ENDPOINT, PULL_ENDPOINT, REPO_ENDPOINT]);
  });

  it('a revoked write grant stops reading as author once the TTL expires', async () => {
    let clock = 1_000;
    let write = true;
    const endpoints: string[] = [];
    const exec: GhExecutor = async (args) => {
      const endpoint = args[args.length - 1] as string;
      endpoints.push(endpoint);
      if (endpoint === REPO_ENDPOINT) {
        return { stdout: fixture(write ? 'repo-write-access.json' : 'repo-read-only.json'), stderr: '', exitCode: 0 };
      }
      return { stdout: fixture('pull-author-octocat.json'), stderr: '', exitCode: 0 };
    };
    const authorize = createCollabAuthorizer({
      exec,
      documents: () => memoryDocuments([document()]),
      permissionTtlMs: 60_000,
      now: () => clock,
    });
    const ctx = { documentId: 'doc-1', login: 'octocat', repo: { ...REPO } };

    expect(await authorize('publish', ctx)).toEqual({ ok: true });
    write = false;
    // Still allowed inside the TTL — that window is the deliberate, bounded exposure.
    expect(await authorize('publish', ctx)).toEqual({ ok: true });
    clock += 60_001;
    expect((await authorize('publish', ctx)).ok).toBe(false);
  });

  it('a failed probe is never cached, so a transient error cannot pin a verdict', async () => {
    let failing = true;
    const exec: GhExecutor = async (args) => {
      const endpoint = args[args.length - 1] as string;
      if (failing) return { stdout: '', stderr: 'connection reset', exitCode: 1 };
      return {
        stdout: fixture(endpoint === REPO_ENDPOINT ? 'repo-write-access.json' : 'pull-author-octocat.json'),
        stderr: '',
        exitCode: 0,
      };
    };
    const authorize = createCollabAuthorizer({ exec, documents: () => memoryDocuments([document()]) });
    const ctx = { documentId: 'doc-1', login: 'octocat', repo: { ...REPO } };

    expect((await authorize('publish', ctx)).ok).toBe(false);
    failing = false;
    expect(await authorize('publish', ctx)).toEqual({ ok: true });
  });
});

/* ================================================================== *
 * R-9.6 — attribution. VERIFIED AGAINST 5.1/5.2's CODE, NOT REBUILT:
 * the comment goes through the real `githubCommentStore`, and the only
 * thing asserted is what that module actually puts on the wire.
 * ================================================================== */
describe('R-9.6 — comments are attributed to the acting account, never in the body', () => {
  it('the created comment body carries no participant identity, and the request has no author field', async () => {
    const inputs: string[] = [];
    const exec: GhExecutor = async (_args, input) => {
      if (input !== undefined) inputs.push(input);
      return { stdout: fixture('issue-comment-create.json'), stderr: '', exitCode: 0 };
    };
    const documents = memoryDocuments([document()]);
    const r = createCollabRoutes({
      jobs: createJobHubRegistry(),
      config: () => ENABLED,
      documents: () => documents,
      preflight: async () => PREFLIGHT,
      commentStore: ({ documentId, document: doc }) =>
        githubCommentStore({
          adapter: createGitHubAdapter(exec),
          repo: { owner: 'acme', repo: 'specs' },
          pullNumber: 7,
          documentId,
          documentPath: doc.documentPath,
        }),
      authorize: createCollabAuthorizer({ exec: asReviewer().exec, documents: () => documents }),
    });

    const res = await call(r, 'POST', '/doc-1/comments', { comment: 'Tighten this paragraph.', nodeId: 'n-7' });
    expect(res.status).toBe(200);

    // GitHub's own API has no author field on a comment create — attribution is the
    // credential's, natively. Assert the request never tries to supply one anyway.
    const sent = JSON.parse(inputs[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(['body']);
    const body = sent.body as string;
    expect(body).not.toContain('octocat');
    expect(body).not.toMatch(/\b(login|author|user|actor)=/);
    // The trailer that IS present carries document coordinates only.
    expect(body).toContain('<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->');
  });

  it('the attributed user is read back from GitHub, not asserted by this package', async () => {
    // `issue-comment-create.json` was recorded as `reviewer-rita`; the projection
    // reports that, not the configured login — proof the identity is GitHub's.
    const saved = (
      (await githubCommentStore({
        adapter: createGitHubAdapter(async () => ({ stdout: fixture('issue-comment-create.json'), stderr: '', exitCode: 0 })),
        repo: { owner: 'acme', repo: 'specs' },
        pullNumber: 7,
        documentId: 'doc-1',
        documentPath: 'docs/spec.md',
      }).addComment?.({ ...SEED, comment: 'Tighten this paragraph.' })) as { github?: { user?: string } } | undefined
    )?.github;
    expect(saved?.user).toBe('reviewer-rita');
  });
});

/*
 * `writeAccess` is a display hint for the availability snapshot (R-9.7). It answers
 * the repo-permission half of the author rule only, and it never speaks for the
 * verdict — a `true` here still meets a `deny` at publish time if the PR has a
 * different author. Its third answer, `null`, means "could not determine", and the
 * UI must render nothing rather than guess.
 *
 * R-12.5 — a `false` also carries which "no" it is, because a missing write grant and
 * a repo that cannot be found need different words from the panel.
 */
describe('writeAccess — the availability hint', () => {
  it('reports true for a login with push permission', async () => {
    const authorize = createCollabAuthorizer({ exec: asAuthor().exec, documents: () => memoryDocuments([document()]) });
    expect(await authorize.writeAccess?.({ ...REPO })).toEqual({ write: true });
  });

  it('reports false for a read-only login, naming the missing grant', async () => {
    const authorize = createCollabAuthorizer({ exec: asReviewer().exec, documents: () => memoryDocuments([document()]) });
    const verdict = await authorize.writeAccess?.({ ...REPO });
    expect(verdict).toMatchObject({ write: false, reason: 'no_write_access' });
    expect(verdict && 'message' in verdict && verdict.message).toContain(`${REPO.owner}/${REPO.repo}`);
  });

  /*
   * A 404 is not an outage — it is the one "no" with a fix the author can act on, so it
   * must not collapse into the undeterminable bucket where the panel says nothing.
   */
  it('reports a missing repository as its own blocked reason, not as undeterminable', async () => {
    // `gh`'s real wording — the status is parsed out of the parenthesised code.
    const exec: GhExecutor = async () => ({ stdout: '', stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 });
    const authorize = createCollabAuthorizer({ exec, documents: () => memoryDocuments([document()]) });
    const verdict = await authorize.writeAccess?.({ ...REPO });
    expect(verdict).toMatchObject({ write: false, reason: 'no_repo' });
    expect(verdict && 'message' in verdict && verdict.message).toContain('visual-spec.config.ts');
  });

  it('reports null — not false — when the permission cannot be read', async () => {
    const exec: GhExecutor = async () => ({ stdout: '', stderr: 'gh: Forbidden (HTTP 403)', exitCode: 1 });
    const authorize = createCollabAuthorizer({ exec, documents: () => memoryDocuments([document()]) });
    expect(await authorize.writeAccess?.({ ...REPO })).toEqual({ write: null, reason: 'unknown' });
  });

  it('shares the permission cache with the verdict path, so the hint costs no extra probe', async () => {
    const stub = asAuthor();
    const authorize = createCollabAuthorizer({
      exec: stub.exec,
      documents: () => memoryDocuments([document()]),
      permissionTtlMs: 60_000,
      now: () => 1_000,
    });
    await authorize.writeAccess?.({ ...REPO });
    await authorize('publish', { documentId: 'doc-1', login: 'octocat', repo: { ...REPO } });
    // One permission read, then only the PR probe the verdict additionally needs.
    expect(stub.endpoints).toEqual([REPO_ENDPOINT, PULL_ENDPOINT]);
  });
});
