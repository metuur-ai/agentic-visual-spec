/**
 * collab-open.test.ts — SC-4, simulated: the read-only participant completes
 * open → read → comment (R-11.2, R-11.3, R-11.4, R-11.5).
 *
 * WHAT SC-4 ASKS FOR AND WHAT THIS IS. The verification the task names is "two machines,
 * two credentials, one read-only". A test process cannot be two machines, so what runs
 * here is the *reviewer's* machine only: a server whose local document store starts
 * empty (nothing was ever created here) driven by a credential whose `gh` executor
 * answers every write endpoint with 403, exactly as GitHub answers a credential with
 * read-only repository permission.
 *
 * WHAT THAT ESTABLISHES: that the open → read → comment sequence completes with no local
 * copy and reaches no endpoint a read-only credential is refused. WHAT IT DOES NOT:
 * anything about a second process, real `gh`, real GitHub permission enforcement, or the
 * author's machine observing the reviewer's comment. Those need the manual SC-4 run.
 *
 * The host is assembled the way `src/server.ts` assembles it — `createCollabWiring` then
 * `createCollabRoutes({ bodies: wiring.bodies })` — so this drives the shipped wiring,
 * not a private arrangement of it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { githubCommentStore } from '../../collaboration/comment-projection';
import { preflightCollaboration } from '../../collaboration/credentials';
import type { CollaborationDocument } from '../../collaboration/document-protocol';
import { serializeCollaborationDocument } from '../../collaboration/document-protocol';
import type { DocumentStore } from '../../collaboration/document-store';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import type { GhExecutor } from '../../collaboration/github-executor';
import type { SseSink } from '../../collaboration/job-hub';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { IntervalScheduler } from '../../collaboration/lifecycle';
import { buildPullRequestBody } from '../../collaboration/lifecycle';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabAvailability, type CollabRouteResult, createCollabRoutes } from './collab';
import { createCollabWiring } from './collab-wiring';

/** Test double. This suite is about the reviewer open path, not gating; the router requires one. */
const TEST_ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../collaboration/fixtures');
const fixture = (name: string): string => readFileSync(resolve(fixturesDir, name), 'utf8');

const REPO = { owner: 'acme', repo: 'docs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO } };
const BRANCH = 'visual-spec/doc-1';

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;
const methodOf = (args: string[]): string => args[args.indexOf('--method') + 1] as string;

/** The document as it exists **only on the branch** — never on the reviewer's disk. */
const REMOTE_DOC: CollaborationDocument = {
  documentId: 'doc-1',
  documentPath: 'documents/doc-1.json',
  title: 'Onboarding guide',
  frontmatter: { title: 'Onboarding guide' },
  nodes: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'Install the CLI first.' }],
  doc: { root: { children: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'Install the CLI first.' }] } },
};

const PULL = JSON.stringify({
  number: 42,
  state: 'open',
  html_url: 'https://github.com/acme/docs/pull/42',
  body: buildPullRequestBody({
    repo: { owner: REPO.owner, repo: REPO.repo },
    branch: BRANCH,
    documentId: REMOTE_DOC.documentId,
    documentPath: REMOTE_DOC.documentPath,
    title: REMOTE_DOC.title,
  }),
  head: { ref: BRANCH, sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432' },
  base: { ref: 'main', sha: '5f2a1c9b8d4e6f0a1b2c3d4e5f60718293a4b5c6' },
});

const CONTENTS = JSON.stringify({
  name: 'doc-1.json',
  path: REMOTE_DOC.documentPath,
  sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  type: 'file',
  encoding: 'base64',
  content: Buffer.from(serializeCollaborationDocument(REMOTE_DOC), 'utf8').toString('base64'),
});

const FORBIDDEN = JSON.stringify({ message: 'Resource not accessible by personal access token', status: '403' });

/**
 * A **read-only credential**, simulated the way GitHub actually behaves: every read
 * succeeds, and every endpoint that requires push permission answers 403. Posting an
 * issue comment is a read-access operation on GitHub and is therefore allowed — that is
 * precisely the R-11.3 claim ("SHALL NOT require write access to view or comment").
 */
function readOnlyGh() {
  const calls: Array<{ method: string; endpoint: string }> = [];
  const refused: string[] = [];
  const exec: GhExecutor = async (args) => {
    const endpoint = endpointOf(args);
    const method = args.includes('--method') ? methodOf(args) : 'GET';
    calls.push({ method, endpoint });
    const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

    if (endpoint === '/user') return ok(fixture('user-inclusive-reviewer.txt'));
    if (method === 'GET' && endpoint === '/repos/acme/docs/pulls/42') return ok(PULL);
    if (method === 'GET' && endpoint.startsWith('/repos/acme/docs/contents/documents/doc-1.json')) return ok(CONTENTS);
    if (method === 'GET' && endpoint.startsWith('/repos/acme/docs/issues/42/comments')) return ok('[]');
    if (method === 'POST' && endpoint === '/repos/acme/docs/issues/42/comments') return ok(fixture('issue-comment-create.json'));

    // Anything left needs push access. A read-only credential is refused here, and the
    // assertions below require that this branch is never taken.
    refused.push(`${method} ${endpoint}`);
    return { stdout: FORBIDDEN, stderr: 'gh: Resource not accessible (HTTP 403)', exitCode: 1 };
  };
  return { exec, calls, refused };
}

/** The reviewer's machine: the document store starts **empty** (R-11.2). */
function emptyDocuments(): DocumentStore & { docs: Map<string, CollaborationDocument> } {
  const docs = new Map<string, CollaborationDocument>();
  return {
    docs,
    async read(id) {
      return docs.get(id) ?? null;
    },
    async write(doc) {
      docs.set(doc.documentId, doc);
    },
    async list() {
      return [...docs.keys()].sort();
    },
    async resolveNode() {
      return { found: false };
    },
  };
}

function reviewerHost() {
  const gh = readOnlyGh();
  const documents = emptyDocuments();
  const jobs = createJobHubRegistry();
  const ticks: Array<{ fn: () => void; cancelled: boolean }> = [];
  const scheduler: IntervalScheduler = (fn) => {
    const entry = { fn, cancelled: false };
    ticks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const wiring = createCollabWiring({
    config: () => ENABLED,
    documents: () => documents,
    jobs,
    exec: gh.exec,
    scheduler,
  });
  const adapter = createGitHubAdapter(gh.exec);
  const router = createCollabRoutes({
    jobs,
    config: () => ENABLED,
    documents: () => documents,
    bodies: wiring.bodies,
    authorize: TEST_ALLOW_ALL,
    // The real 4.2 preflight, driven by the reviewer's own `gh` — so `login` below is
    // resolved exactly as it is in production (R-11.5).
    preflight: (repo) => preflightCollaboration({ repo, exec: gh.exec, env: {} }),
    // Same store the default builds, with the injected executor so no real `gh` runs.
    commentStore: ({ documentId, document }) =>
      githubCommentStore({ adapter, repo: { owner: REPO.owner, repo: REPO.repo }, pullNumber: 42, documentId, documentPath: document.documentPath }),
  });
  const call = (method: string, pathname: string, body: Record<string, unknown> = {}, sse?: SseSink): Promise<CollabRouteResult> =>
    router.handle({ method, pathname, query: {}, body, ...(sse ? { sse } : {}) });
  return { call, gh, documents, wiring, ticks };
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

/** A minimal SSE sink whose `close` can be run on demand, to model a tab going away. */
function reviewerSink() {
  const closers: Array<() => void> = [];
  const s: SseSink = {
    writeHead() {},
    write() {},
    on(_event: 'close', cb: () => void) {
      closers.push(cb);
    },
    end() {},
    writableEnded: false,
  };
  return Object.assign(s, {
    close: () => {
      for (const cb of closers) cb();
    },
  });
}

describe('SC-4 (simulated) — a read-only reviewer completes open → read → comment', () => {
  it('opens a document it has never seen, reads it back, and comments on it', async () => {
    const h = reviewerHost();
    expect(h.documents.docs.size).toBe(0);

    /* open — R-11.2 */
    const opened = await h.call('POST', '/open', { documentId: 'doc-1', pullNumber: 42 });
    expect(opened.status).toBe(200);
    await settled();
    expect(h.documents.docs.get('doc-1')).toMatchObject({ documentId: 'doc-1', title: 'Onboarding guide' });

    /* read — the route the reviewer's UI loads the document through */
    const read = (await h.call('GET', '/doc-1')) as { status: number; json: { state: string; document: unknown } };
    expect(read.status).toBe(200);
    expect(read.json.state).toBe('pr-open');
    expect(read.json.document).toMatchObject({
      documentId: 'doc-1',
      documentPath: 'documents/doc-1.json',
      github: { branch: BRANCH, pullNumber: 42 },
    });

    /* comment — R-11.3, posted as a PR issue comment */
    const commented = (await h.call('POST', '/doc-1/comments', { comment: 'Tighten this paragraph.', nodeId: 'n-7' })) as {
      status: number;
      json: { ok: boolean; id: string };
    };
    expect(commented.status).toBe(200);
    expect(commented.json.ok).toBe(true);

    /* R-11.3 — nothing on that path needed push access. */
    expect(h.gh.refused).toEqual([]);
    const mutating = h.gh.calls.filter((c) => c.method !== 'GET');
    expect(mutating).toEqual([{ method: 'POST', endpoint: '/repos/acme/docs/issues/42/comments' }]);
    // Named explicitly, because these are the four a read-only credential must never see.
    expect(h.gh.calls.some((c) => c.endpoint.endsWith('/git/refs'))).toBe(false);
    expect(h.gh.calls.some((c) => c.method === 'PUT' && c.endpoint.includes('/contents/'))).toBe(false);
    expect(h.gh.calls.some((c) => c.method === 'POST' && c.endpoint.endsWith('/pulls'))).toBe(false);
    expect(h.gh.calls.some((c) => c.endpoint.endsWith('/merge'))).toBe(false);
  });

  it('shows the reviewer their own GitHub identity, so attribution is never a surprise (R-11.5)', async () => {
    const h = reviewerHost();
    const res = (await h.call('GET', '')) as { status: number; json: CollabAvailability };
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ available: true, login: 'reviewer-rita', repo: { owner: 'acme', repo: 'docs' } });
  });

  it('polls the opened document once the reviewer is watching it, so the author’s replies arrive without a reload', async () => {
    const h = reviewerHost();
    await h.call('POST', '/open', { documentId: 'doc-1', pullNumber: 42 });
    await settled();

    // R-8.6 — `open` no longer starts the poller on its own. A reviewer who opened the
    // document on the CLI and never attached a browser is nobody watching, and polling
    // GitHub on their behalf would buy nothing but rate limit.
    expect(h.wiring.pollingDocumentIds()).toEqual([]);

    // Their browser attaching to the SSE stream is what starts it — the same call the
    // editor makes on load.
    const s = reviewerSink();
    await h.call('GET', '/doc-1/events', {}, s);
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);

    // Closing the tab stops it, and reopening starts it again.
    s.close();
    expect(h.wiring.pollingDocumentIds()).toEqual([]);
    await h.call('GET', '/doc-1/events', {}, reviewerSink());
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);

    // …and shutdown remains the backstop for whatever is still attached.
    h.wiring.stopAllPolling();
    expect(h.wiring.pollingDocumentIds()).toEqual([]);
  });

  it('reports a pull request the credential cannot read as exactly that (R-11.4)', async () => {
    const h = reviewerHost();
    // #7 is not in the read-only fixture's allow-list, so `gh` answers 403 — the shape a
    // credential without read access to the repository gets back.
    await h.call('POST', '/open', { documentId: 'doc-1', pullNumber: 7 });
    await settled();
    const snapshot = (await h.call('GET', '/doc-1')) as { json: { state: string; events: Array<{ type: string; message?: string }> } };
    expect(snapshot.json.state).toBe('failed');
    const error = snapshot.json.events.find((e) => e.type === 'job-error');
    expect(error?.message).toBe(
      'cannot open acme/docs#7: read access denied (HTTP 403) — this credential can reach GitHub but not acme/docs.',
    );
    // The failure did not leave a half-written document behind.
    expect(h.documents.docs.size).toBe(0);
  });
});
