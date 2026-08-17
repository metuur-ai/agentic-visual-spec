/**
 * review-drafts.ts — where a review comment lives *before* it is on the Pull Request.
 *
 * WHY A DRAFT STATE EXISTS AT ALL. Reviewing a PR is reading a tree and reacting to it;
 * pushing every reaction to GitHub the instant it is typed would mean the author is
 * notified of half-formed thoughts, and the reviewer cannot retract one without leaving
 * a deleted-comment hole. So the product decision is two steps: the reviewer writes
 * locally, then takes one explicit action to publish. This module owns step one and the
 * bookkeeping that makes step two safe. Exactly two states — `draft` and `published` —
 * because a third ("publishing", "failed") would be a job-status, and job status already
 * has a home in `job-hub.ts`.
 *
 * WHY THIS MODULE NEVER TALKS TO GITHUB. Publishing is a network call that can succeed
 * with the response lost, be rate-limited, or be refused by authorization — all of which
 * `github-adapter.ts` and `failure-states.ts` already model. If this module made that
 * call it would have to model them a second time, and the store would become untestable
 * without a network double. Keeping it to bytes on disk means the caller orchestrates
 * "read drafts → post to GitHub → mark published" and the failure of the middle step
 * simply leaves a draft on disk, which is the correct resting state. Same boundary
 * `record-store.ts` draws: the store reads and writes, it does not decide.
 *
 * HOW IDEMPOTENCY IS GUARANTEED (R-2 of the task). The publish action is not idempotent
 * on GitHub's side — POSTing the same body twice creates two comments — so idempotency
 * has to come from here, and it does, three ways:
 *   1. A published record is **never deleted**. It stays in the file with
 *      `status: 'published'` and the id GitHub returned, so the answer to "did this
 *      already go out?" survives restarts, not just the current process.
 *   2. `markDraftPublished` is **first-write-wins**: a second call on an already
 *      published draft returns the stored record untouched and reports
 *      `alreadyPublished: true` rather than overwriting the link. So even a racing pair
 *      of publish jobs leaves exactly one GitHub id on disk.
 *   3. The caller is therefore able to gate the network call on `status === 'draft'`,
 *      read fresh off disk. That gate is what actually prevents the duplicate comment;
 *      (1) and (2) are what make the gate trustworthy.
 * Deliberately *not* done here: a lock file, or a "publishing" reservation state. Both
 * buy protection only against two publishes racing within milliseconds of each other,
 * which needs two humans on one checkout, and both cost a stuck-lock recovery path.
 *
 * WHY `headSha` IS ON EVERY DRAFT. A comment says "this line, here". If the reviewer
 * writes it, the author force-pushes, and the comment is then posted against the new
 * head, GitHub will happily anchor it to whatever now sits at that line — the exact
 * confidently-wrong outcome `review-comments.ts` refuses in the outdated case. Carrying
 * the head the draft was written against lets the caller compare (`isStale`) and stop.
 * This module does not stop it: whether a stale draft is discarded, re-anchored or
 * published anyway is a product decision, and the store's job is to make it visible.
 *
 * SHAPE. A draft is a `CommentRecord` in all but name — same `target` (path, kind,
 * startLine/endLine, snippet, heading), same `comment`, same `ts` — so the UI and the
 * projection code path already know how to render one. The id uses a `d-` prefix rather
 * than `c-`: `c-<8hex>` is a *bijection* onto a GitHub comment integer
 * (`reviewRecordIdFor`), and minting random ids into that space would let a local draft
 * collide with a projected review thread and be mistaken for one.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-12.6 / R-12.6a, guarded by `core/bundle-guard.test.ts`).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { CommentTarget } from '../editing/comment-doc';
import type { RepoRef } from './github-adapter';
import { ensureIgnored } from './worktree';

/** Where review drafts live, relative to the served directory. Ignored by `ensureIgnored`. */
export const REVIEW_DRAFT_DIR = '.visual-spec/reviews';

/**
 * Which pull request's held comments a call is about (R-W3.6).
 *
 * WHY THE REPOSITORY IS PART OF THE ADDRESS AND NOT A FIELD ON A DRAFT. Drafts used to
 * live at `<servedDir>/.visual-spec/reviews/pr-<n>.json`, keyed by the number alone, which
 * was safe exactly as long as there was one repository to review. Under repository-scoped
 * review two repositories' #42 would share one file — one reviewer's comments on one
 * project appearing in another's review, and, worse, `markDraftPublished`'s
 * first-write-wins seeing a draft id from a pull request it was never about. Recording the
 * repository inside the file would not have helped: the collision is the FILE, and a
 * filter applied after reading it still leaves two writers on one path.
 *
 * `adoptLegacy` — SEE `legacyDraftsPath` FOR THE FULL ARGUMENT. It is the caller saying
 * "this repository is the one the pre-scoping file was written for", which only the layer
 * that knows the configured repository can say.
 */
export type ReviewDraftScope = {
  /** The served directory. The drafts file is always inside it, as it always was. */
  baseDir: string;
  /** The repository the pull request belongs to. */
  repo: RepoRef;
  /** Whether this repository may claim the pre-scoping `pr-<n>.json`. Default `false`. */
  adoptLegacy?: boolean;
};

/** `draft` — local only. `published` — on the PR, and never removed from the file. */
export type ReviewDraftStatus = 'draft' | 'published';

/** What GitHub answered when the draft was posted. Present iff `status === 'published'`. */
export type PublishedMarker = {
  /** The REST integer id — the same id space `review-comments.ts` joins on. */
  reviewCommentId: number;
  /** Permalink, so the UI can send the reviewer to their own comment. */
  htmlUrl: string;
  /** When this store recorded the publish, not when GitHub created it. */
  ts: string;
};

/**
 * One locally-drafted review comment.
 *
 * `target` is the `CommentTarget` from `comment-doc.ts` verbatim rather than a private
 * anchor shape, so a draft renders through the same components as a projected thread.
 */
export type ReviewDraft = {
  id: string; // d-<8hex>
  pullNumber: number;
  /** The PR head this was written against — see the header on why it is mandatory. */
  headSha: string;
  target: CommentTarget;
  comment: string;
  status: ReviewDraftStatus;
  ts: string;
  published?: PublishedMarker;
};

/** What a caller supplies to create a draft; everything else the store mints. */
export type ReviewDraftInput = {
  /** Posix path relative to the worktree root — the path GitHub expects on the PR. */
  path: string;
  /** 1-indexed. Omit for a file-level comment (`subject_type: file` on GitHub). */
  startLine?: number;
  /** 1-indexed last line of a range. Omit for a single line. */
  endLine?: number;
  snippet?: string;
  heading?: string | null;
  comment: string;
  headSha: string;
};

/** The persisted file. `version` so a later shape change can be read, not guessed at. */
type DraftFile = { version: 1; pullNumber: number; drafts: ReviewDraft[] };

/**
 * Refuse a pull number that is not one.
 *
 * Same guard, same reason, as `worktree.ts`: `pullNumber` arrives from a request body and
 * is interpolated into a filesystem path, where `-1` or a fractional value would produce
 * a filename nothing else in the system can find, and a crafted value could try to leave
 * the directory. Kept as its own function rather than imported so this module's path
 * construction is checkable in one place.
 */
function assertPullNumber(pullNumber: number): void {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error(`invalid pullNumber: ${String(pullNumber)}`);
  }
}

/**
 * Refuse a target path that would escape the worktree root — the `safeJoin` check from
 * `record-store.ts`, applied at write time.
 *
 * The path is never joined here (this module only writes it into JSON), but it *is* joined
 * by whoever opens the file the comment points at. Validating on the way in means the
 * traversal is rejected once, where the user can be told, instead of at every read.
 */
function assertRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\0')) {
    throw new Error(`invalid path: ${path}`);
  }
  const base = resolve('/base');
  const full = resolve(base, path);
  if (!full.startsWith(base + sep)) throw new Error(`invalid path: ${path}`);
}

/**
 * Refuse an owner or a repository name that is not one.
 *
 * Same guard and same reason as `assertPullNumber` above, and stated here rather than
 * borrowed from the route layer for the reason that one is: both halves of this module's
 * path construction have to be checkable in one place. The route validates the identifier
 * as it arrives off the wire (R-W3.7); this validates it as it becomes a directory name,
 * which is a different obligation with a different blast radius — a caller that is not a
 * route still cannot make this module write outside `REVIEW_DRAFT_DIR`.
 *
 * Deliberately an allowlist, and `.` and `..` are named: both satisfy the character set
 * and neither is a repository, and they are the two spellings that mean something to a
 * path resolver.
 */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

function assertRepoSegment(what: string, value: string): void {
  if (!REPO_SEGMENT_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid ${what}: ${value}`);
  }
}

/** Relative path of the drafts file for a pull request of one repository (R-W3.6). */
export function reviewDraftsRelPath(repo: RepoRef, pullNumber: number): string {
  assertPullNumber(pullNumber);
  assertRepoSegment('owner', repo.owner);
  assertRepoSegment('repo', repo.repo);
  return `${REVIEW_DRAFT_DIR}/${repo.owner}/${repo.repo}/pr-${pullNumber}.json`;
}

/**
 * Where drafts lived before a review named its repository.
 *
 * MIGRATION, DECIDED EXPLICITLY. Doing nothing was the cheapest option and is wrong: the
 * file also holds `published` records, and those are what stops a comment being posted to
 * GitHub a second time (R-13.16). Abandoning them does not lose bytes — the file stays on
 * disk — but it does lose the answer to "did this already go out?", so an upgrade would
 * silently re-arm every duplicate the guard exists to prevent.
 *
 * So the file is ADOPTED: on the first read that finds no repository-scoped file, it is
 * renamed into place. A rename rather than a copy, so it happens once and there is never a
 * second, diverging copy of the same drafts; and never an overwrite, so a scoped file that
 * already exists always wins.
 *
 * IT IS ADOPTED BY THE CONFIGURED REPOSITORY AND NO OTHER. The legacy file was written
 * when exactly one repository could be reviewed — the configured one — so its drafts
 * belong to that repository as a matter of fact. Letting whichever repository asked first
 * claim them would be inventing provenance, and it would put one project's review comments
 * into another project's review, which is the exact failure R-W3.6 exists to prevent. Only
 * the caller knows which repository is configured, so only the caller can say so.
 */
function legacyDraftsPath(baseDir: string, pullNumber: number): string {
  return join(baseDir, `${REVIEW_DRAFT_DIR}/pr-${pullNumber}.json`);
}

/**
 * The file a call reads or writes, adopting the pre-scoping one first when this repository
 * is entitled to it and nothing has been written under the new name yet.
 */
async function draftsPath(scope: ReviewDraftScope, pullNumber: number): Promise<string> {
  const path = join(scope.baseDir, reviewDraftsRelPath(scope.repo, pullNumber));
  if (!scope.adoptLegacy) return path;
  // `rename` REPLACES its destination on POSIX, so the scoped file has to be shown absent
  // before the legacy one may take its place — otherwise a stale pre-scoping file would
  // silently overwrite drafts written since. The check and the rename are not atomic
  // together, which is acceptable here and nowhere near the idempotency guarantee: both
  // racers are this process, both would be adopting the same bytes, and the loser's
  // rename simply lands on a file identical to the one it replaced.
  if ((await readFileOrNull(path)) !== null) return path;
  const legacy = await readFileOrNull(legacyDraftsPath(scope.baseDir, pullNumber));
  if (legacy === null) return path;
  await mkdir(dirname(path), { recursive: true });
  await rename(legacyDraftsPath(scope.baseDir, pullNumber), path);
  return path;
}

/** A local draft id. `d-` so it can never be read as a `c-<8hex>` GitHub comment id. */
function newDraftId(): string {
  return `d-${randomBytes(4).toString('hex')}`;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Every draft recorded for a PR, in creation order, published ones included.
 *
 * A PR nobody has commented on has no file, and that is not an error — it is the normal
 * first read. Resolves `[]` rather than throwing, so callers do not each reinvent the
 * ENOENT branch (`record-store.list` takes the same position).
 */
export async function readReviewDrafts(scope: ReviewDraftScope, pullNumber: number): Promise<ReviewDraft[]> {
  const raw = await readFileOrNull(await draftsPath(scope, pullNumber));
  if (raw === null || !raw.trim()) return [];
  const parsed = JSON.parse(raw) as Partial<DraftFile>;
  return Array.isArray(parsed.drafts) ? parsed.drafts : [];
}

async function writeReviewDrafts(scope: ReviewDraftScope, pullNumber: number, drafts: ReviewDraft[]): Promise<void> {
  const path = await draftsPath(scope, pullNumber);
  // Before the first write, not after: a `.visual-spec/` git sees is untracked noise in
  // `git status`, and the reviewer's own comments are the last thing that should show up
  // there. `ensureIgnored` is idempotent, so paying it per write costs one read.
  await ensureIgnored(scope.baseDir);
  await mkdir(dirname(path), { recursive: true });
  const file: DraftFile = { version: 1, pullNumber, drafts };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Build the `CommentTarget` for an input. `kind` follows from whether a line was given. */
function targetFor(input: ReviewDraftInput): CommentTarget {
  assertRelativePath(input.path);
  if (input.startLine === undefined) {
    const target: CommentTarget = { path: input.path, kind: 'file' };
    if (input.snippet) target.snippet = input.snippet;
    if (input.heading !== undefined) target.heading = input.heading;
    return target;
  }
  const target: CommentTarget = { path: input.path, kind: 'range', startLine: input.startLine };
  // A range whose end equals its start is a single line; carrying `endLine` anyway would
  // make two spellings of the same anchor, and `anchorLabelOf` already treats them alike.
  if (input.endLine !== undefined && input.endLine !== input.startLine) target.endLine = input.endLine;
  if (input.snippet) target.snippet = input.snippet;
  if (input.heading !== undefined) target.heading = input.heading;
  return target;
}

/** Append a draft to a PR's file and return it, id and timestamp minted. */
export async function addReviewDraft(
  scope: ReviewDraftScope,
  pullNumber: number,
  input: ReviewDraftInput,
): Promise<ReviewDraft> {
  assertPullNumber(pullNumber);
  const draft: ReviewDraft = {
    id: newDraftId(),
    pullNumber,
    headSha: input.headSha,
    target: targetFor(input),
    comment: input.comment,
    status: 'draft',
    ts: new Date().toISOString(),
  };
  const drafts = await readReviewDrafts(scope, pullNumber);
  await writeReviewDrafts(scope, pullNumber, [...drafts, draft]);
  return draft;
}

/** What `markDraftPublished` answered. `alreadyPublished` is the idempotency signal. */
export type MarkPublishedResult = {
  draft: ReviewDraft;
  /** `true` ⇒ nothing was written; the stored marker is the one from the first publish. */
  alreadyPublished: boolean;
};

/**
 * Record that a draft is now on the PR.
 *
 * First-write-wins: calling this on an already-published draft is not an error and does
 * not touch the file — it returns the stored record with `alreadyPublished: true`. That
 * makes a retried publish job safe to run, and makes the on-disk link to GitHub stable
 * once written. See the header for the full idempotency argument.
 *
 * Throws for an unknown id, because that is a caller bug — a draft it just read no longer
 * exists — and silently doing nothing would hide it behind a successful-looking publish.
 */
export async function markDraftPublished(
  scope: ReviewDraftScope,
  pullNumber: number,
  id: string,
  published: Omit<PublishedMarker, 'ts'>,
): Promise<MarkPublishedResult> {
  assertPullNumber(pullNumber);
  const drafts = await readReviewDrafts(scope, pullNumber);
  const existing = drafts.find((d) => d.id === id);
  if (!existing) throw new Error(`unknown draft: ${id}`);
  if (existing.status === 'published') return { draft: existing, alreadyPublished: true };

  const updated: ReviewDraft = {
    ...existing,
    status: 'published',
    published: { ...published, ts: new Date().toISOString() },
  };
  await writeReviewDrafts(
    scope,
    pullNumber,
    drafts.map((d) => (d.id === id ? updated : d)),
  );
  return { draft: updated, alreadyPublished: false };
}

/**
 * Delete an unpublished draft. `false` when there was no such id — "already gone" is a
 * normal outcome, the same answer `unmountPullRequest` gives.
 *
 * Throws when the draft is published. Removing it would delete the only record that the
 * comment went out, which is precisely the record idempotency rests on; the comment
 * itself would still be on GitHub, so the deletion would not even mean what it looks
 * like. Withdrawing a published comment is a GitHub operation and belongs to the caller.
 */
export async function deleteReviewDraft(scope: ReviewDraftScope, pullNumber: number, id: string): Promise<boolean> {
  assertPullNumber(pullNumber);
  const drafts = await readReviewDrafts(scope, pullNumber);
  const existing = drafts.find((d) => d.id === id);
  if (!existing) return false;
  if (existing.status === 'published') throw new Error(`cannot delete a published draft: ${id}`);
  await writeReviewDrafts(
    scope,
    pullNumber,
    drafts.filter((d) => d.id !== id),
  );
  return true;
}

/**
 * Was this draft written against a different head than the one now checked out?
 *
 * The whole of the staleness policy this module holds: it answers the question and stops.
 * A caller that publishes a stale draft anyway is making a choice; one that publishes it
 * without asking is making a mistake it cannot see.
 */
export function isStale(draft: ReviewDraft, headSha: string): boolean {
  return draft.headSha !== headSha;
}
