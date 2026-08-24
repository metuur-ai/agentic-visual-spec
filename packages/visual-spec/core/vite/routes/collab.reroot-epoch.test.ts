/**
 * collab.reroot-epoch.test.ts — R-10.6, the request that outlives its configuration.
 *
 * R-10.1 moved the collaboration repository with the served directory. That left one
 * hole, and it is the only path in this router that can write to a repository nobody
 * chose: the server has ONE root and the browser has N tabs. Tab B re-roots to
 * repository B; tab A is never told to reload, and its next comment or reply resolves
 * through `deps.config().collaboration` — now B — and posts there. `worktree.ts`'s
 * `expectedHeadSha` check catches this for a mount, but nothing downstream of a comment
 * POST would: pull request 42 exists in most repositories.
 *
 * The seam every test here uses is the injected preflight, because that is where a real
 * request spends its time: `gate()` reads the configured repository, then awaits GitHub
 * twice (availability, authorization) before any handler acts. Re-rooting inside that
 * window is the same event as re-rooting between two requests, expressed as something a
 * test can hold still.
 *
 * No real network, no `gh` and no `git`: every executor is injected.
 */
import { describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { GitHubAdapter, RepoRef } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { GitExecutor } from '../../git-context';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabDeps, type CollabRouteResult, createCollabRoutes } from './collab';

const CONFIGURED = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;

const ENABLED: ResolvedVisualSpecConfig = {
  surfacesDir: 'surfaces',
  collaboration: { ...CONFIGURED },
  git: { allowCheckout: false },
};

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...CONFIGURED },
};

const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });
const noGit: GitExecutor = async () => ({ stdout: '', exitCode: 1 });

/** A valid `c-<hex>` review comment id — 0x1a2b3c. */
const COMMENT_ID = 'c-1a2b3c';

/**
 * The repo-level adapter double. `writes` is the assertion that matters: a refusal that
 * still reached GitHub would be a refusal in name only.
 */
function repoAdapter() {
  const writes: { repo: RepoRef; pullNumber: number }[] = [];
  const reads: RepoRef[] = [];
  const adapter = {
    async listPullRequests(repo: RepoRef) {
      reads.push(repo);
      return [];
    },
    async replyToReviewComment(repo: RepoRef, pullNumber: number) {
      writes.push({ repo, pullNumber });
      return {
        id: 99,
        path: 'docs/spec.md',
        body: 'reply',
        user: 'octocat',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        htmlUrl: 'https://github.com/x/y/pull/42#discussion_r99',
      };
    },
  } as unknown as GitHubAdapter;
  return { adapter, writes, reads };
}

function router(overrides: Partial<CollabDeps> = {}) {
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents: () => {
      throw new Error('no test in this file reads the document store');
    },
    preflight: async () => OK_PREFLIGHT,
    authorize: ALLOW_ALL,
    baseDir: () => '/tmp/does-not-matter',
    git: noGit,
    repoAdapter: () => repoAdapter().adapter,
    ...overrides,
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
): Promise<CollabRouteResult> => r.handle({ method, pathname, query: {}, body });

describe('R-10.6 — a request whose repository was resolved from a configuration that has since changed', () => {
  it('refuses a review reply with 409 and posts nothing when the root moves mid-request', async () => {
    const gh = repoAdapter();
    // Assigned before `router()` returns is impossible — `rerooted()` lives on the
    // router — so the preflight reaches for it through a box it closes over.
    let r: ReturnType<typeof router>;
    r = router({
      repoAdapter: () => gh.adapter,
      // The re-root lands while this request is inside `gate()`, exactly as it would if
      // a second tab picked a new directory a millisecond after this POST arrived.
      preflight: async () => {
        r.rerooted();
        return OK_PREFLIGHT;
      },
    });

    const res = await call(r, 'POST', `/pulls/42/comments/${COMMENT_ID}/reply`, { comment: 'hello' });

    expect(res.status).toBe(409);
    expect((res.json as { reason?: string }).reason).toBe('root-changed');
    // The refusal is BEFORE the network, not a rollback after it.
    expect(gh.writes).toEqual([]);
  });

  it('serves the same request normally when the root does not move', async () => {
    const gh = repoAdapter();
    const res = await call(
      router({ repoAdapter: () => gh.adapter }),
      'POST',
      `/pulls/42/comments/${COMMENT_ID}/reply`,
      { comment: 'hello' },
    );

    expect(res.status).toBe(200);
    expect(gh.writes).toEqual([{ repo: { owner: 'acme', repo: 'specs' }, pullNumber: 42 }]);
  });

  it('refuses a read gated the same way, so the rule is the gate and not one handler', async () => {
    let r: ReturnType<typeof router>;
    r = router({
      preflight: async () => {
        r.rerooted();
        return OK_PREFLIGHT;
      },
    });

    const res = await call(r, 'GET', '/pulls');
    expect(res.status).toBe(409);
  });

  it('lets the next request through, because the epoch is a comparison and not a latch', async () => {
    const gh = repoAdapter();
    let reroot = true;
    let r: ReturnType<typeof router>;
    r = router({
      repoAdapter: () => gh.adapter,
      preflight: async () => {
        if (reroot) r.rerooted();
        reroot = false;
        return OK_PREFLIGHT;
      },
    });

    const first = await call(r, 'POST', `/pulls/42/comments/${COMMENT_ID}/reply`, { comment: 'a' });
    const second = await call(r, 'POST', `/pulls/42/comments/${COMMENT_ID}/reply`, { comment: 'b' });

    expect(first.status).toBe(409);
    expect(second.status).toBe(200);
    expect(gh.writes).toHaveLength(1);
  });

  it('drops the cached availability snapshot, so the new repository is preflighted afresh', async () => {
    const asked: string[] = [];
    const r = router({
      preflight: async (repo) => {
        asked.push(`${repo.owner}/${repo.repo}`);
        return OK_PREFLIGHT;
      },
    });

    await call(r, 'GET', '/pulls');
    await call(r, 'GET', '/pulls');
    // Second call served from the availability cache.
    expect(asked).toHaveLength(1);

    r.rerooted();
    await call(r, 'GET', '/pulls');
    expect(asked).toHaveLength(2);
  });
});
