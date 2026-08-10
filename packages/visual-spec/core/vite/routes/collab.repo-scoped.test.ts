/**
 * collab.repo-scoped.test.ts — reviewing a pull request of a repository the server was
 * not started against (Unit 3, R-W3.1 … R-W3.8, and the R-W6.4 … R-W6.6 tests Unit 6 asks
 * for by name).
 *
 * Kept apart from `collab.pulls.test.ts` for the reason that file is kept apart from
 * `collab.test.ts`: everything here is about the repository a request NAMES, and the
 * doubles it needs — an adapter that records which repository it was asked about, an
 * authorizer that records the same, a preflight that answers per repository — are shared
 * by no test there. The legacy-form assertions live here too, deliberately: "the old form
 * still resolves the configured repository" is only meaningful next to "the new form
 * resolves the named one".
 *
 * No real network, no `gh` and no `git`: every executor is injected (R-4.8 / R-12.3).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { GitHubAdapter, RepoRef } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { GitExecutor } from '../../git-context';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabDeps, type CollabRouteResult, createCollabRoutes } from './collab';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = (rel: string) => readFileSync(resolve(pkgRoot, rel), 'utf8');

/** The repository the server was started against. Every "configured" assertion is this one. */
const CONFIGURED = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
/** A repository the server was NOT started against — the one this whole unit exists for. */
const OTHER: RepoRef = { owner: 'other', repo: 'tools' };

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

/**
 * The repo-level adapter double, recording the repository of every call.
 *
 * `repos` is the whole point: a route that resolved the wrong repository still answers
 * 200 with a plausible pull request list, so the only thing that can catch it is what
 * GitHub was asked about.
 */
function repoAdapter() {
  const repos: RepoRef[] = [];
  const adapter = {
    async listPullRequests(repo: RepoRef) {
      repos.push(repo);
      return [];
    },
    async getPullRequest(repo: RepoRef, pullNumber: number) {
      repos.push(repo);
      return {
        number: pullNumber,
        headSha: 'a'.repeat(40),
        baseBranch: 'main',
        headBranch: 'patch-1',
        state: 'open',
        htmlUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${pullNumber}`,
        body: '',
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
      };
    },
    async listReviewComments(repo: RepoRef) {
      repos.push(repo);
      return [];
    },
    async listThreadResolution(repo: RepoRef) {
      repos.push(repo);
      return [];
    },
    async compareCommits(repo: RepoRef) {
      repos.push(repo);
      return { mergeBaseSha: 'b'.repeat(40), aheadBy: 1, behindBy: 0, files: ['docs/spec.md'] };
    },
    async listFiles(repo: RepoRef, path: string) {
      repos.push(repo);
      return [{ name: 'spec.md', path: `${path}spec.md`, type: 'file', sha: 'c'.repeat(40), size: 3 }];
    },
    async getFile(repo: RepoRef, path: string) {
      repos.push(repo);
      return { path, content: '# from the host\n', sha: 'c'.repeat(40) };
    },
  } as unknown as GitHubAdapter;
  return { adapter, repos };
}

/**
 * A served directory that is NOT a git working tree, so every review here takes the host
 * source (R-W1.3) and no test in this file depends on a checkout it did not create. The
 * repository under review is the subject; where its bytes come from is not.
 */
const noGit: GitExecutor = async () => ({ stdout: '', exitCode: 1 });

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
    git: noGit,
    repoAdapter: () => repoAdapter().adapter,
    ...overrides,
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  query: Record<string, string> = {},
  body: Record<string, unknown> = {},
): Promise<CollabRouteResult> => r.handle({ method, pathname, query, body });

/* ================================================================== *
 * R-W3.1 / R-W3.2 — the repository is named in the PATH
 * ================================================================== */
describe('R-W3.1 — a request that reviews a pull request names its repository', () => {
  /*
   * The repository travels in the path and not in a body field or a header for two
   * reasons that are both about what CANNOT go wrong. A body field is absent on every
   * GET in this family, so "the client forgot it" would have to be answered by
   * substituting the configured repository — the exact wrong-repository review R-W3.1
   * forbids. A header cannot carry it at all: `GET /:id/events` is an `EventSource`, and
   * `EventSource` has no way to set one, which is the same reason the request guard is
   * not a bearer token.
   */
  it('resolves the repository named in the path, not the configured one', async () => {
    const gh = repoAdapter();
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/repos/other/tools/pulls');
    expect(res.status).toBe(200);
    expect(gh.repos).toEqual([OTHER]);
  });

  it('resolves the named repository on every route in the family, not only the listing', async () => {
    const gh = repoAdapter();
    const r = router({ repoAdapter: () => gh.adapter });
    for (const path of [
      '/repos/other/tools/pulls',
      '/repos/other/tools/pulls/42/description',
      '/repos/other/tools/pulls/42/files',
      '/repos/other/tools/pulls/42/comments',
      '/repos/other/tools/pulls/42/tree',
    ]) {
      const res = await call(r, 'GET', path);
      expect(res.status, path).toBe(200);
    }
    expect(gh.repos.every((repo) => repo.owner === 'other' && repo.repo === 'tools')).toBe(true);
    expect(gh.repos.length).toBeGreaterThan(0);
  });

  /*
   * R-W6.5 — the refusal, stated as the requirement states it: a request naming no
   * repository, ON A ROUTE THAT REQUIRES ONE, is refused rather than defaulted. Each of
   * these paths is the new form with one half of the identifier missing, and the failure
   * they guard against is silent — substituting the configured repository would answer
   * 200 with somebody else's pull requests under the name of the one that was asked for.
   */
  for (const path of ['/repos', '/repos/', '/repos/acme', '/repos/acme/', '/repos/acme/pulls', '/repos//specs/pulls']) {
    it(`refuses ${path} rather than substituting the configured repository`, async () => {
      const gh = repoAdapter();
      const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', path);
      expect(res.status).toBe(404);
      // Nothing was asked of GitHub, so nothing could have been answered about the
      // wrong repository — the refusal is before the network, not after it.
      expect(gh.repos).toEqual([]);
    });
  }

  /*
   * The converse of R-W3.8, at the routing layer: the scoped form reaches the review
   * family and nothing else. A scoped document route would be a repository-named request
   * for an operation that commits, which is exactly what R-W3.4 is about — so it is not
   * reachable rather than being reachable and refused.
   */
  it('refuses a repository-scoped path whose tail is not a review of a pull request', async () => {
    for (const path of ['/repos/acme/specs', '/repos/acme/specs/', '/repos/acme/specs/doc-1', '/repos/acme/specs/start']) {
      const res = await call(router(), 'GET', path);
      expect(res.status, path).toBe(404);
    }
  });
});

/* ================================================================== *
 * R-W3.3 / R-W3.4 / R-W3.8 — availability and authorization follow the
 * repository the request named
 * ================================================================== */
describe('R-W3.3 — availability and authorization are determined against the requested repository', () => {
  /*
   * THIS IS THE STORY THAT LOOKS FINISHED WHILE BEING WRONG. The authorizer caches
   * effective permission per `owner/repo` and derives its author-only verdicts from that
   * cache. Handing it the CONFIGURED repository while the route went on to read another is
   * how a write grant on one repository becomes an author-level decision about a second —
   * harmless while every review route is any-role, and privilege confusion the moment one
   * is not. The failure is invisible from the response, so the assertion has to be on what
   * the authorizer was told.
   */
  it('hands the authorizer the repository the request named', async () => {
    const seen: { owner: string; repo: string }[] = [];
    const authorize: CollabAuthorizer = (_op, ctx) => {
      seen.push({ owner: ctx.repo.owner, repo: ctx.repo.repo });
      return { ok: true };
    };
    await call(router({ authorize }), 'GET', '/repos/other/tools/pulls/42/files');
    expect(seen).toEqual([OTHER]);
  });

  it('hands the authorizer the configured repository on the legacy form', async () => {
    const seen: { owner: string; repo: string }[] = [];
    const authorize: CollabAuthorizer = (_op, ctx) => {
      seen.push({ owner: ctx.repo.owner, repo: ctx.repo.repo });
      return { ok: true };
    };
    await call(router({ authorize }), 'GET', '/pulls/42/files');
    expect(seen).toEqual([{ owner: 'acme', repo: 'specs' }]);
  });

  /*
   * The availability cache is keyed by `owner/repo#base` plus the credential fingerprint,
   * so keying per requested repository comes free — but it was unreachable before, because
   * only one repository could ever get in. These two assert both halves: a second
   * repository is preflighted on its own rather than reading the first one's entry, and a
   * repeat of the same repository still costs nothing.
   */
  it('preflights each requested repository separately rather than reusing the configured answer', async () => {
    const asked: string[] = [];
    const preflight = async (repo: { owner: string; repo: string }): Promise<CollaborationPreflight> => {
      asked.push(`${repo.owner}/${repo.repo}`);
      return { ...OK_PREFLIGHT, repo: { ...repo, baseBranch: 'main' } };
    };
    const r = router({ preflight });
    await call(r, 'GET', '/pulls');
    await call(r, 'GET', '/repos/other/tools/pulls');
    expect(asked).toEqual(['acme/specs', 'other/tools']);
  });

  it('reuses one requested repository’s availability across its own reads and no other’s', async () => {
    const asked: string[] = [];
    const preflight = async (repo: { owner: string; repo: string }): Promise<CollaborationPreflight> => {
      asked.push(`${repo.owner}/${repo.repo}`);
      return { ...OK_PREFLIGHT, repo: { ...repo, baseBranch: 'main' } };
    };
    const r = router({ preflight });
    await call(r, 'GET', '/repos/other/tools/pulls');
    await call(r, 'GET', '/repos/other/tools/pulls/42/files');
    await call(r, 'GET', '/repos/third/thing/pulls');
    expect(asked).toEqual(['other/tools', 'third/thing']);
  });

  it('reports a requested repository whose preflight fails against that repository, not the configured one', async () => {
    const preflight = async (repo: { owner: string; repo: string }): Promise<CollaborationPreflight> =>
      repo.repo === 'tools'
        ? { available: false, reason: 'missing_scope', message: 'no repo scope', missingScopes: ['repo'] }
        : OK_PREFLIGHT;
    const r = router({ preflight });
    expect((await call(r, 'GET', '/repos/other/tools/pulls')).status).toBe(503);
    // The configured repository is unaffected: a second repository being unavailable is
    // not this server becoming unavailable (R-W4.4).
    expect((await call(r, 'GET', '/pulls')).status).toBe(200);
  });
});

describe('R-W3.8 — reviewing a pull request of any repository is a read', () => {
  it('asks for nothing stronger than `read`, `comment` or `reply` on a named repository', async () => {
    const seen: string[] = [];
    const authorize: CollabAuthorizer = (op) => {
      seen.push(op);
      return { ok: true };
    };
    const r = router({ authorize });
    for (const path of [
      '/repos/other/tools/pulls',
      '/repos/other/tools/pulls/42/description',
      '/repos/other/tools/pulls/42/files',
      '/repos/other/tools/pulls/42/comments',
      '/repos/other/tools/pulls/42/tree',
      '/repos/other/tools/pulls/42/raw',
      '/repos/other/tools/pulls/42/drafts',
    ]) {
      await call(r, 'GET', path);
    }
    expect(new Set(seen)).toEqual(new Set(['read']));
  });

  /*
   * R-W3.4, made structural. Nothing today reaches this branch — the scoped form only
   * dispatches the review family, and every route in it is `read`, `comment` or `reply` —
   * which is exactly why it is asserted through `gate` directly rather than through a
   * route. The day somebody adds a repo-scoped route for an operation that commits, this
   * is what refuses it instead of letting the configured repository's write grant answer
   * for a repository the credential can only read.
   */
  it('refuses an operation that commits on a repository named by the request', async () => {
    const authorize: CollabAuthorizer = () => ({ ok: true });
    const r = createCollabRoutes({
      jobs: createJobHubRegistry(),
      config: () => ENABLED,
      documents: () => {
        throw new Error('unused');
      },
      preflight: async () => OK_PREFLIGHT,
      authorize,
      baseDir: () => '/tmp/does-not-matter',
      git: noGit,
      repoAdapter: () => repoAdapter().adapter,
    });
    // `/publish` is a document route, so the scoped form does not dispatch it at all —
    // the refusal is a 404 rather than a 403, which is the stronger of the two answers.
    const res = await call(r, 'POST', '/repos/other/tools/doc-1/publish', {}, { markdown: '# x' });
    expect(res.status).toBe(404);
  });

  /*
   * The second line, behind the routing. Unreachable code cannot be driven through a
   * route, and a guard nobody can see is a guard somebody deletes — so the closed set and
   * the refusal that reads it are asserted where they live. This is the same argument the
   * `/pulls`-family ordering test makes in `collab.pulls.test.ts`, for the same kind of
   * failure: silent, and only visible in the source until the day it is not.
   */
  it('keeps the permitted-operation set closed and consulted, in the source', () => {
    const text = src('core/vite/routes/collab.ts');
    const declared = /const REVIEW_OPERATIONS: ReadonlySet<CollabOperation> = new Set<CollabOperation>\(\[([^\]]*)\]\)/.exec(text);
    expect(declared, 'REVIEW_OPERATIONS is declared as a closed set').not.toBeNull();
    expect(declared?.[1]).toBe("'read', 'comment', 'reply'");
    expect(text).toContain('if (requested && !REVIEW_OPERATIONS.has(op))');
  });

  it('never asks whether the credential can write to a repository it is only reviewing', async () => {
    let probed = 0;
    const authorize: CollabAuthorizer = () => ({ ok: true });
    authorize.writeAccess = async () => {
      probed += 1;
      return { write: true };
    };
    const r = router({ authorize });
    await call(r, 'GET', '/repos/other/tools/pulls');
    await call(r, 'GET', '/repos/other/tools/pulls/42/files');
    expect(probed).toBe(0);
  });
});

/* ================================================================== *
 * R-W3.7 / R-W6.6 — decode first, validate second, normalise never
 * ================================================================== */
describe('R-W3.7 — a repository identifier is decoded before it is validated', () => {
  /*
   * R-W6.6 is this table. Path segments are matched `[^/]+`, so `..` cannot arrive as its
   * own segment through a host that normalises — but `%2e%2e` can, and it is the same two
   * bytes the moment anything decodes it. Neither host decodes: `new URL(...).pathname`
   * keeps percent-escapes, so the decode is genuinely this layer's to do, and doing it
   * AFTER the check would leave the check answering a question about the wire format
   * rather than about the identifier.
   *
   * Every one of these is REFUSED. None is repaired: stripping a `..` or collapsing a
   * separator turns a hostile identifier into a plausible one, and the repository it then
   * names is one nobody asked for.
   */
  for (const [what, path] of [
    ['encoded traversal in the owner', '/repos/%2e%2e/specs/pulls'],
    ['encoded traversal in the repository', '/repos/acme/%2e%2e/pulls'],
    ['bare traversal in the owner', '/repos/../specs/pulls'],
    ['bare traversal in the repository', '/repos/acme/../pulls'],
    ['a bare dot for a repository', '/repos/acme/./pulls'],
    ['an encoded separator', '/repos/acme/spe%2Fcs/pulls'],
    ['an encoded NUL', '/repos/acme/specs%00/pulls'],
    ['a space', '/repos/acme/spe%20cs/pulls'],
    ['a malformed percent-escape', '/repos/acme/spe%zzcs/pulls'],
    ['an owner GitHub could not have issued', '/repos/-acme/specs/pulls'],
  ] as const) {
    it(`refuses ${what}`, async () => {
      const gh = repoAdapter();
      const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', path);
      expect(res.status, path).toBe(400);
      expect(res.json).toMatchObject({ error: expect.stringContaining('invalid repository') });
      // The decisive half: nothing was substituted and nothing was asked of GitHub, so
      // no repository at all was reviewed on the strength of a refused identifier.
      expect(gh.repos, path).toEqual([]);
    });
  }

  it('refuses before consulting availability, so a malformed identifier needs no credential', async () => {
    const r = router({
      config: () => {
        throw new Error('availability must not be consulted');
      },
    });
    const res = await call(r, 'GET', '/repos/acme/%2e%2e/pulls');
    expect(res.status).toBe(400);
  });

  it('accepts the punctuation a real repository name carries', async () => {
    const gh = repoAdapter();
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/repos/acme-co/my.spec_repo/pulls');
    expect(res.status).toBe(200);
    expect(gh.repos).toEqual([{ owner: 'acme-co', repo: 'my.spec_repo' }]);
  });

  it('decodes an identifier that is merely encoded, rather than refusing it', async () => {
    const gh = repoAdapter();
    // `.` percent-encoded is still `my.spec`, and a client that encodes conservatively is
    // not making a mistake. The decode is what makes this the same repository as above.
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/repos/acme/my%2Espec/pulls');
    expect(res.status).toBe(200);
    expect(gh.repos).toEqual([{ owner: 'acme', repo: 'my.spec' }]);
  });
});

/* ================================================================== *
 * R-W3.5 — a review is a repository AND a number
 * ================================================================== */
describe('R-W3.5 — the same pull request number in two repositories denotes two reviews', () => {
  /*
   * WHAT THIS DOES NOT COVER, AND WHY IT IS SAID HERE RATHER THAN NOWHERE. The identity of
   * a review — the source held per open review, and every read that goes through it — is
   * repository plus number, and that is what these two assert. The CHECKOUT a review may
   * be supplied from is not: `worktree.ts` mounts at `<servedDir>/.visual-spec/worktrees/
   * pr-<n>`, keyed by the number alone, so two repositories' #42 supplied from checkouts
   * would contend for one directory. `mountPullRequest` is handed `expectedHeadSha` and
   * refuses a checkout that landed on another commit, so the outcome is a `head-mismatch`
   * refusal rather than one repository's bytes served under the other's name — wrong, but
   * loudly wrong. Fixing it means renaming the worktree directory, which is `worktree.ts`,
   * which this unit does not touch. These tests therefore drive the host source, where
   * there is no directory to contend for.
   */
  /**
   * An adapter whose answers differ per repository, so a review that resolved the wrong
   * one is visible in the bytes rather than only in a call log. Pull request 42 exists in
   * both, which is the whole point — it exists in most repositories.
   */
  function twoRepos() {
    const reads: string[] = [];
    const shaOf = (repo: RepoRef) => (repo.repo === 'one' ? '1'.repeat(40) : '2'.repeat(40));
    const adapter = {
      async getPullRequest(repo: RepoRef, pullNumber: number) {
        return {
          number: pullNumber,
          headSha: shaOf(repo),
          baseBranch: 'main',
          headBranch: 'patch-1',
          state: 'open',
          htmlUrl: `https://github.com/${repo.owner}/${repo.repo}/pull/${pullNumber}`,
          body: '',
          merged: false,
          mergeable: true,
          mergeableState: 'clean',
        };
      },
      async getFile(repo: RepoRef, path: string, ref?: string) {
        reads.push(`${repo.owner}/${repo.repo}:${path}@${ref ?? ''}`);
        return { path, content: `# ${repo.repo}\n`, sha: 'c'.repeat(40) };
      },
      async listFiles(repo: RepoRef, path: string, ref?: string) {
        reads.push(`${repo.owner}/${repo.repo}:${path}/@${ref ?? ''}`);
        return [];
      },
      async compareCommits() {
        return { mergeBaseSha: 'b'.repeat(40), aheadBy: 1, behindBy: 0, files: ['docs/spec.md'] };
      },
    } as unknown as GitHubAdapter;
    return { adapter, reads, shaOf };
  }

  it('holds two sources, one per repository, for the same number', async () => {
    const gh = twoRepos();
    const r = router({ repoAdapter: () => gh.adapter });

    const one = await r.handle({ method: 'POST', pathname: '/repos/acme/one/pulls/42/mount', query: {}, body: {} });
    const two = await r.handle({ method: 'POST', pathname: '/repos/acme/two/pulls/42/mount', query: {}, body: {} });
    expect(one.json).toMatchObject({ headSha: '1'.repeat(40) });
    expect(two.json).toMatchObject({ headSha: '2'.repeat(40) });

    // The decisive half: the second open did not replace the first. Reading each review
    // afterwards still lands on its own repository at its own pinned commit — which it
    // could not, if one number meant one review.
    await call(r, 'GET', '/repos/acme/one/pulls/42/raw', { path: 'docs/spec.md' });
    await call(r, 'GET', '/repos/acme/two/pulls/42/raw', { path: 'docs/spec.md' });
    expect(gh.reads).toEqual([
      `acme/one:docs/spec.md@${'1'.repeat(40)}`,
      `acme/two:docs/spec.md@${'2'.repeat(40)}`,
    ]);
  });

  it('treats the configured repository named in the path as the same review as the legacy form', async () => {
    const gh = twoRepos();
    const r = router({ repoAdapter: () => gh.adapter });
    // Opened through the legacy form, read through the scoped form naming the same
    // repository. One review, not two — which is what lets a pasted URL for the
    // configured repository (story 4.1) join a review already open rather than re-pin it.
    await r.handle({ method: 'POST', pathname: '/pulls/42/mount', query: {}, body: {} });
    const res = await call(r, 'GET', '/repos/acme/specs/pulls/42/raw', { path: 'docs/spec.md' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ headSha: '2'.repeat(40) });
  });
});

describe('R-W3.2 — the route form that predates this requirement applies the configured repository', () => {
  it('resolves the configured repository for the legacy listing', async () => {
    const gh = repoAdapter();
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls');
    expect(res.status).toBe(200);
    expect(gh.repos).toEqual([{ owner: 'acme', repo: 'specs' }]);
  });

  it('resolves the configured repository for a legacy review of a pull request', async () => {
    const gh = repoAdapter();
    const res = await call(router({ repoAdapter: () => gh.adapter }), 'GET', '/pulls/42/files');
    expect(res.status).toBe(200);
    expect(gh.repos.every((repo) => repo.owner === 'acme' && repo.repo === 'specs')).toBe(true);
  });
});
