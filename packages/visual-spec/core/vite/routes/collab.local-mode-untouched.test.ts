/**
 * collab.local-mode-untouched.test.ts — R-W5.1 and R-W4.4: the two things the second
 * review source was allowed to add a path for, and forbidden to disturb.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `collab.pulls.test.ts`. That file measures what
 * the review routes *do*. This one measures what they do NOT do when nobody asked for
 * them, and the difference matters because the regression this guards is silent: source
 * resolution now runs on paths that used to refuse outright, and the resolution reads a
 * pull request, reads the served directory's git context, and can mount a worktree. Every
 * one of those is a thing local mode never paid for. A server with no `collaboration`
 * block must still cost nothing — no `gh`, no `git`, no byte on disk — and "it answers
 * 503" is not that claim. It is only the part of it that shows in a response body.
 *
 * SO THE DOUBLES THROW RATHER THAN RECORD. `repoAdapter`, `git`, `preflight` and
 * `documents` are wired to raise. A route that reaches any of them fails loudly here
 * instead of being caught later by an assertion nobody wrote — which is the same argument
 * `collab.pulls.test.ts` makes for its throwing `documents()` thunk.
 *
 * AND THE DIRECTORY IS SNAPSHOTTED. The withdrawn workspace design created a managed root
 * and provisioned clones into it. Nothing of it landed, and the cheapest way to keep that
 * true is to walk the served directory — and its parent — before and after a full,
 * refused review and require the two walks to be identical. A `mkdir` that crept back in
 * is then a failure with the offending path in it, rather than a design note.
 *
 * The second half is R-W4.4, which is not a hypothetical: `pull-requests-awaiting-you` is
 * shipped and rides on `GET /pulls` and `GET /pulls/awaiting`. Both are asserted to still
 * address the CONFIGURED repository, because "the repository is now a request parameter"
 * is exactly the change that would quietly stop them doing so.
 *
 * No network, no `gh`, no `git`: every executor is injected (R-4.8 / R-12.3).
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { GitHubAdapter, PullRequestSummary } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { GitExecutor } from '../../git-context';
import type { ResolvedVisualSpecConfig } from '../../config';
import {
  type Awaiting,
  type CollabAuthorizer,
  type CollabDeps,
  type CollabRouteResult,
  createCollabRoutes,
} from './collab';

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO }, git: { allowCheckout: false } };
const DISABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: null, git: { allowCheckout: false } };

const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

/**
 * Every route a review touches, in the order a reviewer touches them. Used twice: once to
 * prove local mode refuses all of them without spending anything, and once as the walk
 * whose filesystem effect must be nil.
 */
const REVIEW_ROUTES: { method: string; pathname: string; body?: Record<string, unknown> }[] = [
  { method: 'GET', pathname: '' },
  { method: 'GET', pathname: '/pulls' },
  { method: 'GET', pathname: '/pulls/awaiting' },
  { method: 'GET', pathname: '/pulls/mounted' },
  { method: 'POST', pathname: '/pulls/7/mount' },
  { method: 'GET', pathname: '/pulls/7/files' },
  { method: 'GET', pathname: '/pulls/7/description' },
  { method: 'GET', pathname: '/pulls/7/tree' },
  { method: 'GET', pathname: '/pulls/7/raw' },
  { method: 'GET', pathname: '/pulls/7/comments' },
  { method: 'GET', pathname: '/pulls/7/drafts' },
  { method: 'POST', pathname: '/pulls/7/drafts', body: { path: 'docs/spec.md', comment: 'hello', headSha: 'a'.repeat(40), line: 3 } },
  { method: 'DELETE', pathname: '/pulls/7/mount' },
];

/** Every path under `dir`, relative and sorted. Directories included — this is about creation. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      out.push(relative(dir, child));
      if (statSync(child).isDirectory()) visit(child);
    }
  };
  visit(dir);
  return out.sort();
}

let sandbox: string;
let served: string;

beforeEach(async () => {
  // `served` sits INSIDE `sandbox` so the walk covers both "wrote into the served
  // directory" and "provisioned a workspace beside it", which is the shape the withdrawn
  // design had.
  sandbox = await mkdtemp(join(tmpdir(), 'vs-local-mode-'));
  served = join(sandbox, 'project');
  await mkdir(served);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** The doubles all raise: local mode may reach none of them. */
function unconfiguredRouter(overrides: Partial<CollabDeps> = {}) {
  const forbidden = (what: string) => () => {
    throw new Error(`local mode must not reach ${what}`);
  };
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => DISABLED,
    documents: forbidden('the document store'),
    preflight: forbidden('the GitHub preflight') as unknown as CollabDeps['preflight'],
    repoAdapter: forbidden('the GitHub adapter') as unknown as CollabDeps['repoAdapter'],
    git: (() => {
      throw new Error('local mode must not exec git');
    }) as unknown as GitExecutor,
    authorize: ALLOW_ALL,
    baseDir: () => served,
    ...overrides,
  });
}

const call = (
  r: { handle: (req: { method: string; pathname: string; query: Record<string, string>; body: Record<string, unknown> }) => Promise<CollabRouteResult> },
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
) => r.handle({ method, pathname, query, body });

/* ================================================================== *
 * R-W5.1 — with no collaboration configured, nothing of this feature runs
 * ================================================================== */
describe('R-W5.1 — an unconfigured server behaves as it did before this feature', () => {
  it('reports itself unavailable in exactly the shape it always did', async () => {
    const r = unconfiguredRouter();
    const res = await call(r, 'GET', '');

    // 200, not 503: this is the flag the UI reads to decide whether collaboration
    // controls exist at all, and "off" has always been an ordinary answer (R-7.8).
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      available: false,
      reason: 'not-configured',
      message: expect.stringContaining('Local mode is unaffected.'),
      missingScopes: [],
    });
    // No `canPublish`, no `publishBlocked`: the write probe is behind the availability
    // check and an unconfigured server never reaches it.
    expect(Object.keys(res.json as object).sort()).toEqual(['available', 'message', 'missingScopes', 'reason']);
    r.dispose();
  });

  it('refuses every review route with that same payload, having constructed no review source', async () => {
    const r = unconfiguredRouter();
    for (const { method, pathname, body } of REVIEW_ROUTES) {
      const res = await call(r, method, pathname, body ?? {});
      if (pathname === '') continue; // the availability route itself, asserted above.
      expect(res.status, `${method} ${pathname}`).toBe(503);
      expect(res.json, `${method} ${pathname}`).toMatchObject({ available: false, reason: 'not-configured' });
    }
    // The proof that no source was resolved is that none of the throwing doubles fired:
    // a resolution cannot happen without `getPullRequest` (the head it pins to) and
    // `readGitContext` (the directory it decides from), and both would have thrown.
    r.dispose();
  });

  it('creates no directory and writes no file, in the served directory or beside it', async () => {
    const before = walk(sandbox);
    const r = unconfiguredRouter();
    for (const { method, pathname, body } of REVIEW_ROUTES) await call(r, method, pathname, body ?? {});
    r.dispose();

    // Nothing at all: no workspace root, no `.visual-spec/`, no `reviews/`, no
    // `.gitignore` written on the way to a mount that never happened.
    expect(walk(sandbox)).toEqual(before);
  });
});

/* ================================================================== *
 * R-W4.4 — the configured repository's listing is a shipped feature
 * ================================================================== */
describe('R-W4.4 — the configured repository still supplies the pull request listing', () => {
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

  /** Records which repository each repo-level call addressed. */
  function recordingAdapter() {
    const listed: unknown[] = [];
    const searched: { repo: unknown; qualifier: string; login: string }[] = [];
    const adapter = {
      async listPullRequests(repo: unknown, state?: string) {
        listed.push({ repo, state });
        return [summary()];
      },
      async searchPullRequests(repo: unknown, qualifier: string, login: string) {
        searched.push({ repo, qualifier, login });
        return { total: 1, items: [{ number: 7, title: 'Tighten the onboarding guide', htmlUrl: summary().htmlUrl, repo: 'acme/specs', updatedAt: 'T0', author: 'octocat' }] };
      },
      async listReviewComments() {
        return [];
      },
    } as unknown as GitHubAdapter;
    return { adapter, listed, searched };
  }

  function configuredRouter(gh: GitHubAdapter) {
    return createCollabRoutes({
      jobs: createJobHubRegistry(),
      config: () => ENABLED,
      documents: () => {
        throw new Error('the /pulls family must not read the document store');
      },
      preflight: async () => OK_PREFLIGHT,
      authorize: ALLOW_ALL,
      baseDir: () => served,
      repoAdapter: () => gh,
    });
  }

  it('GET /pulls lists the configured repository, unchanged', async () => {
    const gh = recordingAdapter();
    const r = configuredRouter(gh.adapter);
    const res = await call(r, 'GET', '/pulls');

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ pulls: [{ number: 7, title: 'Tighten the onboarding guide' }] });
    // The configured repository, not one taken from the request — there is none in it.
    expect(gh.listed).toEqual([{ repo: { owner: 'acme', repo: 'specs' }, state: 'open' }]);
    r.dispose();
  });

  it('GET /pulls/awaiting still answers both sides against the configured repository', async () => {
    const gh = recordingAdapter();
    const r = configuredRouter(gh.adapter);
    const res = await call(r, 'GET', '/pulls/awaiting');

    expect(res.status).toBe(200);
    const body = res.json as Awaiting;
    expect(body.reviewRequested).toMatchObject({ ok: true, total: 1, complete: true });
    expect(body.mentioned.ok).toBe(true);

    // R-A2.4 — the login is the preflight's, never the caller's, and both searches (the
    // review-request side and the mention scan's own) are scoped to the configured
    // repository.
    expect(gh.searched).toEqual([
      { repo: { owner: 'acme', repo: 'specs' }, qualifier: 'review-requested', login: 'octocat' },
      { repo: { owner: 'acme', repo: 'specs' }, qualifier: 'mentions', login: 'octocat' },
    ]);
    // The mention side reads the open listing of the same repository (R-A2.6).
    expect(gh.listed).toEqual([{ repo: { owner: 'acme', repo: 'specs' }, state: 'open' }]);
    r.dispose();
  });
});
