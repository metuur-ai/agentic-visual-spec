/**
 * review-source-worktree.ts — the `ReviewSource` a review reads through when the pull
 * request is already on disk (R-W1.2).
 *
 * WHY THIS IS AN EXTRACTION AND NOT A FEATURE. Everything here is what
 * `ui/collab-pr-review.tsx` already does through `/__vs/tree` and `/__vs/raw`: list a
 * directory inside the checkout, read a file out of it, ask the `/files` route what
 * changed. Nothing about that behaviour is meant to change (R-W5.2) — it is being moved
 * behind the interface so that the *second* source can exist without the reviewing
 * surface learning there are two. The value of doing it first, before the host source
 * is written, is that a regression on this side stays distinguishable from a bug on
 * that one.
 *
 * WHY `mountPullRequest` IS NOT TOUCHED. Mounting and reading are two different jobs
 * with two different failure vocabularies, and this module owns only the second. It is
 * handed a `MountedWorktree` — a path and the commit that path is detached at — and
 * never fetches, never creates, never removes. A source that could mount would be a
 * source that could re-pin itself, which is the thing `ReviewSource` was shaped to make
 * impossible.
 *
 * WHY THE HEAD IS RE-CHECKED ON EVERY READ. The checkout is a directory on a disk the
 * reviewer also owns, and `mountPullRequest` deliberately re-mounts an already-mounted
 * pull request in place: a second mount after new commits runs `checkout --detach` on
 * the same path. So the bytes under an open review can be replaced by a different
 * commit's bytes without the path changing, which is precisely the silent swap R-W2.4
 * exists to forbid. A read that cannot prove the checkout still holds `headSha` reports
 * `head-moved` instead of serving it — the review is re-pinned (R-W2.5), not retried.
 * The check is a `rev-parse`, the same call `mountPullRequest` uses to learn the sha in
 * the first place, so the two cannot disagree about what "the checkout is at" means.
 *
 * CONTAINMENT, IN TWO LAYERS. `path` arrives from a request, and `resolve()` will happily
 * turn `../../..` into somewhere else entirely. The first layer is the string rule from
 * `core/vite/tree-store.ts`, restated here rather than imported, because that module is
 * the *served* directory's store and binding a review's containment to it would mean a
 * review's root and the user's root were one setting apart from being the same thing.
 * Restating it is four lines; sharing it is a coupling.
 *
 * The second layer is the one this module used to do without. A string comparison cannot
 * see a symbolic link, so a link *inside* the checkout pointing outside it used to be
 * followed — and a pull request from a fork is attacker-controlled content, so a link
 * committed at `docs/notes.md` and aimed at `~/.ssh/id_rsa` rendered that file in the
 * review surface. That was recorded here as an accepted cost, priced against a `realpath`
 * per read. R-W2.10 withdraws the acceptance: the price was one syscall and the thing
 * bought with it was a reviewer's private keys. So every read now resolves the real path
 * of what it is about to open and refuses anything landing outside the checkout's own
 * real path — `realpath` on both sides, because a temporary directory is itself commonly
 * reached through a link (`/var` → `/private/var` on macOS) and comparing a resolved path
 * against an unresolved root would refuse every read. `core/vite/tree-store.ts`'s
 * `safeForWrite` closes the same hole from the writing side and reasons it out at length.
 *
 * WHAT KIND AN ENTRY IS. A symlink is reported as a file, and a submodule as an empty
 * directory. Neither is what it "really" is; both are what a reviewer can do with it.
 * A submodule's contents belong to another repository and are not part of this pull
 * request's tree — in a fresh worktree the directory is usually empty anyway — so it
 * lists as nothing rather than failing, which would read as the review being broken.
 *
 * WHAT OPENING A SYMLINK YIELDS, AND WHY IT DEPENDS ON WHERE THE LINK AIMS. A symlink is
 * openable, so it lists as a file. Reading it splits on containment, because that is where
 * the repository host splits and this source is required to answer as the host does
 * (R-W2.11b):
 *
 *   - the target resolves to a plain file INSIDE the checkout → the target's contents
 *     (R-W2.11). GitHub's contents endpoint resolves such a link and answers the target
 *     file's bytes, and there is nothing to protect: the target is tree content this same
 *     reviewer can open by its own path anyway.
 *   - the target resolves anywhere else — outside the checkout, at a directory, or nowhere
 *     at all — → the link's own target path as text, and the target is never opened
 *     (R-W2.11a). That is the symlink object the host answers when it cannot resolve, and
 *     it is the security property: it is the case where following the link would hand back
 *     bytes belonging to no pull request.
 *
 * An earlier revision answered the target path for *every* link. That closed the hole and
 * overshot it — a divergence from the host in the safe direction is still a divergence,
 * and it made an in-tree link render as a one-line path instead of the file the reviewer
 * asked for. The link is examined with `lstat` + `realpath`, never with a bare `readFile`
 * that would walk through it before the question was decided.
 *
 * FAILURES ARE VALUES. Nothing here rejects. `no-credential` and `unreachable` are the
 * host side's to report and are never produced by this module: a checkout needs no
 * credential to be read and no network to be reached. A missing file, an unreadable
 * directory and a refused path all land on `not-readable`, because they are one thing to
 * the reviewer — check the path or your access.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 */
import { readFile as fsReadFile, lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { defaultExecGit, type GitExecutor } from '../git-context';
import type { GitHubAdapter, RepoRef } from './github-adapter';
import type {
  ChangedPathsResult,
  DirectoryResult,
  FileResult,
  ReviewEntry,
  ReviewSource,
} from './review-source';

/** Entries that are never part of a pull request's tree, whatever a listing says. */
const HIDDEN = new Set(['.git', '.visual-spec']);

/**
 * What this source needs that the checkout cannot tell it.
 *
 * The changed-path list is not on the disk. A worktree is one commit's tree; "which
 * paths did this pull request change" is a question about two commits and a merge base,
 * and the answer the rest of the surface already shows comes from the host. Asking the
 * host for it here is not the host source leaking in — it is the same call the `/files`
 * route has always made, kept identical on purpose so the two sources cannot drift apart
 * on the one operation they answer the same way.
 *
 * `adapter` is narrowed to the single method used. A source that is handed the whole
 * adapter is a source that can grow a second host call without anyone noticing.
 */
export type WorktreeReviewSourceOptions = {
  /** The checkout, as `mountPullRequest` returned it: a path and the commit it is at. */
  worktree: { path: string; headSha: string };
  /** The repository the pull request belongs to. */
  repo: RepoRef;
  /** The branch the pull request is opened against — the `base` of the comparison. */
  baseBranch: string;
  adapter: Pick<GitHubAdapter, 'compareCommits'>;
  /** Injectable so the head check can be driven in tests; the default is the real git. */
  exec?: GitExecutor;
};

/**
 * Resolve `rel` against `base` and prove it stays there.
 *
 * `null` is the refusal, and every caller turns it into `not-readable` rather than a
 * throw. An absolute `rel` is covered for free: `resolve(base, '/etc/passwd')` is
 * `/etc/passwd`, which fails the prefix test like any other escape.
 */
function contained(base: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/** `path` and `name` joined the way the interface spells paths: repo-relative, posix. */
function childPath(dir: string, name: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  return trimmed === '' ? name : `${trimmed}/${name}`;
}

/**
 * A `ReviewSource` reading a pull request out of a checkout already on disk.
 *
 * The returned object is bound to `worktree.headSha` for its whole life. When the head
 * moves, the caller builds a new source; there is nothing here that re-pins.
 */
export function createWorktreeReviewSource(options: WorktreeReviewSourceOptions): ReviewSource {
  const { worktree, repo, baseBranch, adapter } = options;
  const exec = options.exec ?? defaultExecGit;
  const root = resolve(worktree.path);
  const headSha = worktree.headSha;

  /**
   * The checkout root as the filesystem really spells it, resolved once per source.
   *
   * Every containment check below compares a `realpath` against this one, so it has to be
   * a `realpath` too: `mkdtemp` hands out `/var/folders/…` on macOS, which really is
   * `/private/var/folders/…`, and comparing resolved against unresolved would refuse
   * every read in the package's own tests before it ever refused an escape. Memoised
   * because it cannot change under a source that is already pinned to a commit; the
   * rejection (a checkout that is gone) is memoised with it and lands on `not-readable`
   * at each caller, which is the same answer `pinned()` gives for the same disk.
   */
  let realRootOnce: Promise<string> | undefined;
  const realRoot = (): Promise<string> => (realRootOnce ??= realpath(root));

  /**
   * Does `abs` really live in the checkout — not just spell as if it did?
   *
   * Rejects rather than returning `false` when the path does not resolve, because the
   * reasons it might not (it is missing, a link dangles, a component is not a directory)
   * are the errors the callers already turn into `not-readable` with the platform's own
   * wording. Returning `false` for those would report every absent file as an escape.
   */
  const escapesCheckout = async (abs: string): Promise<boolean> => {
    const [real, base] = await Promise.all([realpath(abs), realRoot()]);
    return real !== base && !real.startsWith(base + sep);
  };

  /**
   * Where a symbolic link at `abs` really lands, but only if that is a plain file inside
   * the checkout — otherwise `null`.
   *
   * `null` is every reason the host would decline to resolve a link and answer the symlink
   * object instead: the target is outside the tree, it dangles, or it is a directory. All
   * three collapse here because the caller does the same thing with them (R-W2.11a), and
   * separating them would invite an answer that varied with *why* a link was unresolvable
   * — which is exactly the kind of detail an attacker gets to choose.
   *
   * Rejections are caught rather than propagated, unlike `escapesCheckout`: a dangling
   * link is not a failed read here, it is a link that reads as its own target path.
   */
  const resolvedInsideFile = async (abs: string): Promise<string | null> => {
    try {
      const [real, base] = await Promise.all([realpath(abs), realRoot()]);
      if (real !== base && !real.startsWith(base + sep)) return null;
      // `stat` on the resolved path: the link points at *something*, and only a plain file
      // has contents to hand back.
      return (await stat(real)).isFile() ? real : null;
    } catch {
      return null;
    }
  };

  /**
   * Prove the checkout still holds the commit this source is pinned to.
   *
   * Resolves the failure to report, or `null` when the checkout is intact. A directory
   * git will not answer for is `not-readable` — it has been removed or replaced, and
   * "re-pin the review" would be the wrong advice for a checkout that is simply gone.
   */
  const pinned = async (): Promise<'head-moved' | 'not-readable' | null> => {
    const head = await exec(['-C', root, 'rev-parse', 'HEAD']);
    if (head.exitCode !== 0) return 'not-readable';
    return head.stdout.trim() === headSha ? null : 'head-moved';
  };

  /** The evidence a `head-moved` carries, in `mountPullRequest`'s two-shas form. */
  const movedDetail = async (): Promise<string> => {
    const head = await exec(['-C', root, 'rev-parse', 'HEAD']);
    return `the checkout is at ${head.stdout.trim().slice(0, 7)}, the review is pinned to ${headSha.slice(0, 7)}`;
  };

  return {
    kind: 'checkout',
    headSha,

    async changedPaths(): Promise<ChangedPathsResult> {
      try {
        // Deliberately the same call, in the same argument order, as the host source and
        // as the `/files` route: `base` is the branch the pull request targets, `head` is
        // the commit this source is pinned to. Anything else and the two sources answer
        // different questions with the same method name.
        const comparison = await adapter.compareCommits(repo, baseBranch, headSha);
        return { ok: true, value: comparison.files };
      } catch (error) {
        // Whatever the host's reason was, the reviewer's move is the same one: the list
        // could not be read. The richer vocabulary belongs to the source whose every
        // operation is a round trip, not to this one, which has exactly this single call.
        return { ok: false, reason: 'not-readable', detail: (error as Error).message };
      }
    },

    async listDirectory(path: string): Promise<DirectoryResult> {
      const moved = await pinned();
      if (moved === 'head-moved') return { ok: false, reason: 'head-moved', detail: await movedDetail() };
      if (moved === 'not-readable') return { ok: false, reason: 'not-readable' };

      const abs = contained(root, path);
      if (abs === null) return { ok: false, reason: 'not-readable', detail: `path escapes the checkout: ${path}` };

      try {
        // The string rule above cannot see a link, so the directory about to be walked is
        // resolved and proved to still be in the checkout (R-W2.10). A missing directory
        // fails this as an ENOENT from `realpath`, which the catch reports the same way
        // `readdir` would have.
        if (await escapesCheckout(abs)) {
          return { ok: false, reason: 'not-readable', detail: `path escapes the checkout: ${path}` };
        }

        // A directory holding its own `.git` is another repository — a submodule — and
        // its contents are not this pull request's. The checkout root holds one too, so
        // the test is skipped there.
        if (abs !== root && (await isSeparateRepo(abs))) return { ok: true, value: [] };

        const dirents = await readdir(abs, { withFileTypes: true });
        const entries: ReviewEntry[] = [];
        for (const dirent of dirents) {
          if (HIDDEN.has(dirent.name)) continue;
          // Symlink before directory: a link to a directory is still a link, and the
          // reviewer opens it rather than expanding it.
          const kind = dirent.isSymbolicLink() ? 'file' : dirent.isDirectory() ? 'directory' : 'file';
          entries.push({ name: dirent.name, path: childPath(path, dirent.name), kind });
        }
        // Sorted by name so the two sources hand the tree over in the same order — the
        // host's listing arrives in whatever order the host chose, and a tree that
        // reorders itself when it changes source is a difference the seam was supposed
        // to absorb. Compared by code unit rather than `localeCompare`, which orders
        // `README.md` and `docs` differently depending on the machine's locale: a sort
        // two implementations have to agree on cannot depend on where they are running.
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { ok: true, value: entries };
      } catch (error) {
        return { ok: false, reason: 'not-readable', detail: (error as Error).message };
      }
    },

    async readFile(path: string): Promise<FileResult> {
      // The root is a directory, so `''` — which `listDirectory` accepts — is not a file
      // anyone can be asking for. Refused here rather than left to EISDIR so the answer
      // does not depend on which error the platform happens to raise.
      if (path === '') return { ok: false, reason: 'not-readable', detail: 'no path' };

      const moved = await pinned();
      if (moved === 'head-moved') return { ok: false, reason: 'head-moved', detail: await movedDetail() };
      if (moved === 'not-readable') return { ok: false, reason: 'not-readable' };

      const abs = contained(root, path);
      if (abs === null) return { ok: false, reason: 'not-readable', detail: `path escapes the checkout: ${path}` };

      try {
        /*
         * `lstat` before anything else, so the link is recognised as one before anything
         * is opened through it. Where it lands decides the answer, exactly as it decides
         * the host's:
         *
         *   inside the checkout, at a plain file → that file's contents (R-W2.11). The
         *   read is aimed at the *resolved* path rather than at the link, so the bytes
         *   handed back are provably the ones containment was checked against.
         *
         *   anywhere else → `readlink`, the blob git actually stores for the link, which
         *   is a string this process already had rather than bytes it went and fetched
         *   from wherever the link happened to point (R-W2.10 / R-W2.11a).
         */
        const info = await lstat(abs);
        if (info.isSymbolicLink()) {
          const target = await resolvedInsideFile(abs);
          if (target === null) return { ok: true, value: { path, text: await readlink(abs) } };
          return { ok: true, value: { path, text: await fsReadFile(target, 'utf8') } };
        }

        // Not a link itself — but a directory on the way here could have been. Resolved
        // and proved contained before a single byte is read.
        if (await escapesCheckout(abs)) {
          return { ok: false, reason: 'not-readable', detail: `path escapes the checkout: ${path}` };
        }

        const text = await fsReadFile(abs, 'utf8');
        return { ok: true, value: { path, text } };
      } catch (error) {
        return { ok: false, reason: 'not-readable', detail: (error as Error).message };
      }
    },
  };
}

/** Whether `abs` is the root of a repository of its own — i.e. a submodule. */
async function isSeparateRepo(abs: string): Promise<boolean> {
  try {
    // `stat`, not `lstat`: `.git` is a directory in a plain clone and a file in a linked
    // worktree, and either one means the same thing here.
    await stat(resolve(abs, '.git'));
    return true;
  } catch {
    return false;
  }
}
