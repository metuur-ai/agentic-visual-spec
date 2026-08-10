/**
 * review-source-api.ts — the `ReviewSource` for a reviewer who has no clone.
 *
 * WHY THIS EXISTS. `review-source-worktree.ts` answers a review out of a checkout, which
 * is free and complete and requires the served directory to be a git working tree with an
 * origin to fetch from. When it is not — a reviewer serving a plain folder, a documents
 * directory that was never cloned — today's surface refuses a review GitHub could have
 * answered over the wire. This is that answer: the same four operations, read one path at
 * a time from the repository host (R-W2.1 / R-W2.2 / R-W2.3).
 *
 * IT INTRODUCES NO NEW WAY TO REACH GITHUB (R-W2.6). Every read here is a call on the
 * `GitHubAdapter` this package already builds and already uses for the comment, listing
 * and anchoring paths. There is no `fetch` in this file, no token is read, no process is
 * spawned, and `gh`'s own auth remains the only credential story. That is not an
 * implementation detail — it is the entire reason this design was preferred to the
 * withdrawn provisioned-workspace one, which would have needed a credential of its own to
 * clone with. A second access path added here would give that objection back.
 *
 * IT WRITES NOTHING, ANYWHERE (R-W2.9). No cache, no temp file, no directory under the
 * user's home, not even as an optimisation for a file read twice. The module imports no
 * filesystem module at all, which is the strongest form of that promise and is asserted
 * as such in the test: a module that cannot reach `node:fs` cannot write. If a later
 * story wants caching, it belongs above this seam, in memory, and it needs R-W2.9 read
 * again first.
 *
 * THE SHA IS FIXED AT CONSTRUCTION, AND SO IS EVERYTHING ELSE. `headSha` is the ref of
 * every content read below; no method takes one, because a `ref` parameter is a branch
 * name waiting to be passed (R-W2.4 — see the header of `review-source.ts`, which
 * argues this at length). `baseRef` is the one ref here that is *not* the pinned sha, and
 * only because it is the left-hand side of a comparison rather than a read of bytes: the
 * changed-paths question is "what does this head add to that base", and the base is a
 * branch by definition. Nothing a reviewer looks at comes from it.
 *
 * ONE DIRECTORY PER CALL. `listDirectory` is not recursive and no recursive walk is built
 * out of it here. That matches how a tree expands on click, and it is the only shape the
 * adapter offers — the Git Trees API is the recursive option and this package
 * deliberately does not use it. A reviewer who opens nothing pays for nothing.
 *
 * AN EMPTY LISTING IS NOT PROOF OF AN EMPTY DIRECTORY (R-W2.12). `listFiles` folds a 404
 * into `[]`, so "this directory is not in the pull request" and "this directory is empty"
 * used to arrive here as the same value, and the empty one was rendered — a reviewer shown
 * an empty node for a directory that is not there reads it as one the pull request
 * deleted, which is a confident wrong answer and the exact failure the taxonomy exists to
 * prevent. The checkout source can already tell the two apart, and it is the one that is
 * right, so this side adopts its answer. It is recovered without changing the adapter: git
 * cannot store an empty directory, so an empty listing at a path that *does* exist means
 * the path is not a directory at all — a file, or a submodule, both of which the contents
 * endpoint answers with an object `getFile` returns non-null for. One extra call, only
 * ever on an empty listing, and never on the repository root, which exists whenever the
 * commit does.
 *
 * FAILURES ARE VALUES (R-W2.7). `GitHubError` carries a status and, for the one case
 * `gh` cannot even start, a code; `classifyFailure` below maps those onto the four
 * outcomes `ReviewSourceFailure` names, reusing the same reading of the statuses that
 * `open.ts` already applies (401 is the credential, 403/404 is the access, the
 * `executor_unavailable` code of R-4.10 is the path itself). Nothing here throws.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 * In fact this file imports nothing but types and one error class.
 */
import { GitHubError, type DirectoryEntry, type GitHubAdapter, type RepoRef } from './github-adapter';
import type {
  ChangedPathsResult,
  DirectoryResult,
  FileResult,
  ReviewEntry,
  ReviewSource,
  ReviewSourceFailure,
} from './review-source';

/**
 * The three adapter methods this source is allowed to reach for, and no more.
 *
 * Narrowed rather than taking the whole `GitHubAdapter` so that a fourth host call cannot
 * be added here without the type changing to admit it — which is R-W2.6 held by the
 * compiler instead of by intent. The checkout source narrows the same way, to the one
 * method it needs.
 */
export type ReviewSourceAdapter = Pick<GitHubAdapter, 'compareCommits' | 'listFiles' | 'getFile'>;

/** What the host source needs to know before it can answer anything. */
export type ApiReviewSourceInput = {
  /** The adapter the rest of the package already uses. The only way out of this module. */
  adapter: ReviewSourceAdapter;
  /** The repository the pull request lives in. */
  repo: RepoRef;
  /** The pull request's head commit. Every content read below lands here (R-W2.4). */
  headSha: string;
  /**
   * The pull request's base — its branch name, or a sha. Used only as the left side of
   * the changed-paths comparison, never as the ref of a read.
   */
  baseRef: string;
};

/**
 * Git's sha for the empty blob, which every git implementation agrees on because it is
 * the hash of a zero-length object. See `readFile`: it is how a genuinely empty file is
 * told apart from one the host declined to inline.
 */
const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/**
 * A throttled request and a forbidden one both arrive as 403, and the executor is
 * buffered and header-blind — `Retry-After` never reaches us. GitHub's body message is
 * the only signal, and it is stable across the three wordings it uses. Copied in spirit
 * from `open.ts`, which reads the same statuses the same way.
 */
function isRateLimit(err: GitHubError): boolean {
  if (err.status === 429) return true;
  if (err.status !== 403) return false;
  return /\brate limit\b|\babuse detection\b/i.test(err.message);
}

/**
 * Does this failure say the *commit* is gone, rather than the path?
 *
 * GitHub answers a read at a vanished ref with 404 "No commit found for the ref …", and a
 * comparison against one with 404 or 422 naming it. Both are `head-moved`, not
 * `not-readable`: the reviewer must re-pin the review (R-W2.5), and retrying or checking
 * the path will not help. The sha itself is looked for too, because the message wording
 * differs per endpoint but the ref that failed is in all of them.
 */
function isMissingRef(err: GitHubError, headSha: string): boolean {
  if (err.status !== 404 && err.status !== 422) return false;
  if (/no commit found for (?:the )?ref/i.test(err.message)) return true;
  return headSha !== '' && err.message.includes(headSha);
}

/**
 * `GitHubError` → the four outcomes a reviewer can act on, plus the host's own words.
 *
 * The default is `unreachable` rather than `not-readable`, deliberately: an unclassified
 * failure is one whose recovery we do not know, and "wait and try again" is the advice
 * that is merely useless when wrong, where "check your access" would send the reviewer
 * looking for a permissions problem that is not there. `detail` carries GitHub's message
 * in every case, already scrubbed of credential material by `GitHubError` itself (R-4.9).
 */
function classifyFailure(err: unknown, headSha: string): { reason: ReviewSourceFailure; detail?: string } {
  if (!(err instanceof GitHubError)) {
    const message = err instanceof Error ? err.message : String(err);
    return { reason: 'unreachable', detail: message };
  }
  // R-4.10 — `gh` itself could not be run. The path is unavailable, not failing, and
  // installing it is the fix; from a reviewer's seat that is the same shape as offline.
  if (err.ghErrorCode === 'executor_unavailable') return { reason: 'unreachable', detail: err.message };
  if (err.status === 401) return { reason: 'no-credential', detail: err.message };
  if (isMissingRef(err, headSha)) return { reason: 'head-moved', detail: err.message };
  // Throttling is transient and the access is fine, so it is an `unreachable`, which is
  // the only one of the four whose advice ("retry") is the right advice here.
  if (isRateLimit(err)) return { reason: 'unreachable', detail: err.message };
  if (err.status === 403 || err.status === 404) return { reason: 'not-readable', detail: err.message };
  if (err.status !== undefined && err.status >= 500) return { reason: 'unreachable', detail: err.message };
  return { reason: 'unreachable', detail: err.message };
}

/**
 * GitHub's `type` → the two kinds a file tree can draw. GitHub's own value is passed
 * through the adapter unnarrowed and is more than two things (R-4.x, `DirectoryEntry`):
 *
 * - `file`      → a file.
 * - `dir`       → a directory.
 * - `symlink`   → a **file**. The tree offers to open it, and opening it reads whatever
 *                 the contents endpoint answers for that path; drawing it as a directory
 *                 would promise an expansion that has no listing behind it.
 * - `submodule` → a **directory**. It is a directory everywhere else the reviewer has
 *                 seen it, and `listDirectory` answers `[]` for one (see there), so it
 *                 expands to nothing rather than failing.
 *
 * Anything else GitHub grows later falls to `file`, for the same reason `symlink` does:
 * an unopenable leaf is a smaller lie than an unexpandable branch.
 */
function toEntry(entry: DirectoryEntry): ReviewEntry {
  const kind = entry.type === 'dir' || entry.type === 'submodule' ? 'directory' : 'file';
  return { name: entry.name, path: entry.path, kind };
}

/**
 * The order both sources list a directory in — one flat sort by `name`, directories not
 * grouped ahead of files, compared with plain `<` / `>`.
 *
 * NOT `localeCompare`, which is what `core/vite/tree-store.ts` uses. Locale collation is
 * environment-dependent — it is the reason `docs` can precede `README.md` on one machine
 * and follow it on another — and story 6.1 asserts the two sources answer alike. Two
 * implementations cannot be relied on to agree about a rule neither of them owns, so the
 * one they share is code-unit order, which is total and has no configuration.
 */
function byName(a: ReviewEntry, b: ReviewEntry): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * The host-backed `ReviewSource` (R-W1.4). Bound to one pull request at one commit; it
 * has no open, no close, and no state at all beyond the four values it was built with.
 */
export function createApiReviewSource(input: ApiReviewSourceInput): ReviewSource {
  const { adapter, repo, headSha, baseRef } = input;

  /**
   * Is there anything at all at `path` in this commit?
   *
   * The contents endpoint answers an object for a file, a symlink and a submodule alike,
   * and `getFile` folds only its 404 into `null` — so `null` here means "nothing at this
   * path", which is the one thing `listFiles`'s `[]` cannot say for itself. Throws are
   * left to the caller's `catch`, where they classify as any other failed read: a 403 on
   * the probe is a directory whose existence we genuinely cannot establish, and guessing
   * "empty" for it would be the same wrong answer this exists to remove.
   */
  const existsAtHead = async (path: string): Promise<boolean> =>
    (await adapter.getFile(repo, path, headSha)) !== null;

  return {
    kind: 'host',
    headSha,

    async changedPaths(): Promise<ChangedPathsResult> {
      try {
        /*
         * `compareCommits(repo, base, head).files` — the identical call the checkout
         * source makes for this operation, on purpose. The changed-files pane is already
         * API-sourced on both sides today; story 6.1 asserts the two sources answer this
         * question alike, and they can only be guaranteed to do that by asking it in one
         * shape. If this ever needs to change, it changes on both sides together.
         */
        const comparison = await adapter.compareCommits(repo, baseRef, headSha);
        return { ok: true, value: comparison.files };
      } catch (err) {
        return { ok: false, ...classifyFailure(err, headSha) };
      }
    },

    async listDirectory(path: string): Promise<DirectoryResult> {
      try {
        /*
         * `''` is the repository root — the adapter builds `/contents/?ref=…`, which is
         * the endpoint's own spelling for it. One directory, never recursive.
         *
         * `listFiles` answers `[]` rather than throwing for a 404 and for a `path` that
         * is a file or a submodule (the endpoint returns an object, not an array). The
         * first of those three is a different thing from the other two and is separated
         * out below (R-W2.12).
         */
        const entries = await adapter.listFiles(repo, path, headSha);

        if (entries.length === 0 && path !== '' && !(await existsAtHead(path))) {
          return {
            ok: false,
            reason: 'not-readable',
            detail: `${path} is not a directory in this pull request at ${headSha.slice(0, 7)}`,
          };
        }

        // Sorted here rather than trusted from the host: `byName` is the order the
        // checkout source produces too, and 6.1 compares the two lists element by element.
        return { ok: true, value: entries.map(toEntry).sort(byName) };
      } catch (err) {
        return { ok: false, ...classifyFailure(err, headSha) };
      }
    },

    async readFile(path: string): Promise<FileResult> {
      try {
        const file = await adapter.getFile(repo, path, headSha);
        /*
         * `getFile` folds a 404 into `null`, so this branch covers both "no such file at
         * this commit" and "no such commit" — the second of which would be `head-moved`
         * if the status had survived. It has not, so the honest answer is the one that
         * does not guess, and the detail says which two things it could be. Nothing
         * above this line can recover the distinction without a change to the adapter,
         * which this story does not own.
         */
        if (file === null) {
          return {
            ok: false,
            reason: 'not-readable',
            detail: `${path} was not found at ${headSha.slice(0, 7)} — either it is not in this commit, or the commit is gone`,
          };
        }
        /*
         * AN UNRESOLVABLE SYMBOLIC LINK READS AS ITS OWN TARGET PATH (R-W2.11a).
         *
         * The contents endpoint answers a link in one of two shapes, and the shape is the
         * whole of the distinction R-W2.11 / R-W2.11a draw:
         *
         *   - it RESOLVED the link, because the target is a plain file the repository
         *     holds. Then the response is an ordinary file response — content, no
         *     `target` — and it falls past this branch to be returned as the file it is
         *     (R-W2.11). Nothing here has to opt into that; the target is tree content the
         *     reviewer could have opened by its own path.
         *   - it COULD NOT resolve the link, which is what happens when the target leaves
         *     the repository. Then the response is the symlink object: `target` set,
         *     `content` empty. That is this branch, and the target path is all either
         *     source will ever say about such a link — nothing outside the pull request's
         *     tree is fetched (R-W2.10).
         *
         * Without the branch the symlink object would fall into the 1 MB check below —
         * empty content under a non-empty blob sha — and be reported as a file too large
         * to inline, which is both wrong and unhelpful. The checkout source splits on the
         * same two cases by resolving the link itself, so the two sources say the same
         * sentence about the same link either way (R-W2.11b).
         */
        if (file.target !== undefined && file.target !== '') {
          return { ok: true, value: { path: file.path, text: file.target } };
        }
        /*
         * THE 1 MB CONTENTS CAP, MADE LOUD.
         *
         * The contents endpoint inlines base64 only up to about 1 MB. Past that GitHub
         * either refuses with a 403 whose message says so — which `classifyFailure`
         * already turns into `not-readable` carrying that sentence — or answers `200`
         * with `content: ""` and `encoding: "none"`. The adapter's `FileContent` drops
         * `encoding`, so the second shape arrives here as an empty string and would
         * otherwise render as an empty file: a large file silently shown as blank, which
         * is exactly the outcome a reviewer cannot detect.
         *
         * The blob sha is what separates the two. A genuinely empty file hashes to git's
         * empty-blob sha, which is a constant; empty content under any other sha means
         * the bytes exist and were not sent. That is reported as unreadable with the
         * reason spelled out, because there is no second endpoint in use here to fetch
         * them from — closing it properly means teaching the adapter the `raw` media
         * type, which is a change this story does not own.
         */
        if (file.content === '' && file.sha !== '' && file.sha !== EMPTY_BLOB_SHA) {
          return {
            ok: false,
            reason: 'not-readable',
            detail: `${path} was not returned by the contents API, which inlines files only up to about 1 MB — open it on the repository host instead`,
          };
        }
        // Files the pull request did not change read exactly the same way: the ref is a
        // commit, not a diff, so the whole tree at `headSha` is addressable (R-W2.2).
        return { ok: true, value: { path: file.path, text: file.content } };
      } catch (err) {
        return { ok: false, ...classifyFailure(err, headSha) };
      }
    },
  };
}
