/**
 * review-source-resolve.ts — the one decision this whole change rests on: which of the
 * two `ReviewSource` implementations supplies a review, made once, before any file of it
 * is read (R-W1.1).
 *
 * THE RULE IS NOT "ORIGIN MATCHES". The first draft of the design said the checkout is
 * used only when the served directory's `origin` names the pull request's repository.
 * That is wrong, and shipping it would have been a regression dressed as a feature.
 * `fetchSource(originUrl, repo)` in `worktree.ts` already derives an explicit fetch URL
 * for the configured repository *on origin's host* whenever the two differ, so a reviewer
 * serving repository **A** can already mount a pull request of repository **B** today. A
 * match-only rule would have taken that working case off the checkout and put it on the
 * host — changing behaviour nobody asked to change, in a story whose entire point is to
 * add a path for the case that currently *refuses*.
 *
 * So the condition is: **is the served directory a git working tree with an origin**,
 * irrespective of which repository that origin names (R-W1.2). Only "not a git working
 * tree" and "no origin to fetch from" reach the host source (R-W1.3) — the two conditions
 * that produce a refusal today.
 *
 * WHAT THAT MEANS FOR `MOUNT_FAILURE`. `not-a-repo` and `no-origin` stop being terminal:
 * they are now the signal to build the host source instead, which is the in-place edit to
 * R-13.9 / R-13.9a. `fetch-failed`, `worktree-failed` and `head-mismatch` are unchanged
 * and still terminal — a directory that *is* a clone with an origin and still could not
 * produce a checkout has a problem the reviewer has to fix, and silently falling through
 * to the host would hide it. That asymmetry is the whole of R-W5.2 on this path.
 *
 * IT DECIDES FROM THE SERVED DIRECTORY ALONE (R-W1.6). `readGitContext` is asked about
 * one directory and nothing walks outward looking for another clone, nothing consults a
 * registry, and nothing is cloned — there is no `git clone` in this package and this
 * module does not add one. Every write a resolution can cause is `mountPullRequest`'s,
 * inside the served directory, exactly where it already was (R-W2.9).
 *
 * WHY THE HEAD IS READ HERE AND IS NOT A PARAMETER (R-W2.5). "When the head moves,
 * refresh the changed paths and the pinned commit together" is a requirement about two
 * facts never disagreeing. A `ReviewSource` is immutable and bound to one commit, so a
 * refresh is not a mutation — it is a new source. If this function took `headSha` from
 * its caller, every call site would be a chance to pin a source to a commit some earlier
 * read reported, and the changed paths (which `changedPaths()` derives from the *source's*
 * sha) would then describe a different commit from the one being displayed. Reading the
 * pull request here makes the pair atomic by construction: one `getPullRequest`, one sha,
 * one source, one changed-path list. There is no other way to obtain a source, so there
 * is no way to obtain a mismatched pair.
 *
 * `mountPullRequest` IS NOT TOUCHED. This module calls it and reads its result. It does
 * not fetch, checkout, prune or clone on its own.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 */
import { defaultExecGit, readGitContext, type GitExecutor } from '../git-context';
import type { GitHubAdapter, RepoRef } from './github-adapter';
import type { ReviewSource } from './review-source';
import { createApiReviewSource } from './review-source-api';
import { createWorktreeReviewSource } from './review-source-worktree';
import { mountPullRequest, type MountedWorktree, type WorktreeFailure } from './worktree';

/**
 * The adapter methods a resolution and the two sources between them may reach for, and no
 * more. Narrowed for the same reason both sources narrow: a fifth host call cannot appear
 * here without this type changing to admit it (R-W2.6).
 */
export type ReviewResolveAdapter = Pick<
  GitHubAdapter,
  'getPullRequest' | 'compareCommits' | 'listFiles' | 'getFile'
>;

/**
 * The two mount failures that stop being failures.
 *
 * Named as a value rather than inlined so the claim "these two are the fallback, the rest
 * are terminal" is one thing a test can read, and so adding a sixth `WorktreeFailure`
 * cannot quietly join the fallback set.
 */
const FALL_BACK_TO_HOST: ReadonlySet<WorktreeFailure> = new Set<WorktreeFailure>(['not-a-repo', 'no-origin']);

/** A mount failure that a resolution still reports as a failure — the terminal three. */
export type ReviewResolveFailure = Exclude<WorktreeFailure, 'not-a-repo' | 'no-origin'>;

/** The pull request facts a review surface needs alongside its source, read once, with it. */
export type ResolvedPull = {
  pullNumber: number;
  /** The commit the source is pinned to. The same string as `source.headSha`, always. */
  headSha: string;
  baseBranch: string;
  headBranch: string;
};

export type ReviewResolution =
  | {
      ok: true;
      /** The interface the review reads every file through (R-W1.4). */
      source: ReviewSource;
      /** Read together with the source, from the same `getPullRequest` (R-W2.5). */
      pull: ResolvedPull;
      /**
       * Present only when the checkout supplies the review, and then it is exactly what
       * `mountPullRequest` returned — the same path, from the same call, so
       * `GET /pulls/mounted` and this route cannot spell one checkout two ways (R-13.8).
       */
      worktree?: MountedWorktree;
    }
  /** A checkout was attempted, was the right answer, and could not be made. Terminal. */
  | { ok: false; reason: ReviewResolveFailure; detail?: string }
  /**
   * The pull request itself could not be read, so there is no head to pin to and neither
   * source could have been built. `error` is handed back untouched — the route already
   * knows how to turn a `GitHubError` into a status and how to rethrow anything else, and
   * re-deciding that here would give the same failure two spellings.
   */
  | { ok: false; reason: 'pull-unreadable'; error: unknown };

export type ReviewResolveInput = {
  /** The served directory — the only directory consulted (R-W1.6). */
  baseDir: string;
  /** The repository the pull request lives in. */
  repo: RepoRef;
  pullNumber: number;
  adapter: ReviewResolveAdapter;
  /** Injectable so a test never execs `git`. Defaults to the real CLI. */
  exec?: GitExecutor;
};

/**
 * Is the served directory a git working tree with an origin?
 *
 * `readGitContext` reports three states and the origin lives across two of them:
 * `remote` is an origin this package could parse into owner/repo, and `local` **carrying a
 * url** is an origin it could not — a `ssh://` form, a port, a local path. Both are an
 * origin to fetch from, and which repository either one names is deliberately not looked
 * at (R-W1.2). `local` with no url at all is R-1.6's "no origin", and `none` is "not a
 * working tree"; those two are R-W1.3's cases.
 */
function hasOriginRemote(ctx: Awaited<ReturnType<typeof readGitContext>>): boolean {
  if (ctx.state === 'remote') return true;
  return ctx.state === 'local' && ctx.url !== undefined && ctx.url !== '';
}

/**
 * Decide the source for one review and build it (R-W1.1).
 *
 * Never throws. Every outcome — including a host that would not answer which commit the
 * pull request is at — is a value, in the shape the mount route already answers in.
 */
export async function resolveReviewSource(input: ReviewResolveInput): Promise<ReviewResolution> {
  const { baseDir, repo, pullNumber, adapter } = input;
  const exec = input.exec ?? defaultExecGit;

  /*
   * The head first, because both branches need it and neither may be built without it.
   * The checkout branch also hands it to `mountPullRequest` as `expectedHeadSha`, which is
   * the check that catches a ref resolving in the wrong repository — so this read is not
   * an extra cost the resolution introduced, it is the one the mount route already made.
   */
  let detail: { headSha: string; baseBranch: string; headBranch: string };
  try {
    const pull = await adapter.getPullRequest(repo, pullNumber);
    detail = { headSha: pull.headSha, baseBranch: pull.baseBranch, headBranch: pull.headBranch };
  } catch (error) {
    return { ok: false, reason: 'pull-unreadable', error };
  }
  const pull: ResolvedPull = { pullNumber, ...detail };

  /** The host source, built from the head just read. The answer for R-W1.3's two cases. */
  const host = (): ReviewResolution => ({
    ok: true,
    source: createApiReviewSource({ adapter, repo, headSha: pull.headSha, baseRef: pull.baseBranch }),
    pull,
  });

  // R-W1.6 — one directory, asked once, before anything is fetched or read.
  const ctx = await readGitContext(baseDir, exec);
  if (!hasOriginRemote(ctx)) return host();

  const mounted = await mountPullRequest(baseDir, repo, pullNumber, exec, { expectedHeadSha: pull.headSha });
  if (!mounted.ok) {
    /*
     * The two conditions R-13.9a retired. They are reachable here even though the context
     * read just said otherwise — the directory can stop being a working tree between the
     * two calls — and treating them as the fallback rather than as an impossible state is
     * both cheaper and more honest than asserting they cannot happen.
     */
    if (FALL_BACK_TO_HOST.has(mounted.reason)) return host();
    return { ok: false, reason: mounted.reason as ReviewResolveFailure, ...(mounted.detail ? { detail: mounted.detail } : {}) };
  }

  return {
    ok: true,
    source: createWorktreeReviewSource({
      worktree: mounted.worktree,
      repo,
      baseBranch: pull.baseBranch,
      adapter,
      exec,
    }),
    pull,
    worktree: mounted.worktree,
  };
}
