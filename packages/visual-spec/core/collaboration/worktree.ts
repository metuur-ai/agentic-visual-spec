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
 * WHERE IT LIVES. `<baseDir>/.visual-spec/worktrees/pr-<n>`. Inside the repository,
 * because the state belongs to this project and travels with it, and because the user
 * asked for it there. That makes `.gitignore` load-bearing rather than cosmetic: a
 * worktree inside the working tree that git can see is thousands of untracked files
 * in `git status`. `ensureIgnored` is therefore called before the worktree is created,
 * never after.
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
import { defaultExecGit, type GitExecutor } from '../git-context';

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
 */
export type WorktreeFailure = 'not-a-repo' | 'no-origin' | 'fetch-failed' | 'worktree-failed';

export type MountedWorktree = {
  pullNumber: number;
  /** Absolute path of the checkout. */
  path: string;
  /** The commit the worktree is detached at. */
  headSha: string;
};

export type MountResult =
  | { ok: true; worktree: MountedWorktree }
  | { ok: false; reason: WorktreeFailure };

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

/** Relative path of the worktree for a PR — the form the UI shows and the API returns. */
export function worktreeRelPath(pullNumber: number): string {
  assertPullNumber(pullNumber);
  return `${WORKTREE_DIR}/pr-${pullNumber}`;
}

function prRef(pullNumber: number): string {
  assertPullNumber(pullNumber);
  return `${PR_REF_PREFIX}/${pullNumber}`;
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
 * Mount PR `pullNumber` at `<baseDir>/.visual-spec/worktrees/pr-<n>`.
 *
 * Re-mounting an already-mounted PR is not an error: the existing checkout is moved to
 * the freshly fetched head rather than removed and recreated, so a reviewer who pulls
 * again after new commits keeps the same path (any editor tab pointing into it stays
 * valid) and pays one `checkout` instead of a full re-materialisation.
 */
export async function mountPullRequest(
  baseDir: string,
  pullNumber: number,
  exec: GitExecutor = defaultExecGit,
): Promise<MountResult> {
  const inRepo = await exec(['-C', baseDir, 'rev-parse', '--git-dir']);
  if (inRepo.exitCode !== 0) return { ok: false, reason: 'not-a-repo' };

  const origin = await exec(['-C', baseDir, 'remote', 'get-url', 'origin']);
  if (origin.exitCode !== 0) return { ok: false, reason: 'no-origin' };

  const ref = prRef(pullNumber);
  // `+` forces the update: a force-pushed PR head is not a fast-forward, and refusing
  // it would pin the reviewer to a commit that no longer exists on the PR.
  const fetched = await exec(['-C', baseDir, 'fetch', 'origin', `+refs/pull/${pullNumber}/head:${ref}`]);
  if (fetched.exitCode !== 0) return { ok: false, reason: 'fetch-failed' };

  await ensureIgnored(baseDir);

  const rel = worktreeRelPath(pullNumber);
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
  return {
    ok: true,
    worktree: { pullNumber, path, headSha: head.stdout.trim() },
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
    const match = /\/(?:\.visual-spec\/worktrees)\/pr-(\d+)$/.exec(path);
    if (match?.[1]) out.push({ pullNumber: Number(match[1]), path, headSha });
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
  return out.sort((a, b) => a.pullNumber - b.pullNumber);
}

/**
 * Remove PR `pullNumber`'s worktree and its private ref.
 *
 * `--force` because the checkout is meant to be read-only: if something did modify it,
 * that edit was not asked for and is not what the reviewer wants preserved. Resolves
 * `false` when nothing was mounted, so "already gone" is a normal outcome, not a throw.
 */
export async function unmountPullRequest(
  baseDir: string,
  pullNumber: number,
  exec: GitExecutor = defaultExecGit,
): Promise<boolean> {
  const removed = await exec(['-C', baseDir, 'worktree', 'remove', '--force', worktreeRelPath(pullNumber)]);
  // The ref goes regardless: leaving it behind pins the PR's objects forever.
  await exec(['-C', baseDir, 'update-ref', '-d', prRef(pullNumber)]);
  return removed.exitCode === 0;
}
