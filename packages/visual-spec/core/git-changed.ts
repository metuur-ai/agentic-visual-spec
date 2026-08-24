/**
 * git-changed.ts — the working tree's uncommitted paths, expressed the way the browser
 * can use them.
 *
 * WHY THIS IS NOT `readDirtyPaths` CALLED DIRECTLY. `git status --porcelain` reports
 * paths relative to the REPOSITORY ROOT, and everything the app addresses a file by —
 * `GET /__vs/tree/file?path=`, a comment's `target.path`, a collaboration's
 * `documentPath` — is relative to the SERVED DIRECTORY. The two coincide only when the
 * served directory is the repository root. Serving git's form unchanged would hand the
 * PR picker paths that read plausibly and resolve to nothing the moment anyone serves a
 * subdirectory. `rev-parse --show-prefix` names that offset (empty at the root,
 * `packages/docs/` otherwise), so the translation is git's own answer rather than a
 * guess made from two absolute paths this module is not allowed to see (R-1.11).
 *
 * Paths OUTSIDE the served directory are dropped rather than reported with `../`: the
 * file tree cannot show them and the file route refuses them, so offering them would be
 * offering work nobody can select.
 *
 * Reads only — the same guarantee `git-branches.ts` documents for its listings.
 *
 * `core/` is Node-reachable from the CLI, so this module imports sibling core modules only.
 */
import { defaultExecGit, type GitExecutor } from './git-context';
import { type DirtyResult, readDirtyPaths } from './git-branches';

/**
 * Every uncommitted path under the served directory, relative to it (R-8.36).
 *
 * Never throws: a git that could not be started, a non-zero exit and a directory that is
 * not a repository all arrive as `{ ok: false }`, exactly as `readDirtyPaths` does.
 */
export async function readChangedPaths(
  dir: string,
  exec: GitExecutor = defaultExecGit,
): Promise<DirtyResult> {
  const dirty = await readDirtyPaths(dir, exec);
  if (!dirty.ok) return dirty;

  const prefix = await exec(['-C', dir, 'rev-parse', '--show-prefix']);
  if (prefix.exitCode !== 0) {
    return { ok: false, reason: prefix.exitCode === null ? 'git-unavailable' : 'git-failed' };
  }

  // Empty for a served directory that IS the repository root, in which case git's paths
  // are already the app's paths and there is nothing to strip.
  const under = prefix.stdout.trim();
  if (under === '') return dirty;

  const paths = dirty.paths
    .filter((path) => path.startsWith(under))
    .map((path) => path.slice(under.length))
    .filter((path) => path !== '');
  return { ok: true, paths };
}
