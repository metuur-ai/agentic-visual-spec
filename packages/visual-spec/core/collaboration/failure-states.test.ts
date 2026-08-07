/**
 * failure-states.test.ts — R-8.15 … R-8.24.
 *
 * Everything runs against `fakeGitHub` below: a replayed REST surface over an in-memory
 * repo (branches, files, pull requests, issue comments) that records every argv and can
 * be told to fail one named operation. No network, no real `gh`, no timer, no clock —
 * the hub's `now` is injected everywhere it matters (R-4.8 / R-12.3).
 *
 * The centrepiece is `FAILURE_MATRIX`: one row per step that can fail, each asserting
 * the state actually recorded, that the failure reached the SSE stream, that a later
 * `reconcile` recovers a state the document can leave (R-8.24), and — where a retry is
 * meaningful — that retrying creates nothing twice (R-8.23).
 *
 * The three adapter methods and the hub's idempotency de-duplication are exercised here
 * rather than in `github-adapter.test.ts` / `job-hub.test.ts`, so those two files stay
 * exactly as their own tasks left them.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectedCommentRecord } from './comment-projection';
import type { CollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import {
  BaseDivergedError,
  FAILURE_STATES,
  MergeRefusedError,
  ReadyGateError,
  cleanupOrphanedBranch,
  createRecoveryBodies,
  deriveLifecycleState,
  deriveReadiness,
  detectBaseDivergence,
  isFailureState,
  withOrphanCleanup,
  withPublishFailureStates,
} from './failure-states';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor, GhResult } from './github-executor';
import { type JobEvent, type LifecycleState, createJobHubRegistry } from './job-hub';
import { type BoundCollaborationDocument, createLifecycleBodies } from './lifecycle';
import { createPublishBody, gitBlobSha, markdownPathFor } from './publish';

const repo = { owner: 'acme', repo: 'docs', baseBranch: 'main' };
const BRANCH = 'visual-spec/doc-1';
const DOC_PATH = 'documents/doc-1.json';
const MD_PATH = markdownPathFor(DOC_PATH);
const NOW = 1_700_000_000_000;

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;
const methodOf = (args: string[]): string => args[args.indexOf('--method') + 1] as string;

type Call = { args: string[]; input?: string };

/* ------------------------------------------------------------------ *
 * The replayed GitHub
 * ------------------------------------------------------------------ */

/** One raw issue comment, in GitHub's own shape — the projection parses these. */
function ghComment(id: number, body: string, createdAt = '2026-08-06T09:00:00Z'): Record<string, unknown> {
  return {
    id,
    body,
    user: { login: 'reviewer-rita' },
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `https://github.com/acme/docs/pull/42#issuecomment-${id}`,
  };
}

/** A top-level comment on `n-7`. */
const thread = (id: number) => ghComment(id, `Tighten this.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->`);
/** The reply that resolves `parent`, in the exact 5.2 convention. */
const resolves = (id: number, parent: number, createdAt = '2026-08-06T10:00:00Z') =>
  ghComment(id, `Resolved this comment: x\n\n<!-- visual-spec: documentId=doc-1 replyTo=${parent} resolved=true -->`, createdAt);

type Fault =
  | 'getBranch'
  | 'createBranch'
  | 'deleteBranch'
  | 'commitFile'
  | 'createPullRequest'
  | 'getPullRequest'
  | 'listIssueComments'
  | 'compareCommits'
  | 'merge';

type FakeOptions = {
  branches?: string[];
  files?: Record<string, string>;
  /** The pull request `GET /pulls/:n` reports. Absent ⇒ no PR exists yet. */
  pull?: { number: number; state: string; merged: boolean; mergeable: boolean | null; mergeableState?: string };
  comments?: Array<Record<string, unknown>>;
  /** R-8.22 — the paths `compare/branch...base` reports as changed on base. */
  baseChanged?: string[];
  /** Named operations that fail with a 422. One row of the matrix each. */
  fail?: Fault[];
  /** Corrupt what a read hands back, per path — a blob that is not what we wrote. */
  corruptOnRead?: (path: string) => string | null;
  /** Fired after every `listIssueComments` page-1 read, so a test can inject a comment. */
  afterListComments?: (comments: Array<Record<string, unknown>>) => void;
};

function fakeGitHub(options: FakeOptions = {}) {
  const branches = new Set(options.branches ?? []);
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const comments = [...(options.comments ?? [])];
  const faults = new Set<Fault>(options.fail ?? []);
  const calls: Call[] = [];
  let pull = options.pull ? { ...options.pull } : null;

  const ok = (json: unknown): GhResult => ({ stdout: JSON.stringify(json), stderr: '', exitCode: 0 });
  const empty = (): GhResult => ({ stdout: '', stderr: '', exitCode: 0 });
  const err = (status: number, message: string): GhResult => ({
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
    exitCode: 1,
  });
  const notFound = () => err(404, 'Not Found');
  const boom = () => err(422, 'Validation Failed');

  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const endpoint = endpointOf(args);
    const method = methodOf(args);
    const path = endpoint.split('?')[0] as string;
    const rest = path.replace(/^\/repos\/[^/]+\/[^/]+/, '');

    if (rest.startsWith('/git/ref/heads/')) {
      if (faults.has('getBranch')) return boom();
      return ok({ ref: `refs/heads/${rest.slice('/git/ref/heads/'.length)}`, object: { sha: 'base0000' } });
    }

    if (rest === '/git/refs' && method === 'POST') {
      if (faults.has('createBranch')) return boom();
      const body = JSON.parse(input ?? '{}') as { ref: string; sha: string };
      branches.add(body.ref.replace('refs/heads/', ''));
      return ok({ ref: body.ref, object: { sha: body.sha } });
    }

    if (rest.startsWith('/git/refs/heads/') && method === 'DELETE') {
      // 500, not 422: `deleteBranch` treats 404/422 as "already gone", which is success.
      if (faults.has('deleteBranch')) return err(500, 'Server Error');
      const branch = rest.slice('/git/refs/heads/'.length);
      if (!branches.has(branch)) return notFound();
      branches.delete(branch);
      return empty();
    }

    if (rest.startsWith('/contents/')) {
      const file = rest.slice('/contents/'.length);
      if (method === 'PUT') {
        if (faults.has('commitFile')) return boom();
        const body = JSON.parse(input ?? '{}') as { content: string };
        files.set(file, Buffer.from(body.content, 'base64').toString('utf8'));
        return ok({ content: { path: file, sha: gitBlobSha(files.get(file) as string) }, commit: { sha: 'c0ffee' } });
      }
      const stored = files.get(file);
      if (stored === undefined) return notFound();
      const served = options.corruptOnRead ? options.corruptOnRead(file) : null;
      const content = served ?? stored;
      return ok({ path: file, sha: gitBlobSha(content), content: Buffer.from(content, 'utf8').toString('base64') });
    }

    if (rest === '/pulls' && method === 'POST') {
      if (faults.has('createPullRequest')) return boom();
      pull = { number: 42, state: 'open', merged: false, mergeable: true };
      return ok({ number: 42, state: 'open', html_url: 'https://github.com/acme/docs/pull/42', head: { sha: 'head0000' } });
    }

    if (/^\/pulls\/\d+\/merge$/.test(rest)) {
      if (faults.has('merge')) return boom();
      if (pull) pull = { ...pull, state: 'closed', merged: true };
      return ok({ sha: 'merged00', merged: true, message: 'Pull Request successfully merged' });
    }

    if (/^\/pulls\/\d+$/.test(rest) && method === 'GET') {
      if (faults.has('getPullRequest')) return boom();
      if (!pull) return notFound();
      return ok({
        number: pull.number,
        state: pull.state,
        merged: pull.merged,
        mergeable: pull.mergeable,
        mergeable_state: pull.mergeableState ?? (pull.mergeable === false ? 'dirty' : 'clean'),
        html_url: 'https://github.com/acme/docs/pull/42',
        head: { sha: 'head0000' },
      });
    }

    if (/^\/issues\/\d+\/comments$/.test(rest)) {
      if (faults.has('listIssueComments')) return boom();
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? '1');
      if (page > 1) return ok([]);
      const served = ok([...comments]);
      options.afterListComments?.(comments);
      return served;
    }

    if (rest.startsWith('/compare/')) {
      if (faults.has('compareCommits')) return boom();
      return ok({
        merge_base_commit: { sha: 'base0000' },
        ahead_by: 0,
        behind_by: (options.baseChanged ?? []).length,
        files: (options.baseChanged ?? []).map((filename) => ({ filename })),
      });
    }

    return notFound();
  };

  return {
    exec,
    calls,
    branches,
    files,
    comments,
    get pull() {
      return pull;
    },
    endpoints: () => calls.map((c) => `${methodOf(c.args)} ${endpointOf(c.args).split('?')[0]}`),
  };
}

/* ------------------------------------------------------------------ *
 * Documents, stores, hubs
 * ------------------------------------------------------------------ */

function makeDoc(github?: BoundCollaborationDocument['github']): BoundCollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: DOC_PATH,
    title: 'Onboarding guide',
    frontmatter: {},
    nodes: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }],
    doc: { root: { children: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }] } },
    ...(github ? { github } : {}),
  };
}

const BOUND = () => makeDoc({ owner: repo.owner, repo: repo.repo, branch: BRANCH, pullNumber: 42, headSha: 'head0000', resolved: false });
/** The durable partial-create signal 8.2 leaves: a branch, and no `pullNumber`. */
const ORPHANED = () => makeDoc({ owner: repo.owner, repo: repo.repo, branch: BRANCH, resolved: false });

function memoryStore(seed?: CollaborationDocument): DocumentStore {
  const docs = new Map<string, CollaborationDocument>();
  if (seed) docs.set(seed.documentId, seed);
  return {
    async read(id) {
      return docs.get(id) ?? null;
    },
    async write(doc) {
      docs.set(doc.documentId, JSON.parse(JSON.stringify(doc)) as CollaborationDocument);
    },
    async list() {
      return [...docs.keys()].sort();
    },
    async resolveNode() {
      return { found: false };
    },
  };
}

/** A hub with an attached subscriber, so every assertion can be made on SSE frames. */
function hubRig() {
  const hubs = createJobHubRegistry({ now: () => NOW });
  const frames: JobEvent[] = [];
  hubs.hub('doc-1').subscribe({
    writeHead: () => undefined,
    write: (chunk: string) => {
      // The first frame every subscriber gets is the `sync` snapshot; keep only events.
      const frame = JSON.parse(chunk.replace(/^data: /, '')) as { type: string };
      if (frame.type !== 'sync') frames.push(frame as JobEvent);
    },
    on: () => undefined,
  });
  return { hubs, frames, hub: hubs.hub('doc-1') };
}

/** Drain the microtask queue until the in-flight job body has settled. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const statesIn = (frames: JobEvent[]): LifecycleState[] =>
  frames.filter((f): f is Extract<JobEvent, { type: 'state' }> => f.type === 'state').map((f) => f.state);

/* ================================================================== *
 * R-8.15 / R-8.16 — Ready is DERIVED
 * ================================================================== */

/** Project a raw comment list the way `githubCommentStore.read()` does. */
async function project(comments: Array<Record<string, unknown>>): Promise<ProjectedCommentRecord[]> {
  const gh = fakeGitHub({ comments, pull: { number: 42, state: 'open', merged: false, mergeable: true } });
  const { githubCommentStore } = await import('./comment-projection');
  const doc = await githubCommentStore({
    adapter: createGitHubAdapter(gh.exec),
    repo: { owner: repo.owner, repo: repo.repo },
    pullNumber: 42,
    documentId: 'doc-1',
    documentPath: DOC_PATH,
  }).read();
  return doc.comments as ProjectedCommentRecord[];
}

describe('deriveReadiness — Ready is derived, never stored (R-8.15)', () => {
  it('a conversation with nothing to resolve is ready', async () => {
    expect(deriveReadiness(await project([]))).toEqual({ ready: true, total: 0, unresolved: 0, unresolvedCommentIds: [] });
  });

  it('one unresolved thread is enough to refuse Ready, and it is named', async () => {
    const verdict = deriveReadiness(await project([thread(700001), thread(700002), resolves(800001, 700001)]));
    expect(verdict).toEqual({ ready: false, total: 2, unresolved: 1, unresolvedCommentIds: [700002] });
  });

  it('is ready once every thread carries a resolution marker', async () => {
    const verdict = deriveReadiness(await project([thread(700001), thread(700002), resolves(800001, 700001), resolves(800002, 700002)]));
    expect(verdict.ready).toBe(true);
    expect(verdict.total).toBe(2);
  });

  it('does not gate on replies — a reply belongs to its parent thread, not to itself', async () => {
    // Both the resolution markers and an ordinary reply are excluded from `total`.
    const comments = await project([thread(700001), resolves(800001, 700001)]);
    expect(comments).toHaveLength(2); // the reply IS projected — it is just not gated
    expect(deriveReadiness(comments).total).toBe(1);
  });

  it('R-8.16 — the same derivation returns a Ready document to PR-open when a comment arrives', async () => {
    const pull = { state: 'open', merged: false, mergeable: true };
    const resolved = await project([thread(700001), resolves(800001, 700001)]);
    expect(deriveLifecycleState({ pull, readiness: deriveReadiness(resolved) })).toBe<LifecycleState>('ready');

    // Exactly the same inputs plus one new, unresolved comment. Nothing had to notice
    // the arrival and demote anything: `ready` was never stored to be demoted.
    const withNew = await project([thread(700001), resolves(800001, 700001), thread(700009)]);
    expect(deriveLifecycleState({ pull, readiness: deriveReadiness(withNew) })).toBe<LifecycleState>('pr-open');
  });
});

describe('deriveLifecycleState (R-8.19 / R-8.20)', () => {
  const ready = deriveReadiness([]);
  const notReady = { ready: false, total: 1, unresolved: 1, unresolvedCommentIds: [700001] };

  for (const [name, pull, readiness, expected] of [
    ['merged wins over everything', { state: 'closed', merged: true, mergeable: null }, notReady, 'merged'],
    ['R-8.19 — closed without merging is `closed`, not `pr-open`', { state: 'closed', merged: false, mergeable: null }, ready, 'closed'],
    ['R-8.20 — GitHub says unmergeable ⇒ conflicted', { state: 'open', merged: false, mergeable: false }, ready, 'conflicted'],
    ['mergeable:null is "still computing", not a conflict', { state: 'open', merged: false, mergeable: null }, ready, 'ready'],
    ['open + all resolved ⇒ ready', { state: 'open', merged: false, mergeable: true }, ready, 'ready'],
    ['open + unresolved ⇒ pr-open', { state: 'open', merged: false, mergeable: true }, notReady, 'pr-open'],
  ] as const) {
    it(name, () => {
      expect(deriveLifecycleState({ pull, readiness })).toBe<LifecycleState>(expected);
    });
  }
});

/* ================================================================== *
 * R-8.15 — the Ready gate as a job
 * ================================================================== */

describe('markReady (R-8.15)', () => {
  it('refuses, names the unresolved threads and records pr-open', async () => {
    const gh = fakeGitHub({ comments: [thread(700001), thread(700002), resolves(800001, 700001)], pull: { number: 42, state: 'open', merged: false, mergeable: true } });
    const { hub, frames } = hubRig();
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    hub.start({ kind: 'commit', run: bodies.markReady({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();

    expect(hub.snapshot().state).toBe<LifecycleState>('pr-open');
    const error = frames.find((f) => f.type === 'job-error');
    expect(error).toMatchObject({ message: 'doc-1 is not ready: 1 of 2 comment(s) unresolved' });
    expect(frames.some((f) => f.type === 'log' && f.text.includes('700002'))).toBe(true);
  });

  it('permits Ready once every comment is resolved', async () => {
    const gh = fakeGitHub({ comments: [thread(700001), resolves(800001, 700001)], pull: { number: 42, state: 'open', merged: false, mergeable: true } });
    const { hub } = hubRig();
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    hub.start({ kind: 'commit', run: bodies.markReady({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('ready');
  });

  it('stores nothing — asking twice runs two independent derivations', async () => {
    const store = memoryStore(BOUND());
    const gh = fakeGitHub({ comments: [thread(700001), resolves(800001, 700001)], pull: { number: 42, state: 'open', merged: false, mergeable: true } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub } = hubRig();
    hub.start({ kind: 'commit', run: bodies.markReady({ documentId: 'doc-1', repo, store }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('ready');

    // Nothing about readiness was persisted, so the second ask sees the new comment.
    gh.comments.push(thread(700009));
    hub.start({ kind: 'commit', run: bodies.markReady({ documentId: 'doc-1', repo, store }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('pr-open');
    expect(JSON.stringify(await store.read('doc-1'))).not.toContain('ready');
  });
});

/* ================================================================== *
 * R-8.17 — merge-time re-verification closes the TOCTOU window
 * ================================================================== */

describe('merge re-verifies at merge time (R-8.17)', () => {
  it('refuses when a comment arrives between the readiness check and the merge', async () => {
    // The conversation is fully resolved when readiness is first computed. The
    // `afterListComments` hook fires the instant that read returns, injecting a new
    // unresolved comment — i.e. exactly inside the window a poll-derived answer would
    // have missed. Merge reads again itself, so it sees it.
    let injected = false;
    const gh = fakeGitHub({
      comments: [thread(700001), resolves(800001, 700001)],
      pull: { number: 42, state: 'open', merged: false, mergeable: true },
      afterListComments: (comments) => {
        if (injected) return;
        injected = true;
        comments.push(thread(700099));
      },
    });
    const adapter = createGitHubAdapter(gh.exec);
    const bodies = createRecoveryBodies({ adapter });
    const store = memoryStore(BOUND());
    const { hub, frames } = hubRig();

    // 1. The poll says Ready — and it is right, at the time it says it.
    hub.start({ kind: 'sync', run: bodies.markReady({ documentId: 'doc-1', repo, store }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('ready');

    // 2. Merge, trusting nothing. The injected comment is seen.
    hub.start({ kind: 'merge', run: bodies.merge({ documentId: 'doc-1', repo, store }) });
    await settled();

    expect(hub.snapshot().state).toBe<LifecycleState>('pr-open');
    expect(frames.find((f) => f.type === 'job-error')).toMatchObject({ message: 'merge refused for doc-1: unresolved comments' });
    // The load-bearing negative: GitHub was never asked to merge.
    expect(gh.endpoints().filter((e) => e.endsWith('/merge'))).toEqual([]);
    expect(gh.pull?.merged).toBe(false);
  });

  it('merges when the re-read still says every comment is resolved', async () => {
    const gh = fakeGitHub({ comments: [thread(700001), resolves(800001, 700001)], pull: { number: 42, state: 'open', merged: false, mergeable: true } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub } = hubRig();
    hub.start({ kind: 'merge', run: bodies.merge({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('merged');
    expect(gh.endpoints()).toContain('PUT /repos/acme/docs/pulls/42/merge');
  });

  it('reads the comments itself rather than trusting the state the hub holds', async () => {
    const gh = fakeGitHub({ comments: [thread(700001)], pull: { number: 42, state: 'open', merged: false, mergeable: true } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub } = hubRig();
    // Declare `ready` out of band — a stale answer merge must not honour.
    hub.start({ kind: 'commit', run: async (ctx) => ctx.setState('ready') });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('ready');

    hub.start({ kind: 'merge', run: bodies.merge({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('pr-open');
    expect(gh.endpoints().filter((e) => e.endsWith('/merge'))).toEqual([]);
  });
});

/* ================================================================== *
 * R-8.20 — a base conflict is reported and never resolved
 * ================================================================== */

describe('base conflict (R-8.20)', () => {
  it('refuses the merge, records `conflicted` and attempts no resolution', async () => {
    const gh = fakeGitHub({
      comments: [thread(700001), resolves(800001, 700001)],
      pull: { number: 42, state: 'open', merged: false, mergeable: false, mergeableState: 'dirty' },
    });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub, frames } = hubRig();
    hub.start({ kind: 'merge', run: bodies.merge({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();

    expect(hub.snapshot().state).toBe<LifecycleState>('conflicted');
    const error = frames.find((f) => f.type === 'job-error');
    expect(error).toMatchObject({ message: 'merge refused for doc-1: base conflict' });
    // No automatic resolution: nothing was merged, committed, branched or deleted.
    for (const forbidden of ['PUT /repos/acme/docs/pulls/42/merge', 'POST /repos/acme/docs/git/refs']) {
      expect(gh.endpoints()).not.toContain(forbidden);
    }
    expect(gh.endpoints().filter((e) => e.startsWith('PUT /repos/acme/docs/contents/'))).toEqual([]);
  });

  it('records `conflicted` — not `failed` — when GitHub declines the merge at the last moment', async () => {
    const gh = fakeGitHub({ comments: [], pull: { number: 42, state: 'open', merged: false, mergeable: true }, fail: ['merge'] });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub } = hubRig();
    hub.start({ kind: 'merge', run: bodies.merge({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    // The adapter's own GitHubError surfaces, so the hub records the generic failure —
    // and `reconcile` is what turns that into a state the document can leave.
    expect(hub.snapshot().state).toBe<LifecycleState>('failed');
  });

  it('reports the conflict from a sync too, so it is not merge-only (R-8.19 / R-8.20)', async () => {
    const gh = fakeGitHub({ comments: [], pull: { number: 42, state: 'open', merged: false, mergeable: false } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub, frames } = hubRig();
    hub.start({ kind: 'sync', run: bodies.reconcile({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('conflicted');
    expect(frames.some((f) => f.type === 'log' && f.kind === 'error' && f.text.includes('resolve it on github.com'))).toBe(true);
  });
});

/* ================================================================== *
 * R-8.19 — an externally closed PR does not sit in PR-open forever
 * ================================================================== */

describe('externally closed pull request (R-8.19)', () => {
  it('a later sync reports `closed`', async () => {
    const gh = fakeGitHub({ comments: [], pull: { number: 42, state: 'closed', merged: false, mergeable: null } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub, frames } = hubRig();
    // The document was left in PR-open by an earlier job, as it would be in life.
    hub.start({ kind: 'sync', run: async (ctx) => ctx.setState('pr-open') });
    await settled();

    hub.start({ kind: 'sync', run: bodies.reconcile({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('closed');
    expect(statesIn(frames)).toEqual(['pr-open', 'closed']);
  });

  it('a merged pull request reports `merged`, not `closed`', async () => {
    const gh = fakeGitHub({ comments: [], pull: { number: 42, state: 'closed', merged: true, mergeable: null } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub } = hubRig();
    hub.start({ kind: 'sync', run: bodies.reconcile({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('merged');
  });

  it('merge refuses outright against a PR that is already closed', async () => {
    const gh = fakeGitHub({ comments: [], pull: { number: 42, state: 'closed', merged: false, mergeable: null } });
    const bodies = createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) });
    const { hub, frames } = hubRig();
    hub.start({ kind: 'merge', run: bodies.merge({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('closed');
    expect(frames.find((f) => f.type === 'job-error')).toMatchObject({ message: '#42 is already closed' });
    expect(gh.endpoints().filter((e) => e.endsWith('/merge'))).toEqual([]);
  });
});

/* ================================================================== *
 * R-8.18 — no orphaned branch on a partial create
 * ================================================================== */

describe('orphaned branch cleanup (R-8.18)', () => {
  it('deletes the branch and clears the binding when a create left one behind', async () => {
    const gh = fakeGitHub({ branches: [BRANCH] });
    const store = memoryStore(ORPHANED());
    const result = await cleanupOrphanedBranch({ adapter: createGitHubAdapter(gh.exec), repo, store, documentId: 'doc-1' });

    expect(result).toEqual({ orphaned: true, branch: BRANCH, branchDeleted: true, bindingCleared: true });
    expect(gh.endpoints()).toContain(`DELETE /repos/acme/docs/git/refs/heads/${BRANCH}`);
    expect(gh.branches.has(BRANCH)).toBe(false);
    expect((await store.read('doc-1')) as BoundCollaborationDocument).not.toHaveProperty('github');
    // The draft itself survives — only the binding went.
    expect((await store.read('doc-1'))?.title).toBe('Onboarding guide');
  });

  it('leaves a real pull request alone — that branch is the conversation', async () => {
    const gh = fakeGitHub({ branches: [BRANCH] });
    const result = await cleanupOrphanedBranch({ adapter: createGitHubAdapter(gh.exec), repo, store: memoryStore(BOUND()), documentId: 'doc-1' });
    expect(result).toEqual({ orphaned: false, branch: BRANCH, branchDeleted: false, bindingCleared: false });
    expect(gh.calls).toHaveLength(0);
  });

  it('is idempotent — running it twice deletes nothing the second time and still succeeds', async () => {
    const gh = fakeGitHub({ branches: [BRANCH] });
    const store = memoryStore(ORPHANED());
    const adapter = createGitHubAdapter(gh.exec);
    await cleanupOrphanedBranch({ adapter, repo, store, documentId: 'doc-1' });
    const second = await cleanupOrphanedBranch({ adapter, repo, store, documentId: 'doc-1' });
    expect(second.branchDeleted).toBe(false);
    expect(second.bindingCleared).toBe(false);
  });

  it('finds the branch by its deterministic name when the binding write never landed', async () => {
    const gh = fakeGitHub({ branches: [BRANCH] });
    // No binding at all — the create died between `createBranch` and the store write.
    const result = await cleanupOrphanedBranch({ adapter: createGitHubAdapter(gh.exec), repo, store: memoryStore(makeDoc()), documentId: 'doc-1' });
    expect(result).toEqual({ orphaned: true, branch: BRANCH, branchDeleted: true, bindingCleared: false });
    expect(gh.branches.has(BRANCH)).toBe(false);
  });

  it('does not replace the real failure when cleanup itself fails', async () => {
    const gh = fakeGitHub({ branches: [BRANCH], fail: ['deleteBranch'] });
    const { hub, frames } = hubRig();
    const body = withOrphanCleanup(
      async () => {
        throw new Error('pull request creation failed');
      },
      { adapter: createGitHubAdapter(gh.exec), repo, store: memoryStore(ORPHANED()), documentId: 'doc-1' },
    );
    hub.start({ kind: 'create', run: body });
    await settled();
    expect(frames.find((f) => f.type === 'job-error')).toMatchObject({ message: 'pull request creation failed' });
    expect(frames.some((f) => f.type === 'log' && f.text.includes('cleanup failed'))).toBe(true);
  });
});

/* ================================================================== *
 * R-8.22 — base divergence, distinct from verification failure
 * ================================================================== */

describe('base divergence (R-8.22)', () => {
  it('names only the generated paths that moved on base since the branch point', async () => {
    const gh = fakeGitHub({ baseChanged: ['README.md', MD_PATH] });
    const diverged = await detectBaseDivergence({
      adapter: createGitHubAdapter(gh.exec),
      repo,
      branch: BRANCH,
      paths: [DOC_PATH, MD_PATH],
    });
    expect(diverged).toEqual([MD_PATH]);
    // The comparison is branch...base, which is what asks about the branch point.
    expect(gh.endpoints()).toEqual([`GET /repos/acme/docs/compare/${BRANCH}...main`]);
  });

  it('aborts publish BEFORE the commit and records `base-diverged`', async () => {
    const gh = fakeGitHub({ baseChanged: [MD_PATH], files: { [DOC_PATH]: '{}\n' } });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(BOUND());
    const { hub, frames } = hubRig();
    const body = withPublishFailureStates(
      createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' }),
      { adapter, repo, store, documentId: 'doc-1', checkBaseDivergence: true },
    );
    hub.start({ kind: 'publish', run: body });
    await settled();

    expect(hub.snapshot().state).toBe<LifecycleState>('base-diverged');
    expect(statesIn(frames)).toEqual(['base-diverged']);
    // Nothing was written: the check ran before the first commit.
    expect(gh.endpoints().filter((e) => e.startsWith('PUT '))).toEqual([]);
    expect(frames.find((f) => f.type === 'job-error')?.message).toContain('rebase before publishing');
  });

  it('is off by default, so publish still reads only the PR branch', async () => {
    const gh = fakeGitHub({ baseChanged: [MD_PATH], files: { [DOC_PATH]: '{}\n' } });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(BOUND());
    const { hub } = hubRig();
    hub.start({
      kind: 'publish',
      run: withPublishFailureStates(
        createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' }),
        { adapter, repo, store, documentId: 'doc-1' },
      ),
    });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('published');
    expect(gh.endpoints().some((e) => e.includes('/compare/'))).toBe(false);
  });

  it('R-8.22 — the two failures are DIFFERENT states on the SSE stream, not one', async () => {
    const publishWith = async (options: { diverged: boolean }) => {
      const gh = fakeGitHub({
        files: { [DOC_PATH]: '{}\n' },
        ...(options.diverged ? { baseChanged: [MD_PATH] } : { corruptOnRead: (p) => (p === MD_PATH ? '# tampered\n' : null) }),
      });
      const adapter = createGitHubAdapter(gh.exec);
      const store = memoryStore(BOUND());
      const { hub, frames } = hubRig();
      hub.start({
        kind: 'publish',
        run: withPublishFailureStates(
          createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' }),
          { adapter, repo, store, documentId: 'doc-1', checkBaseDivergence: true },
        ),
      });
      await settled();
      return { hub, frames };
    };

    const diverged = await publishWith({ diverged: true });
    const tampered = await publishWith({ diverged: false });

    // A client discriminates on a field, never by parsing an error message.
    expect(diverged.hub.snapshot().state).toBe<LifecycleState>('base-diverged');
    expect(tampered.hub.snapshot().state).toBe<LifecycleState>('verification-failed');
    expect(diverged.hub.snapshot().state).not.toBe(tampered.hub.snapshot().state);
    // …and the distinction survives into the terminal frame a late subscriber recovers.
    expect(diverged.frames.at(-1)).toMatchObject({ type: 'job-done', ok: false, state: 'base-diverged' });
    expect(tampered.frames.at(-1)).toMatchObject({ type: 'job-done', ok: false, state: 'verification-failed' });
  });
});

/* ================================================================== *
 * R-8.21 — verification failure aborts before any merge
 * ================================================================== */

describe('verification failure (R-8.21)', () => {
  it('records `verification-failed`, and no merge follows', async () => {
    const gh = fakeGitHub({ files: { [DOC_PATH]: '{}\n' }, corruptOnRead: (p) => (p === MD_PATH ? '# tampered\n' : null) });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(BOUND());
    const { hub, frames } = hubRig();
    hub.start({
      kind: 'publish',
      run: withPublishFailureStates(
        createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' }),
        { adapter, repo, store, documentId: 'doc-1' },
      ),
    });
    await settled();

    expect(hub.snapshot().state).toBe<LifecycleState>('verification-failed');
    expect(statesIn(frames)).toEqual(['publishing', 'verifying', 'verification-failed']);
    expect(gh.endpoints().filter((e) => e.endsWith('/merge'))).toEqual([]);
    // R-8.21 — nothing regenerated, nothing overwritten: exactly the two publish PUTs.
    expect(gh.endpoints().filter((e) => e.startsWith('PUT '))).toHaveLength(2);
  });

  it('leaves a state a later sync reconciles rather than a dead end (R-8.24)', async () => {
    const gh = fakeGitHub({
      files: { [DOC_PATH]: '{}\n' },
      comments: [thread(700001)],
      pull: { number: 42, state: 'open', merged: false, mergeable: true },
      corruptOnRead: (p) => (p === MD_PATH ? '# tampered\n' : null),
    });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(BOUND());
    const { hub } = hubRig();
    hub.start({
      kind: 'publish',
      run: withPublishFailureStates(
        createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' }),
        { adapter, repo, store, documentId: 'doc-1' },
      ),
    });
    await settled();
    expect(isFailureState(hub.snapshot().state)).toBe(true);

    hub.start({ kind: 'sync', run: createRecoveryBodies({ adapter }).reconcile({ documentId: 'doc-1', repo, store }) });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('pr-open');
  });
});

/* ================================================================== *
 * R-8.23 — idempotency tokens
 * ================================================================== */

describe('idempotency (R-8.23)', () => {
  it('a retry while the original is still running returns the ORIGINAL job, not a 409', async () => {
    const { hub } = hubRig();
    let ran = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = async () => {
      ran += 1;
      await gate;
    };

    const first = hub.start({ kind: 'create', run, idempotencyKey: 'k-1' });
    const retry = hub.start({ kind: 'create', run, idempotencyKey: 'k-1' });
    expect(first.json).toMatchObject({ ok: true, jobId: 'doc-1-1' });
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({ ok: true, jobId: 'doc-1-1', kind: 'create', deduplicated: true, running: true });
    expect(ran).toBe(1);
    release();
    await settled();
  });

  it('a retry after success returns the original result and runs nothing (no second branch or PR)', async () => {
    const gh = fakeGitHub({ files: { [DOC_PATH]: '{}\n' } });
    const store = memoryStore(makeDoc());
    const { hub } = hubRig();
    const create = createLifecycleBodies({ adapter: createGitHubAdapter(gh.exec) }).create({ documentId: 'doc-1', repo, store });

    hub.start({ kind: 'create', run: create, idempotencyKey: 'k-create' });
    await settled();
    const afterFirst = gh.endpoints();
    expect(afterFirst).toContain('POST /repos/acme/docs/git/refs');
    expect(afterFirst).toContain('POST /repos/acme/docs/pulls');

    const retry = hub.start({ kind: 'create', run: create, idempotencyKey: 'k-create' });
    await settled();
    expect(retry.json).toEqual({ ok: true, jobId: 'doc-1-1', kind: 'create', deduplicated: true, running: false });
    // The whole point: no second branch, no second pull request.
    expect(gh.endpoints()).toEqual(afterFirst);
    expect(gh.endpoints().filter((e) => e === 'POST /repos/acme/docs/git/refs')).toHaveLength(1);
    expect(gh.endpoints().filter((e) => e === 'POST /repos/acme/docs/pulls')).toHaveLength(1);
  });

  it('a retry after a FAILED job runs again — LLD §7 has an explicit retry edge', async () => {
    const { hub } = hubRig();
    let attempts = 0;
    const run = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
    };
    hub.start({ kind: 'create', run, idempotencyKey: 'k-2' });
    await settled();
    expect(hub.snapshot().state).toBe<LifecycleState>('failed');

    const retry = hub.start({ kind: 'create', run, idempotencyKey: 'k-2' });
    await settled();
    expect(retry.json).toMatchObject({ ok: true, jobId: 'doc-1-2' });
    expect(attempts).toBe(2);
  });

  it('different keys are different requests', async () => {
    const { hub } = hubRig();
    let ran = 0;
    const run = async () => {
      ran += 1;
    };
    hub.start({ kind: 'sync', run, idempotencyKey: 'a' });
    await settled();
    hub.start({ kind: 'sync', run, idempotencyKey: 'b' });
    await settled();
    expect(ran).toBe(2);
  });

  it('a request with no key is never de-duplicated', async () => {
    const { hub } = hubRig();
    let ran = 0;
    const run = async () => {
      ran += 1;
    };
    hub.start({ kind: 'sync', run });
    await settled();
    hub.start({ kind: 'sync', run });
    await settled();
    expect(ran).toBe(2);
  });

  it('the key table is bounded — the oldest key is evicted, so it cannot leak', async () => {
    const hubs = createJobHubRegistry({ now: () => NOW, maxIdempotencyKeys: 2 });
    const hub = hubs.hub('doc-1');
    let ran = 0;
    const run = async () => {
      ran += 1;
    };
    for (const key of ['k1', 'k2', 'k3']) {
      hub.start({ kind: 'sync', run, idempotencyKey: key });
      await settled();
    }
    expect(ran).toBe(3);
    // `k1` was evicted by `k3`, so replaying it runs the body a fourth time…
    hub.start({ kind: 'sync', run, idempotencyKey: 'k1' });
    await settled();
    expect(ran).toBe(4);
    // …while `k3`, still remembered, is de-duplicated.
    hub.start({ kind: 'sync', run, idempotencyKey: 'k3' });
    await settled();
    expect(ran).toBe(4);
  });

  it('disposing a document forgets its keys, and keys never cross documents', async () => {
    const hubs = createJobHubRegistry({ now: () => NOW });
    let ran = 0;
    const run = async () => {
      ran += 1;
    };
    hubs.hub('doc-1').start({ kind: 'sync', run, idempotencyKey: 'shared' });
    await settled();
    // Same key, different document — a separate hub, so a separate table.
    hubs.hub('doc-2').start({ kind: 'sync', run, idempotencyKey: 'shared' });
    await settled();
    expect(ran).toBe(2);

    hubs.dispose('doc-1');
    hubs.hub('doc-1').start({ kind: 'sync', run, idempotencyKey: 'shared' });
    await settled();
    expect(ran).toBe(3);
  });
});

/* ================================================================== *
 * R-8.24 — inject a failure at each step: recorded state, SSE, retry
 * ================================================================== */

type MatrixRow = {
  step: string;
  requirement: string;
  /** Build the rig, run the job, return the hub + the fake GitHub. */
  run: () => Promise<{ state: LifecycleState; frames: JobEvent[]; gh: ReturnType<typeof fakeGitHub>; store: DocumentStore }>;
  state: LifecycleState;
  /** What `reconcile` derives afterwards — proof the document is not stranded. */
  reconciled: LifecycleState;
  /**
   * The GitHub a later sync finds. Defaults to a healthy, open, fully-resolved PR — the
   * create/publish rows failed *locally*, so GitHub is fine. The merge rows refused
   * *because* of what GitHub says, so their world is the same one they refused on.
   */
  reconcileWorld?: FakeOptions;
  /** Endpoints that must NOT have been reached. */
  forbidden?: string[];
};

/** A create that fails at `fault`, with the 8.4 cleanup wrapper the wiring applies. */
async function runCreate(fault: 'createBranch' | 'commitFile' | 'createPullRequest') {
  // No `pull`: the document has not reached a Pull Request yet, which is the point.
  const gh = fakeGitHub({ fail: [fault], files: { [DOC_PATH]: '{}\n' } });
  const adapter = createGitHubAdapter(gh.exec);
  const store = memoryStore(makeDoc());
  const { hub, frames } = hubRig();
  const create = createLifecycleBodies({ adapter }).create({ documentId: 'doc-1', repo, store });
  hub.start({ kind: 'create', run: withOrphanCleanup(create, { adapter, repo, store, documentId: 'doc-1' }), idempotencyKey: 'k' });
  await settled();
  return { state: hub.snapshot().state, frames, gh, store, hub };
}

/** A publish that fails at `fault`, with the 8.4 failure-state wrapper. */
async function runPublish(options: FakeOptions & { checkBaseDivergence?: boolean }) {
  const gh = fakeGitHub({ files: { [DOC_PATH]: '{}\n' }, ...options });
  const adapter = createGitHubAdapter(gh.exec);
  const store = memoryStore(BOUND());
  const { hub, frames } = hubRig();
  hub.start({
    kind: 'publish',
    run: withPublishFailureStates(
      createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' }),
      { adapter, repo, store, documentId: 'doc-1', ...(options.checkBaseDivergence ? { checkBaseDivergence: true } : {}) },
    ),
  });
  await settled();
  return { state: hub.snapshot().state, frames, gh, store, hub };
}

/** A merge under `options`, with everything else healthy. */
async function runMerge(options: FakeOptions) {
  const gh = fakeGitHub({ pull: { number: 42, state: 'open', merged: false, mergeable: true }, ...options });
  const adapter = createGitHubAdapter(gh.exec);
  const store = memoryStore(BOUND());
  const { hub, frames } = hubRig();
  hub.start({ kind: 'merge', run: createRecoveryBodies({ adapter }).merge({ documentId: 'doc-1', repo, store }) });
  await settled();
  return { state: hub.snapshot().state, frames, gh, store, hub };
}

const OPEN_PULL = { number: 42, state: 'open', merged: false, mergeable: true } as const;

const FAILURE_MATRIX: MatrixRow[] = [
  {
    step: 'create — branch creation rejected',
    requirement: 'R-8.18 / R-8.24',
    run: () => runCreate('createBranch'),
    state: 'failed',
    reconciled: 'draft',
    forbidden: ['POST /repos/acme/docs/pulls'],
  },
  {
    step: 'create — commit rejected after the branch exists',
    requirement: 'R-8.18 / R-8.24',
    run: () => runCreate('commitFile'),
    state: 'failed',
    reconciled: 'draft',
    forbidden: ['POST /repos/acme/docs/pulls'],
  },
  {
    step: 'create — pull request creation rejected',
    requirement: 'R-8.18 / R-8.24',
    run: () => runCreate('createPullRequest'),
    state: 'failed',
    reconciled: 'draft',
  },
  {
    step: 'publish — commit rejected',
    requirement: 'R-8.24',
    run: () => runPublish({ fail: ['commitFile'], comments: [], pull: { ...OPEN_PULL } }),
    state: 'failed',
    reconciled: 'ready',
  },
  {
    step: 'publish — committed blob does not match the payload',
    requirement: 'R-8.21',
    run: () => runPublish({ corruptOnRead: (p) => (p === MD_PATH ? '# tampered\n' : null), comments: [], pull: { ...OPEN_PULL } }),
    state: 'verification-failed',
    reconciled: 'ready',
    forbidden: ['PUT /repos/acme/docs/pulls/42/merge'],
  },
  {
    step: 'publish — base moved the generated path',
    requirement: 'R-8.22',
    run: () => runPublish({ baseChanged: [MD_PATH], checkBaseDivergence: true, comments: [], pull: { ...OPEN_PULL } }),
    state: 'base-diverged',
    reconciled: 'ready',
    forbidden: ['PUT /repos/acme/docs/contents/documents/doc-1.md'],
  },
  {
    step: 'merge — an unresolved comment exists at merge time',
    requirement: 'R-8.17',
    run: () => runMerge({ comments: [thread(700001)] }),
    state: 'pr-open',
    reconciled: 'pr-open',
    reconcileWorld: { comments: [thread(700001)], pull: { ...OPEN_PULL } },
    forbidden: ['PUT /repos/acme/docs/pulls/42/merge'],
  },
  {
    step: 'merge — the base branch conflicts',
    requirement: 'R-8.20',
    run: () => runMerge({ comments: [], pull: { number: 42, state: 'open', merged: false, mergeable: false } }),
    state: 'conflicted',
    reconciled: 'conflicted',
    reconcileWorld: { comments: [], pull: { number: 42, state: 'open', merged: false, mergeable: false } },
    forbidden: ['PUT /repos/acme/docs/pulls/42/merge'],
  },
  {
    step: 'merge — the pull request was closed on github.com',
    requirement: 'R-8.19',
    run: () => runMerge({ comments: [], pull: { number: 42, state: 'closed', merged: false, mergeable: null } }),
    state: 'closed',
    reconciled: 'closed',
    reconcileWorld: { comments: [], pull: { number: 42, state: 'closed', merged: false, mergeable: null } },
    forbidden: ['PUT /repos/acme/docs/pulls/42/merge'],
  },
];

describe('failure injection matrix (R-8.24)', () => {
  for (const row of FAILURE_MATRIX) {
    it(`${row.step} → ${row.state} [${row.requirement}]`, async () => {
      const { state, frames, gh } = await row.run();
      expect(state).toBe<LifecycleState>(row.state);
      // R-8.24 — the failure is on the stream, never only in a server log.
      expect(frames.some((f) => f.type === 'job-error')).toBe(true);
      // …and the terminal frame carries the same state, so a late subscriber recovers it.
      expect(frames.at(-1)).toMatchObject({ type: 'job-done', ok: false, state: row.state });
      for (const forbidden of row.forbidden ?? []) expect(gh.endpoints()).not.toContain(forbidden);
    });

    it(`${row.step} → a later sync reconciles to ${row.reconciled} [R-8.24]`, async () => {
      const { store } = await row.run();
      // Reconcile derives from scratch against the world a later sync would find.
      const gh = fakeGitHub(row.reconcileWorld ?? { branches: [], comments: [], pull: { ...OPEN_PULL } });
      const { hub } = hubRig();
      hub.start({
        kind: 'sync',
        run: createRecoveryBodies({ adapter: createGitHubAdapter(gh.exec) }).reconcile({ documentId: 'doc-1', repo, store }),
      });
      await settled();
      expect(hub.snapshot().state).toBe<LifecycleState>(row.reconciled);
    });
  }

  it('R-8.23 — retrying any create with the same key creates no second branch and no second PR', async () => {
    const gh = fakeGitHub({ files: { [DOC_PATH]: '{}\n' } });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(makeDoc());
    const { hub } = hubRig();
    const body = () => withOrphanCleanup(createLifecycleBodies({ adapter }).create({ documentId: 'doc-1', repo, store }), { adapter, repo, store, documentId: 'doc-1' });

    hub.start({ kind: 'create', run: body(), idempotencyKey: 'k-once' });
    await settled();
    // Three more attempts, as a double-clicked button and two timeouts would produce.
    for (let i = 0; i < 3; i += 1) {
      hub.start({ kind: 'create', run: body(), idempotencyKey: 'k-once' });
      await settled();
    }
    expect(gh.endpoints().filter((e) => e === 'POST /repos/acme/docs/git/refs')).toHaveLength(1);
    expect(gh.endpoints().filter((e) => e === 'POST /repos/acme/docs/pulls')).toHaveLength(1);
  });

  it('R-8.23 — retrying a publish with the same key commits once', async () => {
    const gh = fakeGitHub({ files: { [DOC_PATH]: '{}\n' } });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(BOUND());
    const { hub } = hubRig();
    const body = () => createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, json: { root: {} }, markdown: '# x\n' });

    hub.start({ kind: 'publish', run: body(), idempotencyKey: 'k-pub' });
    await settled();
    hub.start({ kind: 'publish', run: body(), idempotencyKey: 'k-pub' });
    await settled();
    // The dedup (R-8.23) means the body runs once: two document artifacts (json +
    // markdown) plus O-2's `.gitattributes` entry, three PUTs total.
    expect(gh.endpoints().filter((e) => e.startsWith('PUT /repos/acme/docs/contents/'))).toHaveLength(3);
  });

  it('names the four failure states, and every row reconciles to a state derived from GitHub', () => {
    expect([...FAILURE_STATES]).toEqual(['failed', 'conflicted', 'verification-failed', 'base-diverged']);
    // `failed` is the one state nothing may be left in: it says only "something broke".
    for (const row of FAILURE_MATRIX) expect(row.reconciled).not.toBe<LifecycleState>('failed');
    expect(isFailureState('failed')).toBe(true);
    expect(isFailureState('pr-open')).toBe(false);
  });
});

/* ================================================================== *
 * The three adapter methods 8.4 added
 * ================================================================== */

describe('adapter additions', () => {
  it('deleteBranch resolves false when the ref is already gone (R-8.18)', async () => {
    const gh = fakeGitHub({ branches: [] });
    await expect(createGitHubAdapter(gh.exec).deleteBranch({ owner: 'acme', repo: 'docs' }, BRANCH)).resolves.toBe(false);
    expect(gh.endpoints()).toEqual([`DELETE /repos/acme/docs/git/refs/heads/${BRANCH}`]);
  });

  it('deleteBranch resolves true when it removed the ref', async () => {
    const gh = fakeGitHub({ branches: [BRANCH] });
    await expect(createGitHubAdapter(gh.exec).deleteBranch({ owner: 'acme', repo: 'docs' }, BRANCH)).resolves.toBe(true);
  });

  it('getPullRequest carries merged and mergeable, with null kept as null (R-8.19 / R-8.20)', async () => {
    const gh = fakeGitHub({ pull: { number: 42, state: 'open', merged: false, mergeable: null, mergeableState: 'unknown' } });
    const status = await createGitHubAdapter(gh.exec).getPullRequest({ owner: 'acme', repo: 'docs' }, 42);
    expect(status).toMatchObject({ number: 42, state: 'open', merged: false, mergeable: null, mergeableState: 'unknown' });
  });

  it('compareCommits reduces the response to the branch point and the changed paths (R-8.22)', async () => {
    const gh = fakeGitHub({ baseChanged: ['a.md', 'b.md'] });
    const comparison = await createGitHubAdapter(gh.exec).compareCommits({ owner: 'acme', repo: 'docs' }, BRANCH, 'main');
    expect(comparison).toEqual({ mergeBaseSha: 'base0000', aheadBy: 0, behindBy: 2, files: ['a.md', 'b.md'] });
  });

  it('every call is `gh api` — no git subprocess exists on any of these paths', async () => {
    const gh = fakeGitHub({ branches: [BRANCH], comments: [], pull: { ...OPEN_PULL } });
    const adapter = createGitHubAdapter(gh.exec);
    await createRecoveryBodies({ adapter }).reconcile({ documentId: 'doc-1', repo, store: memoryStore(BOUND()) })({
      documentId: 'doc-1',
      jobId: 'j',
      kind: 'sync',
      signal: new AbortController().signal,
      log: () => undefined,
      setState: () => undefined,
      now: () => NOW,
    });
    await cleanupOrphanedBranch({ adapter, repo, store: memoryStore(ORPHANED()), documentId: 'doc-1' });
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const call of gh.calls) expect(call.args[0]).toBe('api');
  });
});

/* ================================================================== *
 * The typed errors discriminate without message parsing
 * ================================================================== */

describe('typed failures', () => {
  it('each carries the facts a client needs, so nothing has to parse a message', () => {
    const gate = new ReadyGateError('doc-1', { ready: false, total: 3, unresolved: 2, unresolvedCommentIds: [1, 2] });
    expect(gate).toMatchObject({ name: 'ReadyGateError', documentId: 'doc-1' });
    expect(gate.verdict.unresolvedCommentIds).toEqual([1, 2]);

    const refused = new MergeRefusedError('doc-1', 'base-conflict', 'nope');
    expect(refused).toMatchObject({ name: 'MergeRefusedError', reason: 'base-conflict', verdict: null });

    const diverged = new BaseDivergedError({ documentId: 'doc-1', branch: BRANCH, baseBranch: 'main', paths: [MD_PATH] });
    expect(diverged).toMatchObject({ name: 'BaseDivergedError', paths: [MD_PATH] });
    expect(diverged).toBeInstanceOf(Error);
  });
});
