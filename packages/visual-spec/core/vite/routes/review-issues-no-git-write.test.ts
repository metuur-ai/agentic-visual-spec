/**
 * review-issues-no-git-write.test.ts — R-W5.5: a review commits nothing, pushes nothing,
 * creates no branch and merges nothing.
 *
 * WHY THIS ASSERTS OVER ARGV AND NOT OVER AN OUTCOME. The behavioural proxy for this
 * requirement is "the served directory's branch and working copy are unchanged after a
 * review", and that is a genuinely weaker claim: a `git commit` on a detached HEAD leaves
 * the branch exactly where it was, a `git push` leaves the working copy pristine, and a
 * `git branch vs/pr-7` leaves both untouched. Every one of those is the requirement
 * broken, and every one of them passes an outcome check. So the assertion is made where
 * the prohibition actually lives: the `GitExecutor` seam every git call in this package
 * goes through is injected, and this file reads the whole argv of every invocation a full
 * review made.
 *
 * WHAT IS DELIBERATELY ALLOWED, AND WHY IT IS NOT A LOOPHOLE. The checkout path fetches
 * the pull request head into `refs/visual-spec/pr/<n>`, mounts it with
 * `worktree add --detach`, re-points an existing mount with `checkout --detach`, and
 * deletes its own ref with `update-ref -d` on the way out. None of those can land work on
 * a branch — which is the actual shape of the requirement — so rather than banning the
 * verbs, the rules below ban the dangerous *form* of each: a `checkout` or a
 * `worktree add` without `--detach`, and any refspec that writes under `refs/heads/`.
 * That is what keeps this test from passing merely because nobody has written
 * `git commit` yet: `git fetch origin +refs/pull/7/head:refs/heads/pr-7` is the change
 * that would sneak past a subcommand blacklist, and it fails here.
 *
 * BOTH SOURCES. A host-supplied review has no checkout at all, so its budget is smaller
 * still — the two read-only probes `readGitContext` makes and nothing else — and that is
 * asserted separately rather than folded in, because "no writes" and "no git" are
 * different claims and only one of them is true of the checkout path.
 *
 * No network, no `gh` and no real `git`: both executors are injected (R-4.8 / R-12.3).
 * The one thing that touches the filesystem is the mount path's `ensureIgnored` and the
 * held comment, so `baseDir` is a real temporary directory.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { GitHubAdapter } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { GitExecutor } from '../../git-context';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabDeps, type CollabRouteResult, createCollabRoutes } from './collab';

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO }, git: { allowCheckout: false } };
const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });
const HEAD = 'a'.repeat(40);

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

/* ------------------------------------------------------------------ *
 * The prohibition, expressed over one argv
 * ------------------------------------------------------------------ */

/**
 * Verbs that write history or a branch. There is no form of any of these a review has a
 * use for, so unlike `checkout` and `worktree` they are refused outright.
 *
 * `switch`, `stash`, `rebase`, `cherry-pick`, `am` and `revert` are here alongside
 * R-W5.5's own four because the requirement is about the outcome — work landing on a
 * branch — and each of them reaches it by a different verb. A list of exactly the four
 * words the sentence happens to use would be a list of the four ways somebody already
 * thought of.
 */
const FORBIDDEN_SUBCOMMANDS = [
  'commit',
  'push',
  'branch',
  'merge',
  'rebase',
  'cherry-pick',
  'am',
  'revert',
  'switch',
  'stash',
  'tag',
];

/** The git subcommand in an argv, skipping the `-C <dir>` prefix this package always passes. */
function subcommandOf(args: string[]): string {
  return args[0] === '-C' ? (args[2] ?? '') : (args[0] ?? '');
}

/** Human-readable, so a failure names the command rather than an index. */
const show = (args: string[]) => `git ${args.join(' ')}`;

/**
 * Every reason `args` is a write, or `[]`. Returned as a list rather than a boolean so a
 * single argv that breaks two rules reports both.
 */
function writeOffences(args: string[]): string[] {
  const sub = subcommandOf(args);
  const out: string[] = [];
  if (FORBIDDEN_SUBCOMMANDS.includes(sub)) out.push(`${show(args)} — \`${sub}\` is forbidden during a review`);
  // `checkout --detach` moves nothing but HEAD, and is how a re-open re-points an existing
  // mount. `checkout <branch>` is the one the requirement names.
  if (sub === 'checkout' && !args.includes('--detach')) out.push(`${show(args)} — a checkout without --detach moves a branch`);
  if (sub === 'worktree' && args.includes('add') && !args.includes('--detach')) {
    out.push(`${show(args)} — a worktree add without --detach creates a branch`);
  }
  // The refspec form: anything landing under `refs/heads/` is a branch write however it
  // is spelled, and `fetch`/`update-ref` are the two verbs that can spell it.
  for (const arg of args) {
    if (arg.includes('refs/heads/')) out.push(`${show(args)} — writes under refs/heads/`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

/** The repo-level adapter a review reads through. Answers, records nothing. */
function adapter(): GitHubAdapter {
  return {
    async listPullRequests() {
      return [];
    },
    async getPullRequest(_repo: unknown, pullNumber: number) {
      return {
        number: pullNumber,
        headSha: HEAD,
        baseBranch: 'main',
        headBranch: 'patch-1',
        state: 'open',
        htmlUrl: 'https://github.com/acme/specs/pull/7',
        body: 'a description',
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
      };
    },
    async compareCommits() {
      return { mergeBaseSha: 'b'.repeat(40), aheadBy: 1, behindBy: 0, files: ['docs/spec.md'] };
    },
    async listReviewComments() {
      return [];
    },
    async listThreadResolution() {
      return [];
    },
    async listFiles() {
      return [{ name: 'spec.md', path: 'docs/spec.md', type: 'file', sha: 'c'.repeat(40), size: 3 }];
    },
    async getFile(_repo: unknown, path: string) {
      return { path, content: '# from the host\n', sha: 'c'.repeat(40) };
    },
  } as unknown as GitHubAdapter;
}

/**
 * A `GitExecutor` that recites a healthy clone with the pull request mountable, and
 * records every argv it was handed.
 *
 * `isRepo` is the one knob: false makes `readGitContext` report "not a working tree",
 * which is how a host-supplied review is reached (R-W1.3).
 */
function recordingGit(opts: { isRepo: boolean }, worktreeAbs: () => string) {
  const calls: string[][] = [];
  const exec: GitExecutor = async (args) => {
    calls.push(args);
    const sub = subcommandOf(args);
    const dir = args[0] === '-C' ? args[1] : '';

    if (!opts.isRepo) {
      // Every probe fails the way it does outside a repository.
      return { stdout: '', exitCode: 128 };
    }
    if (sub === 'rev-parse' && args.includes('--abbrev-ref')) return { stdout: 'main\n', exitCode: 0 };
    if (sub === 'rev-parse' && args.includes('--short')) return { stdout: 'deadbee\n', exitCode: 0 };
    if (sub === 'remote') return { stdout: 'https://github.com/acme/specs.git\n', exitCode: 0 };
    if (sub === 'rev-parse' && args.includes('--git-dir')) {
      // No checkout of this pull request exists yet, so the mount takes the `worktree add`
      // arm rather than the `checkout --detach` one. Both are exercised: see the second
      // mount below. Answered for the whole of `.visual-spec/worktrees/` rather than for
      // one path, so the pre-scoping `pr-<n>` directory is reported absent too — nothing
      // in this fixture was mounted before the repository was part of the address.
      return dir.startsWith(join(baseDir, '.visual-spec/worktrees'))
        ? { stdout: '', exitCode: 128 }
        : { stdout: '.git\n', exitCode: 0 };
    }
    if (sub === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${worktreeAbs()}\n`, exitCode: 0 };
    if (sub === 'rev-parse') return { stdout: `${HEAD}\n`, exitCode: 0 };
    if (sub === 'worktree' && args.includes('list')) return { stdout: '', exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  };
  return { exec, calls };
}

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'vs-no-git-write-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function router(git: GitExecutor, overrides: Partial<CollabDeps> = {}) {
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents: () => {
      throw new Error('a review must not read the document store');
    },
    preflight: async () => OK_PREFLIGHT,
    authorize: ALLOW_ALL,
    baseDir: () => baseDir,
    git,
    repoAdapter: () => adapter(),
    ...overrides,
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): Promise<CollabRouteResult> => r.handle({ method, pathname, query, body });

/**
 * A whole review, start to finish: open it, read what changed, walk the tree, open a
 * file, read the conversation, hold a comment, list what is held, re-open it (the
 * force-push path, which is where the second checkout form lives), and close it.
 */
async function fullReview(r: ReturnType<typeof router>): Promise<CollabRouteResult[]> {
  const out: CollabRouteResult[] = [];
  out.push(await call(r, 'POST', '/pulls/7/mount'));
  out.push(await call(r, 'GET', '/pulls/7/files'));
  out.push(await call(r, 'GET', '/pulls/7/description'));
  out.push(await call(r, 'GET', '/pulls/7/tree', {}, { path: 'docs' }));
  out.push(await call(r, 'GET', '/pulls/7/raw', {}, { path: 'docs/spec.md' }));
  out.push(await call(r, 'GET', '/pulls/7/comments'));
  out.push(await call(r, 'GET', '/pulls/mounted'));
  out.push(await call(r, 'POST', '/pulls/7/drafts', { path: 'docs/spec.md', comment: 'this paragraph contradicts §2', headSha: HEAD, line: 4 }));
  out.push(await call(r, 'GET', '/pulls/7/drafts'));
  out.push(await call(r, 'POST', '/pulls/7/mount'));
  out.push(await call(r, 'DELETE', '/pulls/7/mount'));
  return out;
}

/* ================================================================== *
 * R-W5.5 — the checkout-supplied review
 * ================================================================== */
describe('R-W5.5 — a checkout-supplied review issues no git write', () => {
  it('never commits, pushes, branches, merges, or checks out a branch', async () => {
    const worktreeAbs = () => join(baseDir, '.visual-spec/worktrees/acme/specs/pr-7');
    const git = recordingGit({ isRepo: true }, worktreeAbs);
    const r = router(git.exec);

    const results = await fullReview(r);
    r.dispose();

    // The review must actually have happened, or "no writes" is trivially true. The open
    // resolved to the checkout, which is the path that touches git at all.
    expect(results[0]).toMatchObject({ status: 200, json: { ok: true, source: 'checkout' } });
    expect(git.calls.length).toBeGreaterThan(0);

    const offences = git.calls.flatMap(writeOffences);
    expect(offences.join('\n')).toBe('');
  });

  it('mounts detached, by both of the two arms that mount', async () => {
    // The negative control for the rule above: it passes just as happily when nothing
    // reached git. These are the two commands that legitimately move a HEAD, and both
    // must have been issued in their detached form for the assertion to mean anything.
    const worktreeAbs = () => join(baseDir, '.visual-spec/worktrees/acme/specs/pr-7');
    let mounted = false;
    const git = recordingGit({ isRepo: true }, worktreeAbs);
    const wrapped: GitExecutor = async (args) => {
      const res = await git.exec(args);
      // After the first `worktree add`, report the worktree as existing so the second
      // open takes the `checkout --detach --force` arm instead.
      if (subcommandOf(args) === 'worktree' && args.includes('add')) mounted = true;
      if (mounted && subcommandOf(args) === 'rev-parse' && args.includes('--git-dir') && args[1] === worktreeAbs()) {
        return { stdout: '.git\n', exitCode: 0 };
      }
      return res;
    };
    const r = router(wrapped);
    await fullReview(r);
    r.dispose();

    const issued = git.calls.map(show);
    expect(issued.some((c) => /worktree add .*--detach/.test(c))).toBe(true);
    expect(issued.some((c) => /\bcheckout .*--detach/.test(c))).toBe(true);
    expect(git.calls.flatMap(writeOffences).join('\n')).toBe('');
  });

  it('fetches the pull request head into its own ref namespace, never into refs/heads/', async () => {
    const worktreeAbs = () => join(baseDir, '.visual-spec/worktrees/acme/specs/pr-7');
    const git = recordingGit({ isRepo: true }, worktreeAbs);
    const r = router(git.exec);
    await fullReview(r);
    r.dispose();

    const fetches = git.calls.filter((args) => subcommandOf(args) === 'fetch');
    expect(fetches.length).toBeGreaterThan(0);
    for (const args of fetches) {
      const refspec = args.find((a) => a.includes(':'))!;
      expect(refspec, show(args)).toMatch(/:refs\/visual-spec\/pr\/7$/);
    }
  });
});

/* ================================================================== *
 * R-W5.5 — the host-supplied review
 * ================================================================== */
describe('R-W5.5 — a host-supplied review issues no git write either', () => {
  it('never fetches or checks anything out, having decided there is nothing to check out from', async () => {
    const git = recordingGit({ isRepo: false }, () => join(baseDir, '.visual-spec/worktrees/acme/specs/pr-7'));
    const r = router(git.exec);

    const results = await fullReview(r);
    r.dispose();

    // The open really did fall through to the host (R-W1.3), so the review below is the
    // one with no checkout behind it.
    expect(results[0]).toMatchObject({ status: 200, json: { ok: true, source: 'host' } });

    expect(git.calls.flatMap(writeOffences).join('\n')).toBe('');

    /*
     * Stronger than "no writes": with no working copy there is nothing to fetch INTO and
     * nothing to check out, so those two verbs must be absent entirely rather than merely
     * well-formed. Their presence would mean the resolution decided "host" and then went
     * and touched the served directory's object store anyway.
     */
    const verbs = git.calls.map(subcommandOf);
    expect(verbs).not.toContain('fetch');
    expect(verbs).not.toContain('checkout');

    /*
     * What DOES appear, and why it is not a write. `worktree list` answers
     * `GET /pulls/mounted`; `worktree remove` and `update-ref -d` are the close, which
     * runs whichever source supplied the review — a directory that is not a repository
     * simply has neither to remove, and both commands fail harmlessly. The ref deleted is
     * this package's own, never a branch, which is what the offence rules above check.
     */
    expect([...new Set(verbs)].sort()).toEqual(['rev-parse', 'update-ref', 'worktree']);
    for (const args of git.calls.filter((a) => subcommandOf(a) === 'update-ref')) {
      expect(args.join(' '), show(args)).toMatch(/-d refs\/visual-spec\/pr\/7$/);
    }
  });
});
