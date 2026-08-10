/**
 * review-source.ts — the one interface a review reads its files through, whichever
 * of the two places they come from.
 *
 * WHY A SEAM AT ALL. `ui/collab-pr-review.tsx` browses a pull request through
 * `/__vs/tree` and `/__vs/raw` — the ordinary file routes — and its own header admits
 * why: the checkout happens to already be there. That is a convenience the surface was
 * built on top of, not a requirement it holds. It becomes a requirement only in the
 * failure it produces: a reviewer serving a directory that is not a git working tree,
 * or has no origin to fetch from, is refused a review that GitHub could have answered
 * over the wire. Making the source substitutable is the whole change (R-W1.4), and the
 * point of putting it behind an interface rather than a branch inside each read is that
 * the reviewing surface must not vary by source. One shape, two implementations, and
 * `resolveReviewSource` decides between them once, before any file is read (R-W1.1).
 *
 * WHY THE SHA IS PINNED, AND WHY IT IS NOT A PARAMETER. Every read a review performs
 * must land on the pull request's head commit, never on a branch name (R-W2.4). A
 * reviewer writes a comment against bytes they are looking at; if a force-push moves
 * the branch mid-review, a branch-named read silently returns different bytes and the
 * comment anchors to text nobody ever saw. The obvious way to enforce that — a `ref`
 * argument on every method — enforces nothing, because a branch name is also a string
 * and every call site is a chance to pass one. So the sha is not an argument here at
 * all. It is fixed when the source is constructed and exposed read-only as `headSha`,
 * which is also the fourth operation the LLD names. A source *is* a pull request's tree
 * at one commit; there is no call that could ask it for another. When the head moves,
 * the answer is a new source together with new changed paths (R-W2.5), not a new
 * argument to an old one.
 *
 * WHAT IS DELIBERATELY ABSENT. Nothing here names git, a worktree, a checkout, `gh`, or
 * HTTP. The moment it does, the seam has leaked and the surface starts caring which
 * side it is on. `ReviewSourceKind` is the single exception, and it exists because
 * R-W1.5 requires the reviewer to be *told* which source is live — the host source
 * needs the network per file and cannot work offline, which is a difference a reviewer
 * has to be able to account for. It is a label to report, not a flag to branch on.
 *
 * FAILURES ARE VALUES. Every operation resolves; none rejects. `ReviewSourceFailure`
 * is the vocabulary R-W2.7 demands — no usable credential, could not be read, host
 * unreachable — widened only far enough that the checkout side has somewhere to land
 * too, and stated in terms of what the *reviewer* must do rather than what the
 * mechanism did. `defaultExecGit` discards stderr on purpose (R-1.11), so the checkout
 * side often has nothing but the reason; the adapter side usually has more, and puts it
 * in `detail`, the same way `MountResult` already does.
 *
 * FILE LAYOUT — claimed here so later stories do not collide:
 *   core/collaboration/review-source.ts          — this file: types and contract only
 *   core/collaboration/review-source-worktree.ts — the checkout implementation (1.2)
 *   core/collaboration/review-source-api.ts      — the host implementation (2.2 / 2.3)
 *   core/collaboration/review-source-resolve.ts  — `resolveReviewSource` (1.3)
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 * This file imports nothing at all, which is the strongest form of that promise.
 */

/**
 * Which of the two sources is supplying a review (R-W1.5).
 *
 * `'checkout'` — the files are on disk, already at the head commit.
 * `'host'`     — each read is a round trip to the repository host.
 *
 * Reported to the reviewing surface so it can say so. Not a discriminant to switch on:
 * anything that has to branch on this has found a difference the interface was supposed
 * to have absorbed.
 */
export type ReviewSourceKind = 'checkout' | 'host';

/**
 * Why a read did not produce an answer. Each value is a distinct thing the reader must
 * do about it, which is why they are not collapsed into one `'failed'` — R-W2.7 exists
 * precisely to forbid that collapse.
 *
 * - `no-credential` — there is no usable credential for this repository. The reviewer
 *   must authenticate; retrying will not help.
 * - `not-readable`  — the repository, directory or file could not be read: it is not
 *   there, or this credential may not see it. The reviewer must check the path or
 *   their access.
 * - `unreachable`   — the source itself could not be reached. Transient; retrying is
 *   the reasonable response.
 * - `head-moved`    — the source no longer holds the commit it was pinned to, because
 *   the head moved underneath it. The review must be re-pinned (R-W2.5), not retried.
 *
 * Stated as outcomes, not causes, so that neither side's mechanism shows through: a
 * fetch that failed, a checkout that vanished, a 404 and a 403 all have to land in one
 * of these four, and the surface's recovery text is written once against the four.
 */
export type ReviewSourceFailure = 'no-credential' | 'not-readable' | 'unreachable' | 'head-moved';

/**
 * The shape every operation answers in. Failure is a value, never a throw.
 *
 * `detail` is the part of the answer only the failing call knows — the host's own
 * message, the two commits that disagree. The surface turns `reason` into the sentence
 * that says what to do; `detail` is appended so the reader can see the evidence. It is
 * optional because the checkout side frequently has none to give.
 */
export type ReviewSourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ReviewSourceFailure; detail?: string };

/**
 * One entry of a directory listing, reduced to what a file tree renders.
 *
 * `path` is repo-relative and posix-separated on both sides — the surface uses it as
 * the argument to the next `listDirectory` or `readFile`, so it has to be the same
 * spelling regardless of who produced it.
 */
export type ReviewEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
};

/** A file's contents at the pinned commit, decoded to utf-8. */
export type ReviewFile = {
  /** Repo-relative posix path, as asked for. */
  path: string;
  text: string;
};

/** The paths the pull request changed, repo-relative and posix-separated. */
export type ChangedPathsResult = ReviewSourceResult<readonly string[]>;

/** The entries directly inside one directory. Never recursive — see `listDirectory`. */
export type DirectoryResult = ReviewSourceResult<readonly ReviewEntry[]>;

/** One file's contents at `headSha`. */
export type FileResult = ReviewSourceResult<ReviewFile>;

/**
 * Everything a review needs in order to read a pull request's files, and nothing else.
 *
 * A `ReviewSource` is bound to one pull request at one commit for its whole life. It
 * has no open, no close, and no state the caller has to sequence — the only reason it
 * is an object rather than four loose functions is that the pinning has to live
 * somewhere the caller cannot reach past.
 */
export interface ReviewSource {
  /** Which source this is, for reporting only (R-W1.5). */
  readonly kind: ReviewSourceKind;

  /**
   * The commit every read below lands on. Fixed at construction; there is no call that
   * takes a ref, so there is no call that can read at a branch (R-W2.4).
   */
  readonly headSha: string;

  /** The repo-relative paths this pull request changed (R-W2.1). */
  changedPaths(): Promise<ChangedPathsResult>;

  /**
   * The entries directly inside `path` at `headSha` (R-W2.3). `''` is the repository
   * root.
   *
   * One directory per call, never recursive: that is how a tree expands on click, and
   * it is the only shape both sides can answer cheaply — the checkout would walk a
   * whole subtree it was not asked for, and the host has no recursive endpoint in use
   * here.
   */
  listDirectory(path: string): Promise<DirectoryResult>;

  /**
   * The contents of `path` at `headSha` (R-W2.2), including files this pull request did
   * not change — reading the code *around* a change is most of reviewing it.
   */
  readFile(path: string): Promise<FileResult>;
}
