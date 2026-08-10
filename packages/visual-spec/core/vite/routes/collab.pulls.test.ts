/**
 * collab.pulls.test.ts — the repo-level `/__vs/collab/pulls/*` family.
 *
 * Kept apart from `collab.test.ts` because nothing here is document-scoped: there is no
 * document, no job hub in play and no comment store, and the doubles these routes need
 * (a `GitExecutor` and a repo-level `GitHubAdapter`) are shared by no test in that file.
 *
 * No real network, no `gh` and no `git`: both executors are injected (R-4.8 / R-12.3).
 * The one thing that touches the filesystem is `ensureIgnored`, which the mount path runs
 * before creating a worktree, so the happy-path cases are given a real temporary
 * directory to write `.gitignore` into.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import {
  GitHubError,
  type GitHubAdapter,
  type PullRequestSearchQualifier,
  type PullRequestSearchResult,
  type PullRequestSummary,
} from '../../collaboration/github-adapter';
import type { ReviewComment, ThreadResolution } from '../../collaboration/review-comments';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { GitExecutor } from '../../git-context';
import type { ResolvedVisualSpecConfig } from '../../config';
import {
  GITHUB_LOGIN_RE,
  type Awaiting,
  type CollabAuthorizer,
  type CollabDeps,
  type CollabOperation,
  type CollabRouteResult,
  createCollabRoutes,
} from './collab';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = (rel: string) => readFileSync(resolve(pkgRoot, rel), 'utf8');

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO }, git: { allowCheckout: false } };
const DISABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: null, git: { allowCheckout: false } };

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

function summary(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 7,
    title: 'Tighten the onboarding guide',
    state: 'open',
    draft: false,
    headBranch: 'vs/doc-1',
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    htmlUrl: 'https://github.com/acme/specs/pull/7',
    author: 'octocat',
    updatedAt: 'T0',
    ...over,
  };
}

/** One review comment as `toReviewComment` would have flattened it. */
function reviewComment(over: Partial<ReviewComment> & { id: number }): ReviewComment {
  return {
    inReplyToId: null,
    path: 'docs/spec.md',
    line: 4,
    startLine: null,
    originalLine: 4,
    side: 'RIGHT',
    subjectType: 'line',
    commitId: 'a'.repeat(40),
    originalCommitId: 'a'.repeat(40),
    diffHunk: '@@ -0,0 +1,14 @@',
    body: 'test comments 003',
    user: 'javierhbr',
    createdAt: '2026-08-09T20:00:00Z',
    updatedAt: '2026-08-09T20:00:00Z',
    htmlUrl: `https://github.com/acme/specs/pull/7#discussion_r${over.id}`,
    ...over,
  };
}

/** The repo-level adapter double, recording what the routes asked for. */
function repoAdapter(
  options: {
    pulls?: PullRequestSummary[];
    listFails?: Error;
    pullFails?: Error;
    files?: string[];
    body?: string;
    reviewComments?: ReviewComment[];
    reviewCommentsFail?: Error;
    resolutions?: ThreadResolution[];
    resolutionsFail?: Error;
  } = {},
) {
  const states: (string | undefined)[] = [];
  const compares: { base: string; head: string }[] = [];
  const reads: string[] = [];
  /** Every `getPullRequest` — one per source resolution, and no more. */
  const details: number[] = [];
  const adapter = {
    async listPullRequests(_repo: unknown, state?: string) {
      states.push(state);
      if (options.listFails) throw options.listFails;
      return options.pulls ?? [summary()];
    },
    async getPullRequest(_repo: unknown, pullNumber: number) {
      details.push(pullNumber);
      if (options.pullFails) throw options.pullFails;
      return {
        number: pullNumber,
        headSha: 'a'.repeat(40),
        baseBranch: 'main',
        // GitHub's `head.ref` is the BARE branch name even for a fork — the
        // owner-qualified form is `head.label`, which no mapper here reads.
        headBranch: 'patch-1',
        state: 'open',
        htmlUrl: 'https://github.com/acme/specs/pull/7',
        body: options.body ?? '',
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
      };
    },
    async listReviewComments(_repo: unknown, _pullNumber: number) {
      if (options.reviewCommentsFail) throw options.reviewCommentsFail;
      return options.reviewComments ?? [];
    },
    async listThreadResolution(_repo: unknown, _pullNumber: number) {
      if (options.resolutionsFail) throw options.resolutionsFail;
      return options.resolutions ?? [];
    },
    async compareCommits(_repo: unknown, base: string, head: string) {
      compares.push({ base, head });
      return { mergeBaseSha: 'b'.repeat(40), aheadBy: 2, behindBy: 0, files: options.files ?? ['docs/spec.md'] };
    },
    /* The two reads a host-sourced review makes. Recorded with their ref, because the
     * whole point of the pin is that it is a commit and never a branch name (R-W2.4). */
    async listFiles(_repo: unknown, path: string, ref?: string) {
      reads.push(`listFiles:${path}@${ref ?? ''}`);
      return [{ name: 'spec.md', path: 'docs/spec.md', type: 'file', sha: 'c'.repeat(40), size: 3 }];
    },
    async getFile(_repo: unknown, path: string, ref?: string) {
      reads.push(`getFile:${path}@${ref ?? ''}`);
      return { path, content: '# from the host\n', sha: 'c'.repeat(40) };
    },
  } as unknown as GitHubAdapter;
  return { adapter, states, compares, reads, details };
}

/**
 * The two reads `readGitContext` makes, answered as an ordinary clone would.
 *
 * `resolveReviewSource` asks them before deciding whether a review takes the checkout, so
 * a stub that stayed silent here would report "not a git working tree" and every mount
 * test would quietly measure the host path instead of the one it names. A test that is
 * about one of these two answers overrides it; the rest inherit a working tree with an
 * origin, which is the state they were all written in.
 *
 * The origin is the configured repository's own URL, so `fetchSource` resolves to
 * `origin` exactly as it did when this stub answered nothing at all.
 */
function gitContextDefault(args: string[]): { stdout?: string; exitCode: number | null } | undefined {
  if (args[2] === 'rev-parse' && args[3] === '--abbrev-ref') return { stdout: 'main\n', exitCode: 0 };
  if (args[2] === 'remote' && args[3] === 'get-url') return { stdout: 'https://github.com/acme/specs.git\n', exitCode: 0 };
  return undefined;
}

/**
 * A `GitExecutor` that answers per command, recording every call. `answer` returns
 * `undefined` for anything it does not care about, which then falls to
 * `gitContextDefault` and otherwise succeeds silently — so a test names only the command
 * it is about.
 */
function stubGit(answer: (args: string[]) => { stdout?: string; exitCode: number | null } | undefined = () => undefined) {
  const calls: string[][] = [];
  const exec: GitExecutor = async (args) => {
    calls.push(args);
    const { stdout = '', exitCode = 0 } = answer(args) ?? gitContextDefault(args) ?? {};
    return { stdout, exitCode };
  };
  return { exec, calls };
}

/** True when `args` contains the git subcommand `name` (the `-C <dir>` prefix aside). */
const isCommand = (args: string[], name: string): boolean => args[2] === name;

function router(overrides: Partial<CollabDeps> = {}) {
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents: () => {
      throw new Error('the /pulls family must not read the document store');
    },
    preflight: async () => OK_PREFLIGHT,
    authorize: ALLOW_ALL,
    baseDir: () => '/tmp/does-not-matter',
    git: stubGit().exec,
    repoAdapter: () => repoAdapter().adapter,
    ...overrides,
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  query: Record<string, string> = {},
): Promise<CollabRouteResult> => r.handle({ method, pathname, query, body: {} });

/* ================================================================== *
 * Route ordering — `/pulls` is not a documentId
 * ================================================================== */
describe('/pulls is matched before the document-scoped route', () => {
  /*
   * The failure this guards is silent: `pulls` is a legal documentId, so a family placed
   * after the scoped match is not rejected — `GET /pulls` is answered as the status
   * snapshot of a document called "pulls", with a 200 and no pull requests in it. The
   * `documents()` thunk in `router()` throws for exactly that reason.
   */
  it('answers the pull list rather than treating `pulls` as a documentId', async () => {
    const res = await call(router(), 'GET', '/pulls');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ pulls: [{ number: 7 }] });
  });

  it('every /pulls handler is declared above the scoped-documentId match in the source', () => {
    const text = src('core/vite/routes/collab.ts');
    const scoped = text.indexOf('const scoped = /^\\/([^/]+)(\\/.*)?$/.exec(pathname)');
    expect(scoped).toBeGreaterThan(-1);
    for (const marker of ["pathname === '/pulls'", "pathname === '/pulls/mounted'", "pathname === '/pulls/awaiting'", '/^\\/pulls\\/([^/]+)\\/mount$/', '/^\\/pulls\\/([^/]+)\\/files$/', '/^\\/pulls\\/([^/]+)\\/description$/', '/^\\/pulls\\/([^/]+)\\/comments$/']) {
      const at = text.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      expect(at, marker).toBeLessThan(scoped);
    }
  });

  // The converse, kept as documentation: anything under /pulls the family does not
  // recognise DOES fall through to the scoped match, and that is what the ordering above
  // is protecting the recognised paths from.
  it('an unrecognised /pulls path falls through to the document-scoped match', async () => {
    const res = await call(router(), 'GET', '/pulls/7/nope');
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: 'no route: GET /__vs/collab/pulls/7/nope' });
  });
});

/* ================================================================== *
 * R-9.8 — the whole family is a read, and reads are any-role
 * ================================================================== */
describe('R-9.8 — the /pulls family gates on `read` and nothing stronger', () => {
  it('asks the authorizer for `read` with no document, on every route', async () => {
    const seen: { op: CollabOperation; documentId: string | null }[] = [];
    const authorize: CollabAuthorizer = (op, ctx) => {
      seen.push({ op, documentId: ctx.documentId });
      return { ok: true };
    };
    const r = router({ authorize });
    await call(r, 'GET', '/pulls');
    await call(r, 'GET', '/pulls/mounted');
    await call(r, 'GET', '/pulls/7/files');
    await call(r, 'GET', '/pulls/7/description');
    await call(r, 'GET', '/pulls/7/comments');
    await r.handle({ method: 'POST', pathname: '/pulls/7/mount', query: {}, body: {} });
    await r.handle({ method: 'DELETE', pathname: '/pulls/7/mount', query: {}, body: {} });

    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((s) => s.op))).toEqual(new Set(['read']));
    expect(seen.every((s) => s.documentId === null)).toBe(true);
  });

  it('honours a refusal from the authorizer', async () => {
    const authorize: CollabAuthorizer = () => ({ ok: false, status: 403, error: 'nope' });
    const res = await call(router({ authorize }), 'GET', '/pulls');
    expect(res).toEqual({ status: 403, json: { error: 'nope' } });
  });

  it('reports collaboration being off as a 503 carrying the availability payload', async () => {
    const res = await call(router({ config: () => DISABLED }), 'GET', '/pulls');
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ available: false, reason: 'not-configured' });
  });
});

/* ================================================================== *
 * GET /pulls
 * ================================================================== */
describe('GET /__vs/collab/pulls', () => {
  it('defaults to the open pull requests', async () => {
    const gh = repoAdapter();
    await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls');
    expect(gh.states).toEqual(['open']);
  });

  it('passes a requested state through', async () => {
    const gh = repoAdapter();
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls', { state: 'all' });
    expect(res.status).toBe(200);
    expect(gh.states).toEqual(['all']);
  });

  it('refuses a state GitHub has no name for, before asking GitHub anything', async () => {
    const gh = repoAdapter();
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls', { state: 'merged' });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: expect.stringContaining('invalid state: merged') });
    expect(gh.states).toEqual([]);
  });

  /*
   * R-7.4 / R-7.5 — the document identifier is already resolved by the time the
   * route sees a pull request, and the description it was resolved from is not
   * carried alongside it. The client has no body to parse, which is what makes
   * R-7.5 structural rather than a rule somebody has to remember.
   */
  it('answers with the server-resolved documentId and no pull request description', async () => {
    const gh = repoAdapter({ pulls: [summary({ documentId: 'doc-1' }), summary({ number: 8 })] });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls');
    expect(res.status).toBe(200);
    const { pulls } = res.json as { pulls: Record<string, unknown>[] };
    expect(pulls.map((p) => p.documentId)).toEqual(['doc-1', undefined]);
    for (const pull of pulls) expect(Object.keys(pull)).not.toContain('body');
  });

  it('surfaces a GitHub failure with GitHub’s own status', async () => {
    const gh = repoAdapter({ listFails: new GitHubError('listPullRequests', 'Not Found', 404, 'not_found') });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls');
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: 'Not Found' });
  });
});

/* ================================================================== *
 * pullNumber validation — a 400 at the edge, never a 500 from the core
 * ================================================================== */
describe('an unusable pull number is refused at the route', () => {
  /*
   * `worktree.ts` throws on these, and the router’s catch-all would turn the throw into a
   * 400 anyway — by accident, with the core’s wording. These assert the route decided.
   */
  for (const raw of ['0', 'abc', '-1', '1.5', '01x']) {
    it(`rejects ${raw} on mount, unmount and files`, async () => {
      const r = router();
      for (const [method, path] of [
        ['POST', `/pulls/${raw}/mount`],
        ['DELETE', `/pulls/${raw}/mount`],
        ['GET', `/pulls/${raw}/files`],
      ] as const) {
        const res = await r.handle({ method, pathname: path, query: {}, body: {} });
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(res.json).toMatchObject({ error: `invalid pullNumber: ${raw}` });
      }
    });
  }

  it('refuses before consulting availability, so a malformed request needs no credential', async () => {
    const r = router({
      config: () => {
        throw new Error('availability must not be consulted');
      },
    });
    // `parsePullNumber` runs first; if it did not, the throwing config would surface here.
    const res = await r.handle({ method: 'POST', pathname: '/pulls/0/mount', query: {}, body: {} });
    expect(res.status).toBe(400);
  });
});

/* ================================================================== *
 * Mounting — each failure reason gets its own status and its own words
 * ================================================================== */
describe('POST /__vs/collab/pulls/:n/mount', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vs-collab-pulls-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const mount = (git: GitExecutor, baseDir = dir) =>
    router({ git, baseDir: () => baseDir }).handle({ method: 'POST', pathname: '/pulls/7/mount', query: {}, body: {} });

  /*
   * R-W1.3 / R-13.9a — the two refusals this feature deletes. Both used to be a 409
   * telling the reviewer to go and clone something; both are now a review supplied by the
   * host. `source: 'host'` is how the answer says so (R-W1.5), and "no fetch was
   * attempted" is the other half: R-13.9a says neither condition may attempt a checkout at
   * all, not merely that its failure is tolerated.
   *
   * `headSha` rides on both answers, checkout or not. It is the commit the whole review is
   * pinned to and what every held comment is stamped with, and reading it off `worktree`
   * made it conditional on there being a path on disk.
   */
  it('supplies the review from the host when the served directory is not a git working tree', async () => {
    const git = stubGit((args) => (isCommand(args, 'rev-parse') ? { exitCode: 1 } : undefined));
    const res = await mount(git.exec);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, source: 'host', headSha: 'a'.repeat(40) });
    expect(git.calls.some((c) => isCommand(c, 'fetch'))).toBe(false);
  });

  it('supplies the review from the host when the served directory has no origin', async () => {
    const git = stubGit((args) => (isCommand(args, 'remote') ? { exitCode: 1 } : undefined));
    const res = await mount(git.exec);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, source: 'host', headSha: 'a'.repeat(40) });
    expect(git.calls.some((c) => isCommand(c, 'fetch'))).toBe(false);
  });

  it('reports a failed fetch as a 502, because the refusal came from upstream', async () => {
    const res = await mount(stubGit((args) => (isCommand(args, 'fetch') ? { exitCode: 1 } : undefined)).exec);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ reason: 'fetch-failed', error: expect.stringContaining('gh auth status') });
  });

  it('reports git refusing the checkout as a 500, because that one is ours', async () => {
    // `rev-parse` inside the worktree must fail too, or the mount takes the re-checkout
    // branch instead of `worktree add`. Both are answered by the same guard.
    const res = await mount(
      stubGit((args) => {
        if (isCommand(args, 'worktree')) return { exitCode: 1 };
        if (isCommand(args, 'rev-parse') && args[1] !== dir) return { exitCode: 1 };
        return undefined;
      }).exec,
    );
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ reason: 'worktree-failed', error: expect.stringContaining('git worktree prune') });
  });

  it('answers 200 with the worktree when the mount lands', async () => {
    // The head the adapter double reports for the pull request. The mount is checked
    // against it, so a checkout at any other commit is not this pull request.
    const head = 'a'.repeat(40);
    const git = stubGit((args) => {
      if (isCommand(args, 'rev-parse') && args[3] === 'HEAD') return { stdout: `${head}\n`, exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[3] === '--show-toplevel') return { stdout: `${dir}/.visual-spec/worktrees/pr-7\n`, exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[1] !== dir) return { exitCode: 1 };
      return undefined;
    });
    const res = await mount(git.exec);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      // R-W1.5 — the other half of the pair the host tests above assert. The reviewer is
      // told which source is live in *both* configurations, or being told is worthless.
      source: 'checkout',
      headSha: head,
      worktree: { pullNumber: 7, path: `${dir}/.visual-spec/worktrees/pr-7`, headSha: head },
    });
    // The fetch uses the fork-safe refspec, not the head branch by name.
    expect(git.calls.some((c) => c.includes('+refs/pull/7/head:refs/visual-spec/pr/7'))).toBe(true);
  });

  /*
   * The bug these two cover, in one sentence: a pull number identifies a pull request
   * only *within a repository*, and this route used to read the number against the
   * configured repository and resolve it against the served directory's `origin`. When
   * those differ the same number names two different pull requests, the fetch succeeds,
   * and the reviewer is shown one pull request's changed-files list over another's tree —
   * every row rendering "No preview for this file." because the checkout does not have it.
   */
  it('fetches from the configured repository when `origin` is a clone of a different one', async () => {
    const head = 'a'.repeat(40);
    const git = stubGit((args) => {
      if (isCommand(args, 'remote')) return { stdout: 'https://github.com/someone/served.git\n', exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[3] === 'HEAD') return { stdout: `${head}\n`, exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[1] !== dir) return { exitCode: 1 };
      return undefined;
    });
    const res = await mount(git.exec);
    expect(res.status).toBe(200);
    const fetched = git.calls.find((c) => isCommand(c, 'fetch'));
    expect(fetched).toContain(`https://github.com/${ENABLED.collaboration!.owner}/${ENABLED.collaboration!.repo}.git`);
  });

  it('reports a checkout that is not at the pull request head as a 409 carrying both commits', async () => {
    const git = stubGit((args) => {
      // A remote that will not parse, so the fetch stays on `origin` — the case the URL
      // rewrite deliberately does not touch, and therefore the one the head check owns.
      if (isCommand(args, 'remote')) return { stdout: '/tmp/some/other/clone\n', exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[3] === 'HEAD') return { stdout: `${'d'.repeat(40)}\n`, exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[1] !== dir) return { exitCode: 1 };
      return undefined;
    });
    const res = await mount(git.exec);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ reason: 'head-mismatch' });
    const { error } = res.json as { error: string };
    expect(error).toContain('ddddddd');
    expect(error).toContain('aaaaaaa');
    expect(error).toContain('VS_COLLAB_REPO');
  });

  /*
   * R-W1.2 at the route — the regression the corrected resolution rule exists to prevent.
   * The served directory's `origin` is a clone of `someone/served` and the review is of
   * `acme/specs`, and the answer still carries a worktree: the checkout was chosen, not
   * the host. The test above already proves the fetch went to the derived URL; this one
   * proves which source the reviewer ended up on.
   */
  it('still takes the checkout when `origin` names a different repository', async () => {
    const head = 'a'.repeat(40);
    const git = stubGit((args) => {
      if (isCommand(args, 'remote')) return { stdout: 'https://github.com/someone/served.git\n', exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[3] === 'HEAD') return { stdout: `${head}\n`, exitCode: 0 };
      if (isCommand(args, 'rev-parse') && args[1] !== dir) return { exitCode: 1 };
      return undefined;
    });
    const res = await mount(git.exec);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, source: 'checkout', worktree: { pullNumber: 7 } });
  });
});

/* ================================================================== *
 * Reading a review through whichever source supplies it
 * ================================================================== */
describe('GET /__vs/collab/pulls/:n/{tree,raw}', () => {
  /* No git working tree, so the resolution lands on the host source (R-W1.3) and every
   * read below is one the reviewer could not have made at all before this change. */
  const noRepo = () => stubGit((args) => (isCommand(args, 'rev-parse') ? { exitCode: 1 } : undefined)).exec;

  const read = (path: string, query: Record<string, string> = {}, gh = repoAdapter()) =>
    router({ git: noRepo(), repoAdapter: () => gh.adapter }).handle({ method: 'GET', pathname: path, query, body: {} });

  it('lists one directory of the pull request’s tree at the pinned commit', async () => {
    const gh = repoAdapter();
    const res = await read('/pulls/7/tree', { path: 'docs' }, gh);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      pullNumber: 7,
      headSha: 'a'.repeat(40),
      path: 'docs',
      entries: [{ name: 'spec.md', path: 'docs/spec.md', kind: 'file' }],
    });
    // The ref is the head COMMIT, never the head branch (R-W2.4).
    expect(gh.reads).toEqual([`listFiles:docs@${'a'.repeat(40)}`]);
  });

  it('reads a file at the pinned commit', async () => {
    const gh = repoAdapter();
    const res = await read('/pulls/7/raw', { path: 'docs/spec.md' }, gh);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ pullNumber: 7, path: 'docs/spec.md', text: '# from the host\n' });
    expect(gh.reads).toEqual([`getFile:docs/spec.md@${'a'.repeat(40)}`]);
  });

  it('defaults to the repository root when no path is given', async () => {
    const gh = repoAdapter();
    await read('/pulls/7/tree', {}, gh);
    expect(gh.reads).toEqual([`listFiles:@${'a'.repeat(40)}`]);
  });

  it('reports a failed read as its own kind of failure, not a generic one', async () => {
    // `getFile` answering `null` is "not at this commit", which the host source reports as
    // `not-readable` — the one of the four whose advice is "check the path or your access".
    const gh = repoAdapter();
    const missing = { ...gh.adapter, getFile: async () => null } as unknown as GitHubAdapter;
    const res = await router({ git: noRepo(), repoAdapter: () => missing }).handle({
      method: 'GET',
      pathname: '/pulls/7/raw',
      query: { path: 'nope.md' },
      body: {},
    });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ reason: 'not-readable' });
  });

  it('resolves the source once and reads through it, rather than per file', async () => {
    const gh = repoAdapter();
    const r = router({ git: noRepo(), repoAdapter: () => gh.adapter });
    const request = (pathname: string, query: Record<string, string>) => r.handle({ method: 'GET', pathname, query, body: {} });
    await request('/pulls/7/tree', {});
    await request('/pulls/7/raw', { path: 'docs/spec.md' });
    await request('/pulls/7/raw', { path: 'docs/spec.md' });
    // Three reads, one resolution: the head is not re-read per file, which is what keeps
    // an open review pinned to the commit it opened on (R-W2.4).
    expect(gh.reads).toHaveLength(3);
    expect(gh.details).toEqual([7]);
  });

  it('refuses a pull number that is not one', async () => {
    for (const pathname of ['/pulls/0/tree', '/pulls/abc/raw']) {
      const res = await read(pathname);
      expect(res.status, pathname).toBe(400);
    }
  });
});

/* ================================================================== *
 * The pull request's own review conversation — roots AND replies
 * ================================================================== */
describe('GET /__vs/collab/pulls/:n/comments', () => {
  const comments = (options: Parameters<typeof repoAdapter>[0]) =>
    call(router({ repoAdapter: () => repoAdapter(options).adapter }), 'GET', '/pulls/7/comments');

  it('answers every thread with its replies, in creation order', async () => {
    const res = await comments({
      reviewComments: [
        reviewComment({ id: 11, body: 'test comments 003' }),
        reviewComment({ id: 13, inReplyToId: 11, body: 'reply comment 003 -A', createdAt: '2026-08-09T20:01:00Z' }),
        reviewComment({ id: 12, inReplyToId: 11, body: 'reply comment 003 -B', createdAt: '2026-08-09T20:02:00Z' }),
        reviewComment({ id: 20, path: 'README.md', body: 'a thread on another file' }),
      ],
    });
    expect(res.status).toBe(200);
    const { threads } = res.json as { threads: { comment: string; target: { path: string }; replies: { body: string }[] }[] };
    expect(threads).toHaveLength(2);
    // The reply the panel could not previously show, and the one after it — ordered by
    // when they were written, not by id.
    expect(threads[0]!.comment).toBe('test comments 003');
    expect(threads[0]!.replies.map((r) => r.body)).toEqual(['reply comment 003 -A', 'reply comment 003 -B']);
    // Every file's threads, not the one on screen: the panel filters, the route does not.
    expect(threads.map((t) => t.target.path)).toEqual(['docs/spec.md', 'README.md']);
  });

  it('joins resolution when GraphQL answers', async () => {
    const res = await comments({
      reviewComments: [reviewComment({ id: 11 })],
      resolutions: [{ rootCommentId: 11, isResolved: true, isOutdated: false }],
    });
    const { threads } = res.json as { threads: { github: { isResolved?: boolean } }[] };
    expect(threads[0]!.github.isResolved).toBe(true);
  });

  it('still serves the conversation when the resolution read fails, without claiming unresolved', async () => {
    // R-4.12 / R-5.15 — `undefined` is "we could not ask". `false` would be a claim.
    const res = await comments({
      reviewComments: [reviewComment({ id: 11 })],
      resolutionsFail: new Error('graphql is down'),
    });
    expect(res.status).toBe(200);
    const { threads } = res.json as { threads: { github: { isResolved?: boolean } }[] };
    expect(threads[0]!.github.isResolved).toBeUndefined();
  });

  it('reports a GitHub failure as the route family does, rather than throwing', async () => {
    const res = await comments({
      reviewCommentsFail: new GitHubError('listReviewComments', 'gone', 404, 'not_found'),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a pull number that is not one', async () => {
    const res = await call(router(), 'GET', '/pulls/-1/comments');
    expect(res.status).toBe(400);
  });
});

/* ================================================================== *
 * Listing and unmounting
 * ================================================================== */
describe('the mounted worktrees', () => {
  it('lists what git itself reports, not what this process remembers', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.visual-spec/worktrees/pr-7',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      '',
    ].join('\n');
    const git = stubGit((args) => (isCommand(args, 'worktree') ? { stdout: porcelain, exitCode: 0 } : undefined));
    const res = await call(router({ git: git.exec }), 'GET', '/pulls/mounted');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      worktrees: [{ pullNumber: 7, path: '/repo/.visual-spec/worktrees/pr-7', headSha: '2'.repeat(40) }],
    });
  });

  it('reports an unmount of something that was never mounted as a success', async () => {
    const git = stubGit((args) => (isCommand(args, 'worktree') ? { exitCode: 1 } : undefined));
    const res = await router({ git: git.exec }).handle({
      method: 'DELETE',
      pathname: '/pulls/7/mount',
      query: {},
      body: {},
    });
    expect(res).toEqual({ status: 200, json: { ok: true, removed: false } });
    // The private ref goes either way, so the PR's objects are not pinned forever.
    expect(git.calls.some((c) => c.includes('update-ref') && c.includes('refs/visual-spec/pr/7'))).toBe(true);
  });

  it('reports a real unmount as removed', async () => {
    const res = await router({ git: stubGit().exec }).handle({
      method: 'DELETE',
      pathname: '/pulls/7/mount',
      query: {},
      body: {},
    });
    expect(res).toEqual({ status: 200, json: { ok: true, removed: true } });
  });
});

/* ================================================================== *
 * GET /pulls/:n/files
 * ================================================================== */
describe('GET /__vs/collab/pulls/:n/files', () => {
  it('compares the base branch against the head SHA, so a fork PR still answers', async () => {
    const gh = repoAdapter({ files: ['docs/spec.md', 'README.md'] });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/7/files');
    expect(res.status).toBe(200);
    expect(gh.compares).toEqual([{ base: 'main', head: 'a'.repeat(40) }]);
    expect(res.json).toMatchObject({
      pullNumber: 7,
      baseBranch: 'main',
      headBranch: 'patch-1',
      mergeBaseSha: 'b'.repeat(40),
      files: ['docs/spec.md', 'README.md'],
    });
  });

  it('passes a GitHub 404 through rather than reporting an empty file list', async () => {
    const gh = repoAdapter({ pullFails: new GitHubError('getPullRequest', 'Not Found', 404, 'not_found') });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/999/files');
    expect(res.status).toBe(404);
  });
});

/* ================================================================== *
 * Held review comments — /pulls/:n/drafts (R-13.13 … R-13.18)
 * ================================================================== */

/** The head `repoAdapter()` reports for every pull request, i.e. "current". */
const CURRENT_HEAD = 'a'.repeat(40);
/** A head that is not the current one, i.e. "the draft was written before a push". */
const OLD_HEAD = 'd'.repeat(40);

/**
 * The repo adapter again, plus a recording `createReviewComment`. The recording is the
 * point: R-13.16 is a statement about how many times this method is called, so the
 * assertion has to be able to count them.
 */
function draftAdapter(options: { createFails?: Error } = {}) {
  const base = repoAdapter();
  const creates: { pullNumber: number; input: Record<string, unknown> }[] = [];
  let nextId = 1000;
  const adapter = {
    ...(base.adapter as unknown as Record<string, unknown>),
    async createReviewComment(_repo: unknown, pullNumber: number, input: Record<string, unknown>) {
      creates.push({ pullNumber, input });
      if (options.createFails) throw options.createFails;
      const id = ++nextId;
      return {
        id,
        inReplyToId: null,
        path: input.path,
        line: (input.line as number | undefined) ?? null,
        startLine: (input.startLine as number | undefined) ?? null,
        originalLine: (input.line as number | undefined) ?? 1,
        side: 'RIGHT',
        subjectType: input.line === undefined ? 'file' : 'line',
        commitId: input.commitId,
        originalCommitId: input.commitId,
        diffHunk: '',
        body: input.body,
        user: 'octocat',
        createdAt: 'T0',
        updatedAt: 'T0',
        htmlUrl: `https://github.com/acme/specs/pull/${pullNumber}#discussion_r${id}`,
      };
    },
  } as unknown as GitHubAdapter;
  return { adapter, creates };
}

describe('/__vs/collab/pulls/:n/drafts', () => {
  let dir: string;
  let gh: ReturnType<typeof draftAdapter>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vs-collab-drafts-'));
    gh = draftAdapter();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const drafts = (overrides: Partial<CollabDeps> = {}) =>
    router({ baseDir: () => dir, repoAdapter: () => gh.adapter, ...overrides });

  const send = (method: string, pathname: string, body: Record<string, unknown> = {}, overrides: Partial<CollabDeps> = {}) =>
    drafts(overrides).handle({ method, pathname, query: {}, body });

  /** Hold one comment and answer with its id. */
  async function hold(body: Record<string, unknown> = {}): Promise<string> {
    const res = await send('POST', '/pulls/7/drafts', {
      path: 'docs/spec.md',
      comment: 'this paragraph contradicts the one above',
      headSha: CURRENT_HEAD,
      ...body,
    });
    expect(res.status).toBe(200);
    return (res.json as { draft: { id: string } }).draft.id;
  }

  /* ---------------------------------------------------------------- *
   * R-13.13 / R-13.14 — held locally, no GitHub
   * ---------------------------------------------------------------- */
  it('holds a comment on disk without contacting GitHub, recording the head it was written against', async () => {
    const exploding = {
      getPullRequest() {
        throw new Error('writing a draft must not contact GitHub');
      },
      createReviewComment() {
        throw new Error('writing a draft must not contact GitHub');
      },
    } as unknown as GitHubAdapter;

    const res = await send(
      'POST',
      '/pulls/7/drafts',
      { path: 'docs/spec.md', comment: 'needs a caveat', headSha: OLD_HEAD, line: 12 },
      { repoAdapter: () => exploding },
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      draft: {
        pullNumber: 7,
        headSha: OLD_HEAD,
        status: 'draft',
        comment: 'needs a caveat',
        target: { path: 'docs/spec.md', kind: 'range', startLine: 12 },
      },
    });
    // R-13.5 — the store writes under the git-ignored directory of the served tree, and
    // R-W3.6 — under the repository the review resolved to, since #7 exists in more than
    // one repository and one file cannot hold two reviews' comments.
    expect(readFileSync(join(dir, '.visual-spec/reviews/acme/specs/pr-7.json'), 'utf8')).toContain('needs a caveat');
  });

  it('lists held and published comments together, in creation order', async () => {
    const first = await hold({ comment: 'one' });
    const second = await hold({ comment: 'two', line: 3 });
    await send('POST', `/pulls/7/drafts/${second}/publish`);

    const res = await send('GET', '/pulls/7/drafts');
    expect(res.status).toBe(200);
    const listed = (res.json as { drafts: { id: string; status: string }[] }).drafts;
    // R-13.17 — the published one is still there, marked, not deleted.
    expect(listed.map((d) => [d.id, d.status])).toEqual([
      [first, 'draft'],
      [second, 'published'],
    ]);
  });

  it('answers an empty list for a pull request nobody has commented on', async () => {
    expect(await send('GET', '/pulls/7/drafts')).toEqual({ status: 200, json: { drafts: [] } });
  });

  /* ---------------------------------------------------------------- *
   * Edge validation — 400 before disk, before network
   * ---------------------------------------------------------------- */
  describe('an unusable identifier is refused at the route', () => {
    for (const raw of ['0', 'abc', '-1', '1.5']) {
      it(`rejects pullNumber ${raw} on every drafts route`, async () => {
        for (const [method, path] of [
          ['GET', `/pulls/${raw}/drafts`],
          ['POST', `/pulls/${raw}/drafts`],
          ['DELETE', `/pulls/${raw}/drafts/d-deadbeef`],
          ['POST', `/pulls/${raw}/drafts/d-deadbeef/publish`],
        ] as const) {
          const res = await send(method, path, { path: 'a.md', comment: 'x', headSha: CURRENT_HEAD });
          expect(res.status, `${method} ${path}`).toBe(400);
          expect(res.json).toMatchObject({ error: `invalid pullNumber: ${raw}` });
        }
      });
    }

    /*
     * `c-...` is the id space of a GitHub review comment, not of a local draft, and the
     * two must never be confusable — which is why `newDraftId` mints `d-` at all.
     */
    for (const raw of ['c-deadbeef', 'nope', 'd-DEADBEEF', 'd-dead']) {
      it(`rejects draftId ${raw} on delete and publish`, async () => {
        for (const [method, path] of [
          ['DELETE', `/pulls/7/drafts/${raw}`],
          ['POST', `/pulls/7/drafts/${raw}/publish`],
        ] as const) {
          const res = await send(method, path);
          expect(res.status, `${method} ${path}`).toBe(400);
          expect(res.json).toMatchObject({ error: `invalid draftId: ${raw}` });
        }
      });
    }

    it('refuses an incomplete body before it reaches disk or GitHub', async () => {
      for (const body of [
        { comment: 'x', headSha: CURRENT_HEAD },
        { path: 'a.md', headSha: CURRENT_HEAD },
        { path: 'a.md', comment: 'x' },
        { path: 'a.md', comment: 'x', headSha: CURRENT_HEAD, startLine: 4, endLine: 2 },
        { path: 'a.md', comment: 'x', headSha: CURRENT_HEAD, line: 0 },
      ]) {
        const res = await send('POST', '/pulls/7/drafts', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(await send('GET', '/pulls/7/drafts')).toEqual({ status: 200, json: { drafts: [] } });
    });

    it('refuses a target that would escape the checkout', async () => {
      const res = await send('POST', '/pulls/7/drafts', {
        path: '../../etc/passwd',
        comment: 'x',
        headSha: CURRENT_HEAD,
      });
      expect(res.status).toBe(400);
    });

    it('answers 404 for a well-formed id that names no draft', async () => {
      const res = await send('POST', '/pulls/7/drafts/d-deadbeef/publish');
      expect(res.status).toBe(404);
      expect(gh.creates).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- *
   * Deleting
   * ---------------------------------------------------------------- */
  describe('DELETE /pulls/:n/drafts/:draftId', () => {
    it('removes a held comment', async () => {
      const id = await hold();
      expect(await send('DELETE', `/pulls/7/drafts/${id}`)).toEqual({ status: 200, json: { ok: true, removed: true } });
      expect(await send('GET', '/pulls/7/drafts')).toEqual({ status: 200, json: { drafts: [] } });
    });

    it('reports deleting something that was never there as a success', async () => {
      expect(await send('DELETE', '/pulls/7/drafts/d-deadbeef')).toEqual({
        status: 200,
        json: { ok: true, removed: false },
      });
    });

    it('refuses to delete a published record, because that record is the duplicate guard', async () => {
      const id = await hold();
      await send('POST', `/pulls/7/drafts/${id}/publish`);
      const res = await send('DELETE', `/pulls/7/drafts/${id}`);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ reason: 'already-published', error: expect.stringContaining('github.com') });
      expect((await send('GET', '/pulls/7/drafts')).json).toMatchObject({ drafts: [{ id, status: 'published' }] });
    });
  });

  /* ---------------------------------------------------------------- *
   * Publishing
   * ---------------------------------------------------------------- */
  describe('POST /pulls/:n/drafts/:draftId/publish', () => {
    it('anchors on the pull request’s CURRENT head, not the one stored on the draft', async () => {
      const id = await hold({ line: 12, headSha: CURRENT_HEAD });
      const res = await send('POST', `/pulls/7/drafts/${id}/publish`);
      expect(res.status).toBe(200);
      expect(gh.creates).toHaveLength(1);
      expect(gh.creates[0]).toMatchObject({
        pullNumber: 7,
        input: { path: 'docs/spec.md', commitId: CURRENT_HEAD, line: 12, startLine: 12, side: 'RIGHT' },
      });
    });

    it('posts a file-level comment when the held comment names no line', async () => {
      const id = await hold();
      await send('POST', `/pulls/7/drafts/${id}/publish`);
      expect(gh.creates[0]!.input.line).toBeUndefined();
    });

    it('marks the record published with the id and link GitHub returned (R-13.17)', async () => {
      const id = await hold();
      const res = await send('POST', `/pulls/7/drafts/${id}/publish`);
      expect(res.json).toMatchObject({
        ok: true,
        alreadyPublished: false,
        draft: { id, status: 'published', published: { reviewCommentId: 1001 } },
      });
      const stored = ((await send('GET', '/pulls/7/drafts')).json as { drafts: { published?: { htmlUrl: string } }[] }).drafts;
      expect(stored[0]!.published!.htmlUrl).toContain('#discussion_r1001');
    });

    /*
     * R-13.16, THE requirement this route exists to close. `markDraftPublished` is
     * first-write-wins on disk, but it runs AFTER the network call — so on its own it
     * would record one id while GitHub had been handed two comments. The gate is the
     * re-read of the record before the call, and the only way to assert it is by counting
     * the adapter's calls, not by inspecting the file afterwards.
     */
    it('publishing twice results in exactly one comment on the pull request', async () => {
      const id = await hold({ line: 4 });
      const first = await send('POST', `/pulls/7/drafts/${id}/publish`);
      const second = await send('POST', `/pulls/7/drafts/${id}/publish`);

      expect(gh.creates).toHaveLength(1);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.json).toMatchObject({ alreadyPublished: false });
      // A redundant publish is answered, not refused: the caller asked for the comment to
      // be on the pull request, and it is — with the link from the FIRST publish.
      expect(second.json).toMatchObject({
        ok: true,
        alreadyPublished: true,
        draft: { id, status: 'published', published: { reviewCommentId: 1001 } },
      });
    });

    it('re-reads the record from disk, so a second server also refuses to post again', async () => {
      const id = await hold();
      await send('POST', `/pulls/7/drafts/${id}/publish`);
      // A brand-new router over the same directory: nothing is carried in memory.
      const fresh = draftAdapter();
      const res = await drafts({ repoAdapter: () => fresh.adapter }).handle({
        method: 'POST',
        pathname: `/pulls/7/drafts/${id}/publish`,
        query: {},
        body: {},
      });
      expect(fresh.creates).toHaveLength(0);
      expect(res.json).toMatchObject({ alreadyPublished: true });
    });

    it('leaves the record publishable when GitHub refuses', async () => {
      const failing = draftAdapter({ createFails: new GitHubError('createReviewComment', 'Unprocessable', 500, 'server') });
      const id = await hold();
      const res = await drafts({ repoAdapter: () => failing.adapter }).handle({
        method: 'POST',
        pathname: `/pulls/7/drafts/${id}/publish`,
        query: {},
        body: {},
      });
      expect(res.status).toBe(502);
      expect((await send('GET', '/pulls/7/drafts')).json).toMatchObject({ drafts: [{ id, status: 'draft' }] });
    });

    /* -------------------------------------------------------------- *
     * The stale case
     * -------------------------------------------------------------- */
    it('refuses to publish against a head the comment was not written against, naming both', async () => {
      const id = await hold({ headSha: OLD_HEAD, line: 12 });
      const res = await send('POST', `/pulls/7/drafts/${id}/publish`);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ reason: 'stale-draft', draftHeadSha: OLD_HEAD, currentHeadSha: CURRENT_HEAD });
      expect(gh.creates).toHaveLength(0);
      expect((await send('GET', '/pulls/7/drafts')).json).toMatchObject({ drafts: [{ id, status: 'draft' }] });
    });

    it('publishes a stale comment when the reviewer says so explicitly', async () => {
      const id = await hold({ headSha: OLD_HEAD, line: 12 });
      const res = await send('POST', `/pulls/7/drafts/${id}/publish`, { force: true });
      expect(res.status).toBe(200);
      // Still anchored on the CURRENT head — forcing changes what is allowed, not what is
      // truthful about which commit GitHub is being asked to anchor to.
      expect(gh.creates[0]!.input.commitId).toBe(CURRENT_HEAD);
    });
  });

  /* ---------------------------------------------------------------- *
   * Authorization (R-9.8)
   * ---------------------------------------------------------------- */
  describe('the operations these routes gate on', () => {
    it('gates the local routes on `read` and the publish on `comment`', async () => {
      const seen: CollabOperation[] = [];
      const authorize: CollabAuthorizer = (op) => {
        seen.push(op);
        return { ok: true };
      };
      const id = await hold();
      seen.length = 0;
      const r = drafts({ authorize });
      await r.handle({ method: 'GET', pathname: '/pulls/7/drafts', query: {}, body: {} });
      await r.handle({
        method: 'POST',
        pathname: '/pulls/7/drafts',
        query: {},
        body: { path: 'a.md', comment: 'x', headSha: CURRENT_HEAD },
      });
      await r.handle({ method: 'DELETE', pathname: `/pulls/7/drafts/${id}`, query: {}, body: {} });
      await r.handle({ method: 'POST', pathname: `/pulls/7/drafts/${id}/publish`, query: {}, body: {} });

      // `comment` is `any-role` (R-9.8) — a reviewer with no write access may publish a
      // held comment, because commenting on a pull request needs no write access.
      expect(seen).toEqual(['read', 'read', 'read', 'comment']);
    });

    it('honours a refusal, and reports collaboration being off as a 503', async () => {
      const authorize: CollabAuthorizer = () => ({ ok: false, status: 403, error: 'nope' });
      expect(await send('GET', '/pulls/7/drafts', {}, { authorize })).toEqual({ status: 403, json: { error: 'nope' } });
      const off = await send('GET', '/pulls/7/drafts', {}, { config: () => DISABLED });
      expect(off.status).toBe(503);
    });
  });

  it('every drafts handler is declared above the scoped-documentId match in the source', () => {
    const text = src('core/vite/routes/collab.ts');
    const scoped = text.indexOf('const scoped = /^\\/([^/]+)(\\/.*)?$/.exec(pathname)');
    for (const marker of ['/^\\/pulls\\/([^/]+)\\/drafts$/', '/^\\/pulls\\/([^/]+)\\/drafts\\/([^/]+)$/', '/^\\/pulls\\/([^/]+)\\/drafts\\/([^/]+)\\/publish$/']) {
      const at = text.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      expect(at, marker).toBeLessThan(scoped);
    }
  });
});


/* ================================================================== *
 * GET /pulls/:n/description
 * ================================================================== */
describe('GET /__vs/collab/pulls/:n/description', () => {
  /*
   * The listing carries no bodies on purpose — it is every open pull request, and a body
   * is unbounded prose most rows will never have read. So this is its own call, made once,
   * for the row a reviewer opened.
   */
  it('answers the body, and only the body', async () => {
    const gh = repoAdapter({ body: '## Why\n\nBecause the rules changed.' });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/7/description');

    expect(res.status).toBe(200);
    // Not the detail: `mergeable` and friends are facts the browser already has from the
    // listing and cannot keep current, so a second staler copy must not travel with this.
    expect(res.json).toEqual({ pullNumber: 7, body: '## Why\n\nBecause the rules changed.' });
  });

  /* An empty body is a real answer; `null` would make "none" look like "not read yet". */
  it('answers an empty string when the pull request has no description', async () => {
    const res = await call(router(), 'GET', '/pulls/7/description');
    expect(res.json).toEqual({ pullNumber: 7, body: '' });
  });

  /* Refused at the edge with the route's own wording, the same way `/files` refuses it. */
  it('refuses a pull number that is not one', async () => {
    const res = await call(router(), 'GET', '/pulls/nope/description');
    expect(res).toEqual({ status: 400, json: { error: 'invalid pullNumber: nope' } });
  });

  it('passes GitHub’s own sentence through on failure (R-11.4)', async () => {
    const gh = repoAdapter({ pullFails: new GitHubError('getPullRequest', 'Not Found', 404) });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/7/description');
    expect(res).toEqual({ status: 404, json: { error: 'Not Found' } });
  });
});

/* ================================================================== *
 * GET /pulls/awaiting — the two counts that are waiting on *me*
 * ================================================================== */

/**
 * The repo-level adapter as the `awaiting` route drives it, counting every call.
 *
 * The counting is the assertion, not a convenience: R-A2.9 is a statement about queries
 * *issued*, and an empty response body is no evidence that none were.
 */
function awaitingAdapter(
  options: {
    pulls?: PullRequestSummary[];
    /** Per qualifier: the result, or the error that query answers with. */
    search?: Partial<Record<PullRequestSearchQualifier, PullRequestSearchResult | Error>>;
    listFails?: Error;
    reviewComments?: ReviewComment[];
  } = {},
) {
  const searches: { qualifier: string; login: string }[] = [];
  const lists: string[] = [];
  const adapter = {
    async searchPullRequests(_repo: unknown, qualifier: PullRequestSearchQualifier, login: string) {
      searches.push({ qualifier, login });
      const answer = options.search?.[qualifier] ?? { total: 0, items: [] };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async listPullRequests(_repo: unknown, state?: string) {
      lists.push(state ?? 'open');
      if (options.listFails) throw options.listFails;
      return options.pulls ?? [];
    },
    async listReviewComments(_repo: unknown, _pullNumber: number) {
      return options.reviewComments ?? [];
    },
  } as unknown as GitHubAdapter;
  return { adapter, searches, lists, calls: () => searches.length + lists.length };
}

const awaiting = (res: CollabRouteResult): Awaiting => res.json as Awaiting;

/* ------------------------------------------------------------------ *
 * R-A2.4 / R-A2.5 — the login is the server's, and it is checked
 * ------------------------------------------------------------------ */
describe('the login the counts are taken for', () => {
  /*
   * The login is interpolated into the search `q`, which is space-separated free text —
   * so `me repo:other/repo` is not a malformed login, it is a *second qualifier*, and the
   * chip would then count another repository under this repository's name.
   */
  it('rejects anything outside GitHub’s login character set', () => {
    for (const bad of ['me repo:other/repo', 'a b', 'x"y', '', '-ana', 'ana-', 'a/b', 'ana@b']) {
      expect(GITHUB_LOGIN_RE.test(bad), bad).toBe(false);
    }
    for (const good of ['ana-b', 'Bob99', 'octocat', 'a']) {
      expect(GITHUB_LOGIN_RE.test(good), good).toBe(true);
    }
  });

  it('refuses to build a query at all when the session reports an unusable login', async () => {
    const gh = awaitingAdapter();
    const res = await call(
      router({
        repoAdapter: () => gh.adapter,
        preflight: async () => ({ ...OK_PREFLIGHT, login: 'me repo:other/repo' }),
      }),
      'GET',
      '/pulls/awaiting',
    );
    expect(res.status).toBe(500);
    // The point of R-A2.5: rejected *before* it reaches a query, not filtered afterwards.
    expect(gh.calls()).toBe(0);
  });

  /*
   * R-A2.4 — the availability snapshot is visible to the browser, so a login it could
   * supply would be spoofable. The route reads neither the query string nor the body.
   */
  it('ignores a login supplied by the client, in the query string or in the body', async () => {
    const gh = awaitingAdapter();
    const r = router({ repoAdapter: () => gh.adapter });
    await r.handle({ method: 'GET', pathname: '/pulls/awaiting', query: { login: 'someone-else' }, body: {} });
    await r.handle({ method: 'GET', pathname: '/pulls/awaiting', query: {}, body: { login: 'someone-else' } });
    // Two queries per request — the review side and the mention side — and every one of
    // the four carries the session's login, never the one the client offered.
    expect(gh.searches).toHaveLength(4);
    expect(new Set(gh.searches.map((s) => s.login))).toEqual(new Set(['octocat']));
  });
});

/* ------------------------------------------------------------------ *
 * R-A2.9 — an unconfigured server issues nothing
 * ------------------------------------------------------------------ */
describe('with collaboration unconfigured', () => {
  it('issues zero calls to the adapter, not merely an empty answer', async () => {
    const gh = awaitingAdapter();
    const res = await call(router({ config: () => DISABLED, repoAdapter: () => gh.adapter }), 'GET', '/pulls/awaiting');
    expect(res.status).toBe(503);
    expect(gh.calls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * R-A4.4 / R-A4.5 / R-A4.6 — the payload, one side at a time
 * ------------------------------------------------------------------ */
describe('GET /__vs/collab/pulls/awaiting', () => {
  const REVIEWED: PullRequestSearchResult = {
    // GitHub's own total, deliberately larger than the page it returned (R-A2.10).
    total: 40,
    items: [{ number: 7, title: 'Tighten the onboarding guide', htmlUrl: 'https://github.com/acme/specs/pull/7' }],
  };
  const MENTIONED: PullRequestSearchResult = {
    total: 1,
    items: [{ number: 9, title: 'Rewrite the glossary', htmlUrl: 'https://github.com/acme/specs/pull/9' }],
  };
  /** A 422 is what `search/issues` answers for a repository this credential cannot search. */
  const UNSEARCHABLE = new GitHubError('searchPullRequests', 'Validation Failed', 422, 'unprocessable');

  it('answers both sides when both queries land', async () => {
    const gh = awaitingAdapter({
      search: { 'review-requested': REVIEWED, mentions: MENTIONED },
      pulls: [summary({ number: 11, updatedAt: 'T1' })],
      reviewComments: [reviewComment({ id: 3, user: 'ana', body: 'ping @octocat — this paragraph contradicts the one above' })],
    });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/awaiting');

    expect(res.status).toBe(200);
    const body = awaiting(res);
    // `total` is GitHub's, not `items.length`: the panel states the shortfall (R-A3.8).
    expect(body.reviewRequested).toEqual({ ok: true, total: 40, items: REVIEWED.items, complete: true });
    expect(body.mentioned.ok).toBe(true);
    if (!body.mentioned.ok) throw new Error('unreachable');
    // The union of both sources: #9 from search, #11 from a review comment (R-A2.6).
    expect(body.mentioned.items.map((i) => i.number)).toEqual([11, 9]);
    expect(body.mentioned.total).toBe(2);
    expect(body.mentioned.complete).toBe(true);
    // R-A3.7 — who wrote it and what it said, already in hand at the moment it matched.
    expect(body.mentioned.items[0]!.mention).toMatchObject({ author: 'ana' });
    expect(body.mentioned.items[0]!.mention!.excerpt).toContain('@octocat');
  });

  /*
   * R-A4.6 — the repository being unsearchable is a failure of *this* read. The pull
   * request listing has its own route and its own error field, and neither is touched.
   */
  it('reports a failed review side alone, leaving the listing’s error field untouched', async () => {
    const gh = awaitingAdapter({ search: { 'review-requested': UNSEARCHABLE, mentions: MENTIONED } });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/awaiting');

    expect(res.status).toBe(200);
    expect(awaiting(res).reviewRequested).toEqual({ ok: false });
    expect(awaiting(res).mentioned).toMatchObject({ ok: true, total: 1 });
    expect(res.json).not.toHaveProperty('error');
  });

  it('reports a failed mention side alone', async () => {
    const gh = awaitingAdapter({
      search: { 'review-requested': REVIEWED },
      listFails: new GitHubError('listPullRequests', 'Not Found', 404, 'not_found'),
    });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/awaiting');

    expect(res.status).toBe(200);
    expect(awaiting(res).reviewRequested).toMatchObject({ ok: true, total: 40 });
    expect(awaiting(res).mentioned).toEqual({ ok: false });
  });

  /*
   * R-A4.5 — one of the *two mention sources* failed. The number that comes back is real
   * but low, and saying so is the difference between a reduced count and a wrong one.
   */
  it('marks the mention union incomplete when only one of its two sources answered', async () => {
    const gh = awaitingAdapter({
      search: { 'review-requested': REVIEWED, mentions: UNSEARCHABLE },
      pulls: [summary({ number: 11, updatedAt: 'T1' })],
      reviewComments: [reviewComment({ id: 3, user: 'ana', body: 'over to you @octocat' })],
    });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/awaiting');

    expect(res.status).toBe(200);
    const { mentioned } = awaiting(res);
    expect(mentioned).toMatchObject({ ok: true, total: 1, complete: false });
    expect(awaiting(res).reviewRequested).toMatchObject({ ok: true });
  });

  it('answers with the family’s own failure shape when neither side could be read', async () => {
    const gh = awaitingAdapter({
      search: { 'review-requested': UNSEARCHABLE, mentions: UNSEARCHABLE },
      listFails: new GitHubError('listPullRequests', 'Not Found', 404, 'not_found'),
    });
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/awaiting');
    expect(res).toEqual({ status: 422, json: { error: 'Validation Failed' } });
  });

  it('gates on `read` with no document, like the rest of the family', async () => {
    const seen: CollabOperation[] = [];
    const authorize: CollabAuthorizer = (op) => {
      seen.push(op);
      return { ok: true };
    };
    await call(router({ authorize, repoAdapter: () => awaitingAdapter().adapter }), 'GET', '/pulls/awaiting');
    expect(seen).toEqual(['read']);
  });
});

/* ================================================================== *
 * R-A2.2 — GUARD. The notification inbox is not a source, ever.
 * ================================================================== */
describe('R-A2.2 — no count derives from the notification inbox', () => {
  /*
   * DO NOT RELAX. This is the decision a future implementer is most likely to reverse for
   * looking cheaper — one endpoint instead of several — and it is wrong for three
   * independent reasons, any one of them sufficient. Checked against the live account:
   * the inbox held 26 items, **zero** of them a mention or a review request, while
   * `review-requested:@me` returned two real pull requests. It also only ever contains
   * subscribed threads, and it is emptied by reading a notification anywhere else —
   * including on a phone — so the count would fall while the obligation stayed.
   *
   * A prose requirement leaves no mark when someone tries, so this is a source-level guard
   * in the style of `core/editing/local-mode.regression.test.ts`: no module on the path
   * that answers `/pulls/awaiting` may so much as name the endpoint.
   */
  for (const path of ['core/vite/routes/collab.ts', 'core/collaboration/github-adapter.ts']) {
    it(`${path} does not reference notifications`, () => {
      expect(src(path)).not.toMatch(/notification/i);
    });
  }
});
