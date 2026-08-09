/**
 * git-branches.ts — which branches the served directory has, and the one git write
 * this package performs: changing which of them is checked out.
 *
 * WHY THIS IS A SIBLING OF `git-context.ts` AND NOT PART OF IT. That module's header
 * states that nothing in it writes, and R-1.10 makes the statement a requirement. A
 * merge would save exactly one import and cost that guarantee, so the modules stay
 * apart and share only the `GitExecutor` seam — which means the two suites stub git
 * the same way and neither file has to invent a second one.
 *
 * WHY THE REFUSAL IS DECIDED BEFORE `checkout` RUNS (R-5.5). The obvious design is to
 * invoke `checkout` and map git's refusal. It is wrong, and not marginally:
 * `git checkout` **succeeds** whenever a modified file is identical in both commits,
 * silently carrying the uncommitted edit onto the new branch. In a repository of
 * documents that is the ordinary case, so the obvious design would move the user's
 * unsaved work while reporting success — leaving "it would have stopped me" false
 * about precisely the edits they cared about. `git status --porcelain` therefore runs
 * first, and any output at all refuses the change. Nothing here stashes, discards,
 * cleans or forces (R-5.6); a refusal is the whole answer, not a prompt for one.
 *
 * WHY THE PATHS COME FROM `--porcelain` AND NOT FROM GIT'S MESSAGE (R-5.10).
 * `core/git-context.ts` drains stderr unread on purpose — git writes absolute paths
 * into it ("dubious ownership in repository at '/…'") and R-1.11 forbids those
 * crossing the process boundary. So git's own "your local changes would be
 * overwritten" text is unavailable to this module by construction. `--porcelain`
 * puts repository-relative paths on stdout, which is the only form allowed out
 * anyway. `-z` is added because the quoted form `--porcelain` otherwise produces for
 * a path with a space would name a file that does not exist.
 *
 * WHY THE TARGET IS VALIDATED AGAINST THE LISTING (R-5.7). Every command here goes
 * through `spawn` with an argument array, so no shell is involved and this is not
 * about shell metacharacters. It is about `git checkout -` (the previous branch,
 * which is not the branch the user picked) and `git checkout --upload-pack=…`
 * (an option, not a ref) reaching git as the first positional argument. The branch
 * name arrives from a request body; only a name git itself just reported is used.
 *
 * `core/` is Node-reachable from the CLI, so this module imports node builtins and
 * sibling core modules only.
 */
import { defaultExecGit, type GitContext, type GitExecutor, type GitResult, readGitContext } from './git-context';
import { ensureIgnored } from './collaboration/worktree';

/** A local branch as the chip's switcher needs it. */
export type LocalBranch = {
  name: string;
  /** True for the branch `HEAD` points at. Every entry is false on a detached HEAD. */
  current: boolean;
  /**
   * Commits ahead of, and behind, this branch's upstream — **absent** where no
   * upstream is configured, or where the configured one is gone. Absent is a
   * different claim from `0`, which says "level with an upstream that exists", and
   * collapsing the two is how a switcher ends up reporting a branch as in sync with
   * something it has never been compared against.
   */
  ahead?: number;
  behind?: number;
};

export type BranchListing = {
  local: LocalBranch[];
  /** Branches of `origin`, with the remote prefix removed. `origin/HEAD` is excluded. */
  remote: string[];
};

/**
 * Why an operation could not be attempted at all.
 *
 * Deliberately two values and not four. `exitCode: null` is unambiguous — git could
 * not be started. Everything else is a non-zero exit whose reason lives on stderr,
 * and this module does not read stderr (R-5.10), so "not a repository", "dubious
 * ownership" and "corrupt object database" are genuinely indistinguishable here.
 * Naming them separately would be inventing a distinction the code cannot make.
 */
export type GitFailure = 'git-unavailable' | 'git-failed';

export type BranchListResult = { ok: true; listing: BranchListing } | { ok: false; reason: GitFailure };

export type DirtyResult = { ok: true; paths: string[] } | { ok: false; reason: GitFailure };

export type CheckoutResult =
  | { ok: true; context: GitContext }
  /** R-5.5 — the working tree carried uncommitted work; `paths` is what R-5.4 reported. */
  | { ok: false; reason: 'dirty'; paths: string[] }
  /** R-5.7 — the name is not a branch git just reported, so it was never passed on. */
  | { ok: false; reason: 'unknown-branch' }
  /**
   * R-5.8 — the branch **did** change and the ignore entry could not be written.
   * Distinct from every other failure here because the repository moved: the caller
   * is handed the context it moved to, and the user is told the one thing that did
   * not happen rather than that nothing did.
   */
  | { ok: false; reason: 'ignore-failed'; context: GitContext }
  | { ok: false; reason: GitFailure };

const failureOf = (result: GitResult): GitFailure =>
  result.exitCode === null ? 'git-unavailable' : 'git-failed';

/**
 * `%09` is a tab, and git refuses ASCII control characters in ref names, so it is a
 * delimiter no branch name can contain. `%(upstream:track)` is plumbing here and not
 * translated — `git branch` installs the localised strings, `for-each-ref` keeps the
 * untranslated ones — so matching English words against it is safe in a way that
 * matching `git branch -vv` output would not be.
 */
const LOCAL_FORMAT = '%(refname:short)%09%(HEAD)%09%(upstream)%09%(upstream:track)';

/** `[ahead 3, behind 1]`, `[ahead 3]`, `[behind 1]`, `[gone]`, or empty. */
const AHEAD = /ahead (\d+)/;
const BEHIND = /behind (\d+)/;

/**
 * The local branches and the branches of `origin` (R-5.1, R-5.2). Two reads, both
 * of `for-each-ref` — a single pass over the ref store, and unlike `git branch` it
 * is plumbing, so its output is a format rather than a display.
 *
 * Never throws (R-5.11): a spawn failure, a non-zero exit and a refused directory
 * are all reported as `{ ok: false }`.
 */
export async function listBranches(
  dir: string,
  exec: GitExecutor = defaultExecGit,
): Promise<BranchListResult> {
  const heads = await exec(['-C', dir, 'for-each-ref', `--format=${LOCAL_FORMAT}`, 'refs/heads/']);
  if (heads.exitCode !== 0) return { ok: false, reason: failureOf(heads) };

  const local: LocalBranch[] = [];
  for (const line of heads.stdout.split('\n')) {
    if (line === '') continue;
    const [name = '', head = '', upstream = '', track = ''] = line.split('\t');
    if (name === '') continue;
    const branch: LocalBranch = { name, current: head === '*' };
    if (upstream !== '' && !track.includes('gone')) {
      // An upstream that is level reports an empty track, which is `0`/`0` — the one
      // place a missing count legitimately means zero rather than "not comparable".
      branch.ahead = Number(AHEAD.exec(track)?.[1] ?? 0);
      branch.behind = Number(BEHIND.exec(track)?.[1] ?? 0);
    }
    local.push(branch);
  }

  const remotes = await exec(['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/']);
  // A repository with no `origin` has no such refs and exits 0 with nothing, which is
  // the same answer as "origin exists and has no branches" — and for this listing's
  // one consumer they are the same answer.
  if (remotes.exitCode !== 0) return { ok: false, reason: failureOf(remotes) };
  const remote = remotes.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice('origin/'.length))
    // `origin/HEAD` is a symbolic ref pointing at another entry in this very list,
    // not a branch anyone can ask for by that name.
    .filter((name) => name !== '' && name !== 'HEAD');

  return { ok: true, listing: { local, remote } };
}

/**
 * Every path `git status --porcelain` reports, repository-relative (R-5.4).
 *
 * `-z` rather than the default: without it git quotes and C-escapes any path holding
 * a space or a non-ASCII byte, so a refusal would name `"my notes.md"` — a file that
 * does not exist. With `-z` the records are NUL-separated and never quoted. A rename
 * or copy record carries two paths, the new one and then the original; both are
 * reported, because both are places the user's work currently is.
 */
export async function readDirtyPaths(
  dir: string,
  exec: GitExecutor = defaultExecGit,
): Promise<DirtyResult> {
  const status = await exec(['-C', dir, 'status', '--porcelain', '-z']);
  if (status.exitCode !== 0) return { ok: false, reason: failureOf(status) };

  const records = status.stdout.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    // The final field after the trailing NUL is empty, and so is the whole output
    // for a clean tree.
    if (!record) continue;
    // `XY path`, where XY is exactly two status codes followed by one space.
    const codes = record.slice(0, 2);
    const path = record.slice(3);
    if (path !== '') paths.push(path);
    // R and C put the original path in the next record rather than in this one.
    if (codes.includes('R') || codes.includes('C')) {
      const origin = records[i + 1];
      i += 1;
      if (origin) paths.push(origin);
    }
  }
  return { ok: true, paths };
}

/**
 * Change the served directory's repository to `branch` (R-5.5 … R-5.9).
 *
 * The order is the requirement, not an implementation detail:
 *
 *   1. list the branches, so the target can be checked against names git itself
 *      reported and never used as given (R-5.7);
 *   2. read the working tree, and refuse outright on anything at all (R-5.5) —
 *      `checkout` is not invoked, so git never gets the chance to succeed the way
 *      this module exists to prevent;
 *   3. check out, creating a tracking branch where the name is only on `origin`;
 *   4. re-assert the collaboration ignore entry, because `.gitignore` is tracked and
 *      the branch just arrived at may predate it (R-5.8);
 *   5. read the context back rather than composing it, so the caller is told what
 *      the repository is instead of what it was asked to become (R-5.9).
 */
export async function checkoutBranch(
  dir: string,
  branch: string,
  exec: GitExecutor = defaultExecGit,
): Promise<CheckoutResult> {
  const listed = await listBranches(dir, exec);
  if (!listed.ok) return { ok: false, reason: listed.reason };

  const isLocal = listed.listing.local.some((b) => b.name === branch);
  const isRemote = listed.listing.remote.includes(branch);
  if (!isLocal && !isRemote) return { ok: false, reason: 'unknown-branch' };

  const dirty = await readDirtyPaths(dir, exec);
  if (!dirty.ok) return { ok: false, reason: dirty.reason };
  if (dirty.paths.length > 0) return { ok: false, reason: 'dirty', paths: dirty.paths };

  const changed = isLocal
    ? await exec(['-C', dir, 'checkout', branch])
    : // `--track origin/<branch>` states the upstream rather than relying on the DWIM
      // rule, which is configurable (`checkout.defaultRemote`) and off for a
      // repository with more than one remote carrying the same branch name.
      await exec(['-C', dir, 'checkout', '-b', branch, '--track', `origin/${branch}`]);
  if (changed.exitCode !== 0) return { ok: false, reason: failureOf(changed) };

  // Caught, not awaited bare. `ensureIgnored` reads and writes `.gitignore` through
  // `node:fs`, and both can throw for reasons that have nothing to do with git —
  // `EACCES` on a read-only checkout, `EROFS` on a mounted volume. Node puts the
  // absolute path into the message ("EACCES: permission denied, open '/Users/…'"),
  // this module has no caller that catches (`core/vite/routes/git.ts` treats every
  // failure as a value, deliberately), and the host's last-resort handler answers
  // 500 with `err.message` — so an uncaught throw here is an absolute filesystem path
  // crossing the process boundary from the one route that writes, breaking R-5.10 and
  // R-1.11 at once. The branch did change, so this is not reported as a failed
  // checkout; it is the ignore entry that could not be written.
  try {
    await ensureIgnored(dir);
  } catch {
    return { ok: false, reason: 'ignore-failed', context: await readGitContext(dir, exec) };
  }

  return { ok: true, context: await readGitContext(dir, exec) };
}
