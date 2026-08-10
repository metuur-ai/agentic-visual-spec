/**
 * worktree.ts — mounting a Pull Request's tree on disk, read-only, next to the
 * documents the user already browses.
 *
 * WHY A WORKTREE AND NOT MORE API CALLS. The rest of this package reads GitHub
 * through `gh api` one path at a time (`getFile`, `listFiles`). That is the right
 * shape for *one document under review* and the wrong shape for *a Pull Request*: a
 * reviewer wants the whole changed tree, wants to open files the PR did not touch to
 * understand the ones it did, and wants that without N round trips. `git worktree`
 * gives the entire tree at one commit for one fetch, and costs no working-copy switch
 * on the directory the user is currently serving — which is the whole point, because
 * that directory may hold unsaved local edits and a `git checkout` would disturb them.
 *
 * WHERE IT LIVES. `<baseDir>/.visual-spec/worktrees/<owner>/<repo>/pr-<n>`. Inside the
 * repository, because the state belongs to this project and travels with it, and because
 * the user asked for it there. That makes `.gitignore` load-bearing rather than cosmetic:
 * a worktree inside the working tree that git can see is thousands of untracked files
 * in `git status`. `ensureIgnored` is therefore called before the worktree is created,
 * never after.
 *
 * WHY THE REPOSITORY IS IN THAT PATH (R-W3.5). It was `pr-<n>` until this server could
 * review a pull request of any repository the credential can read, and pull request 42
 * exists in most repositories: keyed by the number alone, two repositories' #42 contend
 * for one directory. It was never silent — `expectedHeadSha` catches a checkout that
 * landed on another commit, so the second one was refused loudly — but refused is still
 * "cannot review it". The address of a checkout is the address of a review: repository
 * *and* number, the same shape `review-drafts.ts` gives held comments (R-W3.6).
 *
 * REFS, AND WHY `pull/<n>/head`. Fetching the PR's *branch* by name only works when
 * the PR comes from the same repository. `refs/pull/<n>/head` is served by GitHub for
 * fork PRs too, so it is the one refspec that covers every PR the list can show. It
 * is fetched into `refs/visual-spec/pr/<n>` — a private namespace, so nothing here can
 * collide with the user's own branches or with `refs/remotes/origin/*`.
 *
 * READ-ONLY IS A UI CONTRACT, NOT A FILESYSTEM ONE. The checkout is detached at the
 * PR head, which means a stray write cannot land on a branch by accident, and no
 * function in this module commits, pushes or writes to a repository other than by
 * creating and removing the worktree itself. Nothing chmods the tree: making it
 * genuinely unwritable would break the reviewer's own tooling (editors, language
 * servers) for no gain the detached HEAD does not already provide.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultExecGit, type GitExecutor, parseRemoteUrl } from '../git-context';
import type { RepoRef } from './github-adapter';

/** Where PR worktrees are mounted, relative to the served directory. */
export const WORKTREE_DIR = '.visual-spec/worktrees';

/** The `.gitignore` entry that keeps every worktree — and the collab sidecars — out of git. */
export const IGNORE_ENTRY = '.visual-spec/';

/** The private ref namespace PR heads are fetched into. */
const PR_REF_PREFIX = 'refs/visual-spec/pr';

/**
 * Why a mount did not happen. Each value is a distinct thing the user must do, which
 * is why they are not collapsed into one `'failed'`:
 * - `not-a-repo`    — the served directory is not a git working tree.
 * - `no-origin`     — nothing to fetch from.
 * - `fetch-failed`  — the PR ref could not be fetched (offline, private repo, no auth).
 * - `worktree-failed` — git refused to create the checkout.
 * - `head-mismatch`  — the checkout landed on a commit that is not the pull request's
 *                      head. See `mountPullRequest`.
 */
export type WorktreeFailure =
  | 'not-a-repo'
  | 'no-origin'
  | 'fetch-failed'
  | 'worktree-failed'
  | 'head-mismatch';

export type MountedWorktree = {
  pullNumber: number;
  /**
   * The repository the checkout is of (R-W3.5). Part of the answer and not decoration: a
   * number alone does not say which review a mount belongs to, and the listing is read by
   * a surface that has to decide "is the pull request in front of me checked out?".
   */
  repo: RepoRef;
  /** Absolute path of the checkout. */
  path: string;
  /** The commit the worktree is detached at. */
  headSha: string;
};

export type MountResult =
  | { ok: true; worktree: MountedWorktree }
  /**
   * `detail` is the part of the answer only this call knows — the two commits that
   * disagree, for `head-mismatch`. The route turns `reason` into the sentence that
   * says what to do; `detail` is appended so the reader can see the evidence.
   */
  | { ok: false; reason: WorktreeFailure; detail?: string };

/** What a caller knows about the pull request that `mountPullRequest` cannot read locally. */
export type MountOptions = {
  /**
   * The head commit the pull request is at, as the API just reported it.
   *
   * Checked against what the checkout actually landed on. Since the repository is a
   * parameter this can only differ when the head moved between the two reads — a
   * force-push mid-mount — but the check is not there for the race: it is the assertion
   * that the fetch resolved in the repository the rest of the surface is talking about. A
   * wrong repo is silent without it and obvious with it.
   */
  expectedHeadSha?: string;
};

/**
 * Where to fetch `refs/pull/<n>/head` from.
 *
 * `origin` whenever the configured repository is the one `origin` already points at.
 * Otherwise an explicit URL for the configured repository, on the host `origin` names so
 * an Enterprise install is not sent to github.com. Credential helpers key on the URL, so
 * an https fetch here authenticates exactly as a fetch of that repository would anywhere
 * else.
 *
 * An `origin` that will not parse — a local path, `ssh://`, a port-bearing form — stays
 * on `origin`. It cannot be shown to be the wrong repository, and redirecting a checkout
 * away from a remote that was very likely right, on a guess, would break the working case
 * to fix the broken one. The head check in `mountPullRequest` is what covers it: it needs
 * no URL parsing to notice the commit is not the pull request's.
 */
export function fetchSource(originUrl: string, repo?: { owner: string; repo: string }): string {
  if (!repo) return 'origin';
  const parsed = parseRemoteUrl(originUrl.trim());
  if (parsed === null) return 'origin';
  const same =
    parsed.owner.toLowerCase() === repo.owner.toLowerCase() &&
    parsed.repo.toLowerCase() === repo.repo.toLowerCase();
  if (same) return 'origin';
  return `https://${parsed.host}/${repo.owner}/${repo.repo}.git`;
}

/**
 * Refuse a pull number that is not one.
 *
 * `pullNumber` reaches this module from a request body and is interpolated into both a
 * filesystem path and a git refspec. No shell is ever involved — every command here
 * goes through `spawn` with an argument array — so this is not about shell injection.
 * It is about `../..`, `-` and the empty string reaching `join()` and escaping
 * `.visual-spec/worktrees/`, which an argument array does nothing to prevent.
 */
function assertPullNumber(pullNumber: number): void {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error(`invalid pullNumber: ${String(pullNumber)}`);
  }
}

/**
 * Refuse an owner or a repository name that is not one.
 *
 * The same allowlist, and the same threat model, as `assertPullNumber` directly above and
 * as `review-drafts.ts` applies to the identical two segments: no shell is ever involved,
 * and what has to be kept out of `join()` is `../..`, `-` and the empty string, which an
 * argument array does nothing to prevent. Stated here rather than imported from the drafts
 * store for the reason that one states it rather than importing this: each module's path
 * construction stays checkable in one place.
 *
 * `.` and `..` are named because both satisfy the character set, neither is a repository,
 * and they are the two spellings that mean something to a path resolver.
 */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

function assertRepoSegment(what: string, value: string): void {
  if (!REPO_SEGMENT_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid ${what}: ${value}`);
  }
}

/**
 * Relative path of the worktree for one repository's PR (R-W3.5) — the form the UI shows
 * and the API returns.
 */
export function worktreeRelPath(repo: RepoRef, pullNumber: number): string {
  assertPullNumber(pullNumber);
  assertRepoSegment('owner', repo.owner);
  assertRepoSegment('repo', repo.repo);
  return `${WORKTREE_DIR}/${repo.owner}/${repo.repo}/pr-${pullNumber}`;
}

/**
 * The private ref the PR head is fetched into — keyed by number alone, deliberately,
 * unlike the checkout directory.
 *
 * Two repositories' #42 do share this ref, and that is safe because the ref is scaffolding
 * and not the mount: `worktree add --detach` pins the checkout to the COMMIT, so it stops
 * depending on the ref the moment it exists, and a later fetch for another repository
 * moves the ref without touching any checkout. The commit stays reachable regardless — a
 * registered worktree's HEAD is a root for reachability, which is why deleting the ref on
 * unmount cannot strand another repository's mount. Both halves are asserted against real
 * git in `R-W3.5 — two repositories' pull request #42 mount side by side`.
 *
 * Scoping it as `refs/visual-spec/pr/<owner>/<repo>/<n>` is not merely unnecessary, it is
 * a bug: git refuses a ref whose path component begins with a dot, and `.github` is a
 * repository name in wide use, so it would make a real repository unmountable to fix
 * nothing. The filesystem has no such rule, which is why the directory can carry both.
 */
function prRef(pullNumber: number): string {
  assertPullNumber(pullNumber);
  return `${PR_REF_PREFIX}/${pullNumber}`;
}

/**
 * Where a checkout was mounted before a mount named its repository.
 *
 * RETIRED, NOT ADOPTED — the opposite of what `review-drafts.ts` chose for its own
 * pre-scoping file, and both halves of that difference come from what the thing IS.
 *
 * It cannot be adopted the way the drafts file was. That was a rename of a plain file. A
 * worktree is registered with git: the checkout's `.git` file and git's
 * `.git/worktrees/<name>` admin directory point at each other by absolute path, so moving
 * one behind git's back leaves a checkout git believes is somewhere else. `git worktree
 * move` exists precisely because a rename is corruption.
 *
 * And it does not need to be adopted. The drafts file had to be, because it holds the
 * `published` records that stop a comment being posted to GitHub twice and nothing can
 * reconstruct them. A checkout holds no user-authored bytes at all — it is a detached copy
 * of a commit that the next fetch produces again — which is the same fact that lets
 * `unmountPullRequest` remove one with `--force`.
 *
 * Doing nothing was the third option and is the harmful one. Nothing physically collides
 * (`pr-42` and `acme/` are siblings), but the listing now reads the repository out of the
 * path, so a pre-scoping mount would stop being reported: still registered with git, still
 * holding objects alive, still in `git worktree list`, and invisible to every surface that
 * could remove it. So it is removed, with git's own command, at the one moment its
 * identity is not a guess — a mount of that same pull number, which is the reviewer asking
 * for a fresh checkout of exactly what that directory holds a stale copy of. Another
 * number's pre-scoping mount is left alone; removing it would be acting on a checkout
 * nobody asked about.
 */
function legacyWorktreeRelPath(pullNumber: number): string {
  assertPullNumber(pullNumber);
  return `${WORKTREE_DIR}/pr-${pullNumber}`;
}

async function retireLegacyMount(baseDir: string, pullNumber: number, exec: GitExecutor): Promise<void> {
  const rel = legacyWorktreeRelPath(pullNumber);
  // Asked rather than attempted: virtually no checkout in existence has one of these, and
  // provoking a "not a working tree" failure from git on every mount forever to discover
  // that is noise. The probe is the same `rev-parse --git-dir` the mount below already
  // uses to ask whether its own directory is a worktree.
  const registered = await exec(['-C', join(baseDir, rel), 'rev-parse', '--git-dir']);
  if (registered.exitCode !== 0) return;
  // A failure here is not a failure to mount: the new checkout is at a different path and
  // does not depend on this one going away, so the reviewer gets their review either way.
  await exec(['-C', baseDir, 'worktree', 'remove', '--force', rel]);
}

/**
 * Add `.visual-spec/` to `<baseDir>/.gitignore` unless some line already ignores it.
 *
 * Idempotent by reading first, and tolerant of the file not existing. The match is on
 * the trimmed line, both with and without the trailing slash, so a user who wrote
 * `.visual-spec` by hand does not get a duplicate.
 */
export async function ensureIgnored(baseDir: string): Promise<void> {
  const path = join(baseDir, '.gitignore');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    // Anything other than "no such file" is a real problem and must not be masked.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const already = current
    .split('\n')
    .map((line) => line.trim().replace(/\/$/, ''))
    .includes('.visual-spec');
  if (already) return;
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  await writeFile(path, `${prefix}${IGNORE_ENTRY}\n`, 'utf8');
}

/**
 * Mount `repo`'s PR `pullNumber` at
 * `<baseDir>/.visual-spec/worktrees/<owner>/<repo>/pr-<n>` (R-W3.5).
 *
 * Re-mounting an already-mounted PR is not an error: the existing checkout is moved to
 * the freshly fetched head rather than removed and recreated, so a reviewer who pulls
 * again after new commits keeps the same path (any editor tab pointing into it stays
 * valid) and pays one `checkout` instead of a full re-materialisation.
 *
 * `repo` is a parameter and not an option because it is half the address of the checkout,
 * and it is also what decides where the fetch goes. Without it the fetch would follow the
 * served directory's `origin`, which is right only while the two agree — and when they do
 * not, `refs/pull/<n>/head` resolves in the wrong repository silently: the same number
 * names a different pull request, the fetch succeeds, and the reviewer gets somebody
 * else's commit whose tree has none of the files the changed-files list names. Observed
 * as an empty "No preview for this file." on every row.
 *
 * `options` is the one remaining thing the caller knows and this module cannot read off
 * the disk: what commit the pull request is at. Absent by default, which is the
 * pre-existing behaviour — believe whatever lands.
 */
export async function mountPullRequest(
  baseDir: string,
  repo: RepoRef,
  pullNumber: number,
  exec: GitExecutor = defaultExecGit,
  options: MountOptions = {},
): Promise<MountResult> {
  // Both guards first, before a single git call: their whole job is to keep a value that
  // is not a repository or not a pull number out of a path, and a check that fires after
  // the fetch has already run is a check that fired late.
  const rel = worktreeRelPath(repo, pullNumber);

  const inRepo = await exec(['-C', baseDir, 'rev-parse', '--git-dir']);
  if (inRepo.exitCode !== 0) return { ok: false, reason: 'not-a-repo' };

  // Read even when `options.repo` will override it: no origin means no host to build the
  // override URL on, and — more to the point — a directory with no remote is not a
  // checkout of anything, which is its own answer.
  const origin = await exec(['-C', baseDir, 'remote', 'get-url', 'origin']);
  if (origin.exitCode !== 0) return { ok: false, reason: 'no-origin' };

  const ref = prRef(pullNumber);
  const source = fetchSource(origin.stdout, repo);
  // `+` forces the update: a force-pushed PR head is not a fast-forward, and refusing
  // it would pin the reviewer to a commit that no longer exists on the PR.
  const fetched = await exec(['-C', baseDir, 'fetch', source, `+refs/pull/${pullNumber}/head:${ref}`]);
  if (fetched.exitCode !== 0) return { ok: false, reason: 'fetch-failed' };

  await ensureIgnored(baseDir);
  // After the fetch, so a mount that could not be made does not take the old checkout of
  // the same pull request away with it, and before the new one, so the two never coexist.
  await retireLegacyMount(baseDir, pullNumber, exec);

  const abs = join(baseDir, rel);
  const existing = await exec(['-C', abs, 'rev-parse', '--git-dir']);
  const result =
    existing.exitCode === 0
      ? // Already mounted — move it to the new head. Detached, so no branch is touched.
        await exec(['-C', abs, 'checkout', '--detach', '--force', ref])
      : await exec(['-C', baseDir, 'worktree', 'add', '--detach', '--force', rel, ref]);
  if (result.exitCode !== 0) return { ok: false, reason: 'worktree-failed' };

  const head = await exec(['-C', abs, 'rev-parse', 'HEAD']);
  // Ask git for the path rather than reporting `join(baseDir, rel)`. On macOS a
  // `baseDir` of `/tmp/x` is really `/private/tmp/x`, and git reports the resolved
  // form in `worktree list`. Returning the unresolved one here would give the same
  // worktree two spellings across this module's own functions, so any caller
  // comparing "is this PR mounted?" by path would answer no. Caught against a real
  // repository under `/tmp`; a fixture would never have shown it.
  const canonical = await exec(['-C', abs, 'rev-parse', '--show-toplevel']);
  const path = canonical.exitCode === 0 ? canonical.stdout.trim() : abs;
  const headSha = head.stdout.trim();

  /*
   * The checkout must be the commit the pull request is at, or it is not that pull
   * request. Reported rather than silently served: the failure this catches — the ref
   * resolving in the wrong repository — produces a checkout that looks perfectly healthy
   * and simply has the wrong files in it, which reads to the user as the product being
   * broken. Two shas beats an empty pane.
   */
  const { expectedHeadSha } = options;
  if (expectedHeadSha !== undefined && expectedHeadSha !== '' && headSha !== expectedHeadSha) {
    return {
      ok: false,
      reason: 'head-mismatch',
      detail: `the checkout is at ${headSha.slice(0, 7)}, the pull request is at ${expectedHeadSha.slice(0, 7)}`,
    };
  }

  return {
    ok: true,
    worktree: { pullNumber, repo, path, headSha },
  };
}

/**
 * Every PR worktree currently mounted under `baseDir`, by parsing
 * `git worktree list --porcelain`.
 *
 * Reads git's own registry rather than the directory listing, so a worktree deleted
 * with `rm -rf` (leaving the folder gone but the registration behind) is not reported
 * as available. Entries outside `WORKTREE_DIR`, and the main worktree itself, are
 * skipped — this module only claims the ones it created.
 *
 * The repository is parsed back out of the path (R-W3.5) rather than looked up anywhere:
 * `worktreeRelPath` put it there, git reports the path, and there is no second place that
 * could disagree with the directory a checkout actually sits in. A pre-scoping `pr-<n>`
 * mount has no repository in its path and so cannot be reported here at all — see
 * `legacyWorktreeRelPath` for why that is answered by removing it rather than by widening
 * this parser.
 */
export async function listMountedWorktrees(
  baseDir: string,
  exec: GitExecutor = defaultExecGit,
): Promise<MountedWorktree[]> {
  const listed = await exec(['-C', baseDir, 'worktree', 'list', '--porcelain']);
  if (listed.exitCode !== 0) return [];

  const out: MountedWorktree[] = [];
  let path = '';
  let headSha = '';
  const flush = (): void => {
    const match = /\/(?:\.visual-spec\/worktrees)\/([^/]+)\/([^/]+)\/pr-(\d+)$/.exec(path);
    if (match) {
      out.push({ pullNumber: Number(match[3]), repo: { owner: match[1]!, repo: match[2]! }, path, headSha });
    }
    path = '';
    headSha = '';
  };
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (path !== '') flush();
      path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      headSha = line.slice('HEAD '.length).trim();
    }
  }
  if (path !== '') flush();
  // Ordered the way the path is: repository, then number. Sorting by number alone would
  // interleave two repositories' mounts, which reads as one list of pull requests.
  return out.sort(
    (a, b) =>
      a.repo.owner.localeCompare(b.repo.owner) ||
      a.repo.repo.localeCompare(b.repo.repo) ||
      a.pullNumber - b.pullNumber,
  );
}

/**
 * Remove `repo`'s PR `pullNumber` worktree and its private ref.
 *
 * `--force` because the checkout is meant to be read-only: if something did modify it,
 * that edit was not asked for and is not what the reviewer wants preserved. Resolves
 * `false` when nothing was mounted, so "already gone" is a normal outcome, not a throw.
 *
 * `repo` for the same reason `mountPullRequest` takes it: the number alone names a
 * directory in every repository at once, and removing the wrong one would take away a
 * review the reviewer is in the middle of.
 */
export async function unmountPullRequest(
  baseDir: string,
  repo: RepoRef,
  pullNumber: number,
  exec: GitExecutor = defaultExecGit,
): Promise<boolean> {
  const removed = await exec(['-C', baseDir, 'worktree', 'remove', '--force', worktreeRelPath(repo, pullNumber)]);
  // The ref goes regardless: leaving it behind pins the PR's objects forever. Shared with
  // any other repository's mount of the same number, and safe to delete anyway — see
  // `prRef`: a mounted checkout keeps its own commit reachable.
  await exec(['-C', baseDir, 'update-ref', '-d', prRef(pullNumber)]);
  return removed.exitCode === 0;
}
