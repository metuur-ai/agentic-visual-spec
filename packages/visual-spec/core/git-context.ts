/**
 * git-context.ts — what repository, branch and remote the served directory sits in.
 *
 * R-1.1: the branch, the detached state and the `origin` URL are obtained by
 * invoking `git` against the served directory. Three reads, all with `git -C <dir>`:
 *
 *   | command                      | yields                                          |
 *   | ---------------------------- | ----------------------------------------------- |
 *   | `rev-parse --abbrev-ref HEAD`| the branch, or the literal `HEAD` when detached |
 *   | `rev-parse --short HEAD`     | the short sha, read only when the above is HEAD |
 *   | `remote get-url origin`      | the origin URL; non-zero exit means no origin   |
 *
 * WHY A SUBPROCESS AND NOT A PARSER. An earlier design read `.git/HEAD` and
 * `.git/config` by hand to avoid spawning anything. It was reversed, and the reason
 * is worth keeping: the *formats* are stable, but a hand parser is not. Review found
 * two defects in that design before a line of it existed —
 *
 *   1. a linked worktree's git directory holds `HEAD` but **not** `config` (that
 *      lives in the common directory), so every `git worktree add` checkout would
 *      have reported no remote;
 *   2. a naive scan of `.git/config` picks up `[remote "upstream"]` when it precedes
 *      `[remote "origin"]`, reporting somebody else's repository.
 *
 * Behind those sit `include`, `includeIf` and `url.<base>.insteadOf`, which git
 * resolves and a file scan cannot. Delegating deletes the ancestor walk, the
 * `gitdir:` indirection, `commondir` resolution, submodule handling and the config
 * parser outright. What stays hand-written is one regex over the remote URL, which
 * has no alternative. Both defects above are covered by tests in this module's suite.
 *
 * R-1.10: every command here is a read. Nothing in this file writes to a repository.
 *
 * R-1.11: only the host, owner, repository, branch and origin URL leave this module.
 * No absolute filesystem path and no configuration content is ever put in the result —
 * `dir` goes in and never comes back out.
 *
 * `core/` is Node-reachable from the CLI, so this module imports only node builtins.
 */
import { spawn } from 'node:child_process';

export type GitContext =
  | { state: 'none' }
  | { state: 'local'; branch: string; detached: boolean; url?: string }
  | {
      state: 'remote';
      branch: string;
      detached: boolean;
      owner: string;
      repo: string;
      host: string;
      url: string;
    };

/** Everything this module is allowed to observe about a `git` run. */
export interface GitResult {
  stdout: string;
  /** `null` when `git` could not be executed at all (not on PATH, spawn failed). */
  exitCode: number | null;
}

/**
 * Run `git` with `args`. Never rejects — a failed spawn is reported as
 * `exitCode: null`, which R-1.2 treats exactly like a non-zero exit.
 *
 * Injectable for the same reason `GhExecutor` in `core/collaboration/github-executor.ts`
 * is: it is the one process seam, so a test can drive the `ENOENT` and the
 * `safe.directory` refusal paths without needing a machine that reproduces them.
 */
export type GitExecutor = (args: string[]) => Promise<GitResult>;

/** Spawn the real `git`. stderr is drained but discarded — see R-1.11. */
export const defaultExecGit: GitExecutor = (args) =>
  new Promise<GitResult>((resolve) => {
    const child = spawn('git', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    // Drained so the pipe cannot fill and stall the child; never read. git writes
    // absolute paths into stderr ("dubious ownership in repository at '/…'"), and
    // R-1.11 forbids those from crossing the process boundary.
    child.stderr?.resume();
    child.on('error', () => resolve({ stdout, exitCode: null }));
    child.on('close', (code) => resolve({ stdout, exitCode: code }));
  });

/**
 * `https://<host>/<owner>/<repo>` and `git@<host>:<owner>/<repo>`, each with an
 * optional `.git` suffix (R-1.7). Deliberately narrow: `ssh://`, `git://`, `file://`
 * and port-bearing forms are *not* accepted, because the only consumer of a match is
 * a `https://<host>/<owner>/<repo>` link, and guessing wrong there is worse than
 * declining. Everything else is R-1.8's job.
 */
const HTTPS_REMOTE = /^https:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/;
const SCP_REMOTE = /^git@([^:/]+):([^/]+)\/(.+?)(?:\.git)?\/?$/;

/**
 * R-1.7 / R-1.8. A match yields host, owner and repo; anything else yields `null`,
 * and the caller reports `local` **carrying the raw URL** rather than `remote` with
 * empty fields. Two different situations reach `local` — no `origin` at all, and an
 * `origin` that would not parse — and the presence of `url` is what tells them apart.
 */
export function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null {
  const match = HTTPS_REMOTE.exec(url) ?? SCP_REMOTE.exec(url);
  if (!match) return null;
  const [, host, owner, repo] = match;
  // A nested path (`https://host/a/b/c`) leaves `b/c` in the repo slot. That is not
  // the `<owner>/<repo>` shape the spec names, so it declines rather than guesses.
  if (!host || !owner || !repo || repo.includes('/')) return null;
  return { host, owner, repo };
}

/**
 * Read the git context of `dir`. Never throws (R-1.2): `git` missing (spawn `ENOENT`),
 * `git` refusing the directory (`safe.directory` / "dubious ownership", which the 2022
 * CVE fix made a routine occurrence in containers and mounted volumes), a directory
 * that is not a repository, or any other non-zero exit all resolve to `{ state: 'none' }`.
 *
 * Note that `git -C <dir>` searches upward, so the repository reported may sit *above*
 * `dir`. That is deliberate — pointing this tool at a `docs/` subdirectory is a normal
 * thing to do — and is recorded as a decision rather than left as an accident.
 */
export async function readGitContext(
  dir: string,
  exec: GitExecutor = defaultExecGit,
): Promise<GitContext> {
  const head = await exec(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.exitCode !== 0) return { state: 'none' };

  const headName = head.stdout.trim();
  if (!headName) return { state: 'none' };

  let branch = headName;
  const detached = headName === 'HEAD';
  if (detached) {
    // Only reached for a detached HEAD, so an unborn branch (`git init`, no commit)
    // never gets here — there `--abbrev-ref` already names the branch it will create.
    const sha = await exec(['-C', dir, 'rev-parse', '--short', 'HEAD']);
    if (sha.exitCode !== 0 || !sha.stdout.trim()) return { state: 'none' };
    branch = sha.stdout.trim();
  }

  // R-1.9: `origin` by name. Asking git for it by name is also what makes an
  // `upstream` remote that precedes `origin` in the config a non-event.
  const remote = await exec(['-C', dir, 'remote', 'get-url', 'origin']);
  const url = remote.exitCode === 0 ? remote.stdout.trim() : '';
  // R-1.6: no origin (non-zero exit) → `local` with no URL at all, not an empty one.
  if (!url) return { state: 'local', branch, detached };

  const parsed = parseRemoteUrl(url);
  if (!parsed) return { state: 'local', branch, detached, url };
  return { state: 'remote', branch, detached, url, ...parsed };
}
