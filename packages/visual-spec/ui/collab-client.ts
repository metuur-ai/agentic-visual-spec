/**
 * collab-client.ts — the one place the browser talks to `/__vs/collab/*` (R-7.1, R-7.7).
 *
 * Before this module the only two calls that existed were inline in
 * `collab-open-panel.tsx` (`GET /__vs/collab`, `POST /__vs/collab/open`), each with its
 * own ad-hoc `res.ok` handling. Every other route the server wires was unreachable from
 * the browser. This centralizes all of them behind one typed surface.
 *
 * IT RETURNS FAILURES, IT DOES NOT THROW THEM. Four of this API's failure modes are
 * ordinary states of a working system, not exceptions:
 *
 *   - **409** — a job is already running for the document (R-8.1: one job per document,
 *     a second request is rejected rather than queued). The caller's answer is to wait
 *     for `job-done` and retry, which it cannot do from inside a `catch`. On the comment
 *     routes the same status means "no pull request yet"; the caller knows which route
 *     it called, so one `conflict` kind carries both with the server's own words.
 *   - **503** — collaboration is off (R-7.8). The body is the `CollabAvailability`
 *     snapshot the UI already renders, so it is handed back intact rather than reduced
 *     to a message.
 *   - **401/403** — the credential the *server* holds cannot do this (R-11.5).
 *   - **404** — the document (or comment) is unknown.
 *
 * THE ERROR TEXT IS THE SERVER'S OWN (R-11.4). Every route answers `{ error }`, except
 * the 503 which answers the availability snapshot carrying `message`. Nothing here
 * rewrites either into a generic string.
 *
 * IT IMPORTS ONLY TYPES FROM `core/`. `import type` is erased at build time, so no
 * `node:fs` reaches the browser bundle through `job-hub.ts`; the shapes are still the
 * server's, declared once.
 */
import type { AwaitingItem, AwaitingMention, PullRequestListState, PullRequestSummary } from '../core/collaboration/github-adapter';
import type { Awaiting, AwaitingSide } from '../core/vite/routes/collab';
import type { JobEvent, JobKind, JobSnapshot, JobSync } from '../core/collaboration/job-hub';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
import type { ReviewDraft } from '../core/collaboration/review-drafts';
import type { ReviewEntry, ReviewSourceKind } from '../core/collaboration/review-source';
import type { MountedWorktree } from '../core/collaboration/worktree';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { CommentPatch } from '../core/vite/routes/comments';
import type { CollaborationRecord, GitHubBinding } from '../core/collaboration/document-record';

// Re-exported so a component can name what it renders without reaching into `core/`
// itself — the same courtesy `collab-open-panel.tsx` already takes with the
// availability snapshot. These are the server's shapes, declared once, over there.
export type { MountedWorktree, PullRequestListState, PullRequestSummary, ReviewDraft, ReviewEntry, ReviewSourceKind };
// The `/pulls/awaiting` shapes travel the same way. A chip that renders a count and a
// panel section that renders its rows are both browser modules; neither should have to
// name `core/vite/routes/` to type what it was handed.
export type { Awaiting, AwaitingItem, AwaitingMention, AwaitingSide };

/** Root of the route family. Not configurable — the server mounts it at one path. */
const BASE = '/__vs/collab';

/** The `CollabAvailability` shape `GET /__vs/collab` serves (`core/vite/routes/collab.ts`). */
export type CollabAvailabilitySnapshot =
  | {
      available: true;
      login: string;
      repo: { owner: string; repo: string; baseBranch?: string };
      scopes?: readonly string[];
      /** R-9.7 write access as a display hint. Absent = the server could not determine it. */
      canPublish?: boolean;
      /**
       * R-12.5 — present only alongside `canPublish: false`, naming *why* this session
       * cannot publish so the author meets it on the first screen instead of at publish
       * time. `no_repo` in particular is a config error no later step would explain.
       */
      publishBlocked?: { reason: 'no_write_access' | 'no_repo'; message: string };
    }
  | { available: false; reason: string; message: string; missingScopes?: readonly string[] };

/**
 * What every job-starting route answers on success (`DocumentJobHub.start`). `jobId` is
 * what the SSE frames carry, so the caller can tell its own job's frames from another
 * tab's. `deduplicated` is R-8.23: the idempotency key matched a prior job and *no new
 * job was started*.
 */
export type JobAccepted = {
  ok: true;
  jobId: string;
  kind: JobKind;
  deduplicated?: boolean;
  running?: boolean;
};

/**
 * `GET /__vs/collab/:id` — the R-8.4 recovery snapshot plus the document's identity.
 *
 * The document here is a *summary*, not a `CollaborationRecord`: the route projects four
 * fields and drops the Markdown, because this body is also the SSE `sync` frame. The
 * rendering surfaces want the bytes and get them from `document()` below.
 */
export type CollabDocumentSummary = {
  documentId: string;
  documentPath: string;
  title: string;
  github: GitHubBinding | null;
};

export type CollabDocumentStatus = JobSnapshot & { document: CollabDocumentSummary | null };

/**
 * What the comment routes answer. `PATCH` answers without an `id`.
 *
 * `degraded` is R-7.13's disclosure: the line the user selected is not part of the Pull
 * Request's diff, so the server retried once as a file-level comment. The comment exists
 * and nothing the user typed was lost — but it now hangs off the file rather than the
 * line, and the panel has to say so instead of pretending the anchor is what was asked
 * for. `reason` is GitHub's own refusal text.
 */
export type CommentSaved = {
  ok: true;
  id: string;
  comment: ReviewThreadRecord;
  degraded?: { to: 'file'; reason: string };
};
export type CommentUpdated = { ok: true; comment: CommentRecord };

/**
 * What `POST /:id/comments` takes (R-0.3 — a comment is anchored by path and line).
 *
 * `path` may be omitted for the document under review; the server fills in the
 * document's own path. `startLine` may be omitted for a document-level comment, which is
 * posted against the file by intent rather than by degradation.
 *
 * `selectedText` is what R-7.12 quotes back into a file-level body, and it can only come
 * from here: the browser holds the selection, and the server re-reading the branch to
 * guess at it would be a second, disagreeing answer to what the user picked.
 */
export type AddCommentInput = Idempotent & {
  comment: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
  workflow?: string;
};

/**
 * `GET /__vs/collab/pulls/:n/files` — what the Pull Request changed (R-13.11).
 *
 * The head is named by **sha**, never by branch: a fork's head branch does not exist on
 * this repository, and the route compares `baseBranch...headSha` for exactly that reason.
 * `files` are repo-relative paths between the merge base and the head, which is the set a
 * review opens on; everything else in the checkout is reachable but not listed here.
 */
export type PullRequestChangedFiles = {
  pullNumber: number;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  /** The branch point the changed paths were computed against. */
  mergeBaseSha: string;
  files: string[];
};

/**
 * `GET /__vs/collab/pulls/:n/tree?path=` — the entries directly inside one directory of
 * the pull request's tree, at the commit the review is pinned to.
 *
 * ONE DIRECTORY, NEVER A WALK. `ReviewSource.listDirectory` answers one directory per
 * call on both sides, and the route is that call. The reviewing surface asks for a
 * directory when the reviewer opens it and at no other time, so a repository with fifty
 * thousand files costs one listing to browse into rather than a full walk to display.
 */
export type PullRequestTree = {
  pullNumber: number;
  headSha: string;
  /** The directory that was listed. `''` is the repository root. */
  path: string;
  entries: readonly ReviewEntry[];
};

/**
 * `GET /__vs/collab/pulls/:n/raw?path=` — one file's contents at the pinned commit,
 * including a file the pull request did not change (R-W2.2).
 */
export type PullRequestFile = { pullNumber: number; headSha: string; path: string; text: string };

/**
 * A review that has been opened: where its files come from, the commit they are read at,
 * and — only where there is one — the checkout on this disk.
 *
 * `source` IS FOR SAYING, NOT FOR SWITCHING (R-W1.5). The two sources differ in one thing
 * a reviewer can feel: a `'host'` review fetches every file it opens over the network and
 * cannot be read offline, while a `'checkout'` one, once mounted, can. That is why the
 * kind travels to the browser at all. Nothing on the reviewing surface may read, order or
 * render differently because of it — the seam exists precisely so it does not have to.
 *
 * `headSha` is the commit the whole review is pinned to (R-W2.4), and it is here rather
 * than only on `worktree` because it is what a held comment is stamped with: a review
 * with no checkout still has a commit, and still holds comments against it.
 */
export type OpenedReview = {
  source: ReviewSourceKind;
  headSha: string;
  /**
   * Absent when the review is supplied by the repository host rather than by a checkout
   * (R-W1.3): the served directory is not a git working tree, or has no origin, so there
   * is no path on this disk to report. Its absence is not a failure and never was — it is
   * simply a review with no working copy.
   */
  worktree?: MountedWorktree;
};

/** `POST /__vs/collab/pulls/:n/mount` — R-13.3 / R-W1.5, the review the server opened. */
export type WorktreeMounted = { ok: true } & OpenedReview;

/**
 * `DELETE /__vs/collab/pulls/:n/mount`. `removed: false` is not a failure — it is
 * "nothing was mounted", which is the state the caller asked for either way.
 */
export type WorktreeRemoved = { ok: true; removed: boolean };

/**
 * What `POST /__vs/collab/pulls/:n/drafts` takes (R-13.13).
 *
 * `path` is relative to the *checkout root*, which is the path the pull request names —
 * not the served-directory path the tree walk browses with. `headSha` is mandatory
 * because a held comment says "this line, at this commit", and R-13.14's staleness check
 * is the comparison of it against the head at publish time.
 */
export type ReviewDraftInput = {
  path: string;
  comment: string;
  headSha: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  heading?: string | null;
};

/** `POST /pulls/:n/drafts` — the record as it landed on disk, id and timestamp minted. */
export type ReviewDraftSaved = { ok: true; draft: ReviewDraft };

/** `DELETE /pulls/:n/drafts/:id`. `removed: false` is "there was no such draft". */
export type ReviewDraftRemoved = { ok: true; removed: boolean };

/**
 * `POST /pulls/:n/drafts/:id/publish` — R-13.16 / R-13.17.
 *
 * `alreadyPublished` is not a failure: the comment is on the pull request and the stored
 * link is the first publisher's. `degraded` is R-7.13's disclosure, reaching this route
 * through the same policy the document comments use.
 */
export type ReviewDraftPublished = {
  ok: true;
  alreadyPublished?: boolean;
  draft: ReviewDraft;
  comment?: ReviewThreadRecord;
  degraded?: { to: 'file'; reason: string };
};

/**
 * Expected failures, kept apart from thrown ones. `status` is the server's, so a caller
 * that wants to log the raw code still can.
 */
export type CollabFailure =
  /** 503 — collaboration is off (R-7.8); the payload is the snapshot the UI renders. */
  | { ok: false; kind: 'unavailable'; status: 503; availability: CollabAvailabilitySnapshot; message: string }
  /** 401 / 403 — the server's credential may not do this. */
  | { ok: false; kind: 'forbidden'; status: number; message: string }
  /** 404 — unknown document, unknown comment, or no such route. */
  | { ok: false; kind: 'not-found'; status: number; message: string }
  /**
   * 409 — a job is already running, or (comment routes) there is no pull request yet, or
   * (the draft routes) the state named by `reason` forbids what was asked.
   *
   * `reason` and the two shas are carried verbatim when the server sends them, and are
   * absent otherwise. They are what lets a caller tell R-13.14's `stale-draft` — which
   * has an answer, `force: true` — from R-13.17's `already-published`, which is not a
   * failure the reviewer caused and is answered with a link rather than a retry. Reducing
   * either to `message` would leave the UI parsing prose to decide which one it got.
   */
  | {
      ok: false;
      kind: 'conflict';
      status: 409;
      message: string;
      reason?: string;
      draftHeadSha?: string;
      currentHeadSha?: string;
    }
  /** 400 — a malformed request; the route layer's own validation. */
  | { ok: false; kind: 'bad-request'; status: 400; message: string }
  /** `fetch` rejected, or the body was not JSON. Nothing reached the route layer. */
  | { ok: false; kind: 'network'; message: string }
  /** Anything else the server answered — 500, 501, an unmapped code. */
  | { ok: false; kind: 'server'; status: number; message: string };

export type CollabResult<T> = { ok: true; value: T } | CollabFailure;

/** Bodies that start a job all accept R-8.23's key. */
type Idempotent = { idempotencyKey?: string };

export type StartDocumentInput = Idempotent & {
  documentId: string;
  documentPath: string;
  title?: string;
  /** R-0.1 — the document itself. Committed to the branch verbatim by the create job. */
  markdown?: string;
  /**
   * R-8.27 — the whole selection, the open file included. The server treats the entry
   * matching `documentPath` as the document rather than as a companion (R-8.30), so a
   * caller sends its selection as it stands and does not have to subtract the primary.
   * Omitted entirely for a single-file start, which behaves exactly as before (R-8.28).
   */
  files?: { path: string; markdown: string }[];
};

export type OpenDocumentInput = Idempotent & {
  documentId: string;
  pullNumber: number;
  discardLocal?: boolean;
  /**
   * R-W4.1 — the repository the reference named, when it named one. It travels in the
   * PATH (`/__vs/collab/repos/:owner/:repo/open`) and never in the body: the server takes
   * the repository from the path for every request that reviews a pull request, and a body
   * field would be a second, quieter way to say the same thing that a forgetful caller
   * could omit into a wrong-repository open. Absent is R-W4.2 — the legacy form, which
   * applies the configured repository.
   */
  repo?: { owner: string; repo: string };
};

/**
 * R-8.9 — `markdown` is the whole payload, and the route requires it *before* it checks
 * authorization. Markdown is the document (R-0.1), so publish commits one artifact and
 * there is no structured half to send beside it.
 */
export type PublishInput = Idempotent & { markdown: string };

export interface CollabClient {
  /** `GET /__vs/collab` — R-7.8 availability + the login comments will be attributed to. */
  availability(): Promise<CollabResult<CollabAvailabilitySnapshot>>;
  /** `POST /__vs/collab/start` — R-8.5, create the branch + pull request. */
  start(input: StartDocumentInput): Promise<CollabResult<JobAccepted>>;
  /**
   * `POST /__vs/collab/open` — attach to a pull request that already exists.
   *
   * With `input.repo` it is `POST /__vs/collab/repos/:owner/:repo/open` instead (R-W4.1),
   * which is the same route family the review reads through and is the only document route
   * the repository-scoped form reaches. Without it the legacy path stands, and the server
   * applies the repository it was started for (R-W4.2).
   */
  open(input: OpenDocumentInput): Promise<CollabResult<JobAccepted>>;
  /** `GET /__vs/collab/:id` — R-8.4, what a late subscriber recovers from. */
  status(documentId: string): Promise<CollabResult<CollabDocumentStatus>>;
  /**
   * `GET /__vs/collab/:id/document` — R-7.3 / R-7.9, the record carrying the Markdown as
   * it stands on the Pull Request branch. Separate from `status()` because that body
   * doubles as the SSE `sync` frame.
   */
  document(documentId: string): Promise<CollabResult<CollaborationRecord>>;
  /**
   * `GET /__vs/collab/:id/comments` — R-5.7 / R-6.5, the conversation, unfiltered.
   *
   * The Pull Request's review threads, projected onto `CommentRecord` (R-5.16) with
   * GitHub's own resolution state joined on (R-5.12). A thread whose `github.isResolved`
   * is absent is one whose resolution could not be read — not one that is unresolved
   * (R-5.15). Replies ride on their thread's record; none is a record of its own (R-5.20).
   */
  comments(documentId: string): Promise<CollabResult<ReviewThreadRecord[]>>;
  /** `POST /__vs/collab/:id/sync` — R-8.6 / R-8.7, pull the PR's comments. */
  sync(documentId: string, input?: Idempotent): Promise<CollabResult<JobAccepted>>;
  /** `POST /__vs/collab/:id/publish` — R-8.9 … R-8.14. */
  publish(documentId: string, input: PublishInput): Promise<CollabResult<JobAccepted>>;
  /**
   * `POST /__vs/collab/:id/comments` — R-5.4 / R-7.5, a PR review comment on the
   * document's path at the selected line range. May answer `degraded` (R-7.13).
   */
  addComment(documentId: string, input: AddCommentInput): Promise<CollabResult<CommentSaved>>;
  /**
   * `POST /__vs/collab/:id/comments/:commentId/reply` — R-7.15. The reply is native and
   * inherits the thread's anchor; `commentId` is the thread root's record id.
   */
  replyToComment(documentId: string, commentId: string, input: { comment: string }): Promise<CollabResult<CommentSaved>>;
  /** `PATCH /__vs/collab/:id/comments/:commentId`. */
  patchComment(documentId: string, commentId: string, patch: CommentPatch): Promise<CollabResult<CommentUpdated>>;
  /**
   * `GET /__vs/collab/pulls?state=` — R-13.1 / R-13.2, the repository's Pull Requests.
   *
   * A read: listing needs no write access, so a reviewer's credential lists exactly what
   * an author's does. The route answers `{ pulls }`; the envelope is unwrapped here so no
   * component has to know it existed.
   */
  pullRequests(state?: PullRequestListState): Promise<CollabResult<PullRequestSummary[]>>;
  /**
   * `GET /__vs/collab/pulls/mounted` — R-13.8, which Pull Requests are checked out.
   *
   * Answered from git's own worktree registry, so a checkout made by a previous run of
   * the server — or removed by hand — is reported correctly. The `path` is the one git
   * reports, which is what makes "is this one already mounted?" a path comparison.
   */
  mountedPullRequests(): Promise<CollabResult<MountedWorktree[]>>;
  /**
   * `GET /__vs/collab/pulls/awaiting` — the two counts of pull requests waiting on *me*
   * (R-A1.1 / R-A1.2), and the pull requests behind them (R-A3.1).
   *
   * TAKES NO ARGUMENTS, AND A LOGIN LEAST OF ALL (R-A2.4). The availability snapshot is
   * visible to this process, so an identity sent from here would be spoofable and would
   * be a qualifier-injection vector into the search `q`. The server counts whoever its
   * own session is; there is nothing for a caller to choose.
   *
   * The body is not an envelope, so nothing is projected off it: each side of it is a
   * separate answer that can be `{ ok: false }` while the other succeeded (R-A4.4), and
   * `total` is the query's own total rather than `items.length` (R-A2.10). A caller
   * retains its last known value for a side that failed — which is why a failed side is
   * a 200 carrying `ok: false` and not an error the whole read has to be judged by.
   */
  awaitingPullRequests(): Promise<CollabResult<Awaiting>>;
  /**
   * `POST /__vs/collab/pulls/:n/mount` — R-13.3 … R-13.7, materialise the Pull Request's
   * tree locally, detached, without touching the served directory's working copy.
   *
   * R-13.9's four causes arrive as ordinary failures with the server's own sentence:
   * `409` for "not a git repository" and "no origin remote", `502` for a fetch that did
   * not land, `500` for a checkout git refused. Each is a different thing for the
   * reviewer to do, which is why none of them is flattened here.
   */
  mountPullRequest(pullNumber: number): Promise<CollabResult<WorktreeMounted>>;
  /** `DELETE /__vs/collab/pulls/:n/mount` — drop the checkout and its private ref. */
  unmountPullRequest(pullNumber: number): Promise<CollabResult<WorktreeRemoved>>;
  /** `GET /__vs/collab/pulls/:n/files` — R-13.11, the review's entry point. */
  pullRequestFiles(pullNumber: number): Promise<CollabResult<PullRequestChangedFiles>>;
  /**
   * `GET /__vs/collab/pulls/:n/tree?path=` — one directory of the review's tree (R-W2.3).
   *
   * `''` is the repository root. Called once per directory the reviewer opens, which is
   * the only shape both sources can answer cheaply — see `ReviewSource.listDirectory`.
   */
  pullRequestTree(pullNumber: number, path: string): Promise<CollabResult<PullRequestTree>>;
  /**
   * `GET /__vs/collab/pulls/:n/raw?path=` — one file of the review (R-W2.2).
   *
   * The pair above is the whole read path of a review, and it is the same pair whichever
   * source is live: the route reads through the resolved `ReviewSource`, so a reviewer
   * with no checkout on disk reads exactly what a reviewer with one reads (R-W1.4).
   */
  pullRequestFile(pullNumber: number, path: string): Promise<CollabResult<PullRequestFile>>;
  /**
   * `GET /__vs/collab/pulls/:n/description` — what the pull request says it is.
   *
   * Its own call rather than a field on the listing: bodies are unbounded prose, and most
   * rows in a listing are never opened. `''` is a real answer (no description written).
   */
  pullRequestDescription(pullNumber: number): Promise<CollabResult<string>>;
  /**
   * `GET /__vs/collab/pulls/:n/drafts` — R-13.13 / R-13.17, everything held for this
   * pull request, **published records included**. The published ones are how the UI can
   * say a comment is on the pull request rather than leaving the reviewer to infer it
   * (R-13.18); dropping them here would make that impossible one layer up.
   */
  reviewDrafts(pullNumber: number): Promise<CollabResult<ReviewDraft[]>>;
  /**
   * `GET /__vs/collab/pulls/:n/comments` — the pull request's review conversation as
   * GitHub has it: every thread on every changed file, roots and replies.
   *
   * The counterpart to `reviewDrafts`, and not a replacement for it. Drafts are what this
   * machine holds and has sent; this is what is actually on the pull request, including
   * everything written on github.com or by somebody else. A surface that reads only the
   * first shows a reviewer their own words and calls it the conversation.
   */
  reviewComments(pullNumber: number): Promise<CollabResult<ReviewThreadRecord[]>>;
  /**
   * `POST /__vs/collab/pulls/:n/comments/:commentId/reply` — R-7.15 from the pull request
   * surface, where the thread came from `reviewComments` and there is no document id to
   * route by. `commentId` is the thread root's record id, as listed.
   */
  replyToReviewComment(
    pullNumber: number,
    commentId: string,
    input: { comment: string },
  ): Promise<CollabResult<CommentSaved>>;
  /** `POST /__vs/collab/pulls/:n/drafts` — R-13.13, hold a comment locally. No GitHub call. */
  holdReviewDraft(pullNumber: number, input: ReviewDraftInput): Promise<CollabResult<ReviewDraftSaved>>;
  /** `DELETE /__vs/collab/pulls/:n/drafts/:id` — drop a held comment. 409 once published. */
  discardReviewDraft(pullNumber: number, draftId: string): Promise<CollabResult<ReviewDraftRemoved>>;
  /**
   * `POST /__vs/collab/pulls/:n/drafts/:id/publish` — R-13.14 … R-13.17.
   *
   * `force` is the reviewer's answer to a `stale-draft` 409 and nothing else: it is never
   * sent on the first attempt, because publishing against a moved head without being
   * asked is exactly what R-13.14 refuses.
   */
  publishReviewDraft(
    pullNumber: number,
    draftId: string,
    input?: { force?: boolean },
  ): Promise<CollabResult<ReviewDraftPublished>>;
  /** The URL of the R-8.2 event stream, for whoever opens the `EventSource`. */
  eventsUrl(documentId: string): string;
}

/** The 503 body is the availability snapshot; every other failure body is `{ error }`. */
function failureOf(status: number, body: unknown): CollabFailure {
  const json = (body ?? {}) as {
    error?: string;
    message?: string;
    reason?: string;
    draftHeadSha?: string;
    currentHeadSha?: string;
  };
  const message = json.error ?? json.message ?? `HTTP ${status}`;
  if (status === 503) {
    return { ok: false, kind: 'unavailable', status: 503, availability: body as CollabAvailabilitySnapshot, message };
  }
  if (status === 401 || status === 403) return { ok: false, kind: 'forbidden', status, message };
  if (status === 404) return { ok: false, kind: 'not-found', status, message };
  if (status === 409) {
    // Spread conditionally: a 409 from the job routes carries none of these, and adding
    // three `undefined` keys to every one of them would change a shape callers compare.
    return {
      ok: false,
      kind: 'conflict',
      status: 409,
      message,
      ...(typeof json.reason === 'string' ? { reason: json.reason } : {}),
      ...(typeof json.draftHeadSha === 'string' ? { draftHeadSha: json.draftHeadSha } : {}),
      ...(typeof json.currentHeadSha === 'string' ? { currentHeadSha: json.currentHeadSha } : {}),
    };
  }
  if (status === 400) return { ok: false, kind: 'bad-request', status: 400, message };
  return { ok: false, kind: 'server', status, message };
}

export function createCollabClient(fetchImpl?: typeof fetch): CollabClient {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function call<T>(path: string, init?: RequestInit): Promise<CollabResult<T>> {
    let res: Response;
    try {
      res = await doFetch(`${BASE}${path}`, init);
    } catch (err) {
      // The route layer was never reached, so there is no server message to quote.
      return { ok: false, kind: 'network', message: (err as Error).message };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, kind: 'network', message: (err as Error).message };
    }
    if (!res.ok) return failureOf(res.status, body);
    return { ok: true, value: body as T };
  }

  const send = <T>(path: string, method: string, body: unknown): Promise<CollabResult<T>> =>
    call<T>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  /**
   * Two of the `/pulls` routes answer a named envelope (`{ pulls }`, `{ worktrees }`)
   * rather than the array itself. Unwrapping it here rather than in the component keeps
   * the envelope a fact about the route: a failure passes through untouched, so the
   * server's own words survive the projection.
   */
  const projected = async <T, U>(result: Promise<CollabResult<T>>, pick: (value: T) => U): Promise<CollabResult<U>> => {
    const res = await result;
    return res.ok ? { ok: true, value: pick(res.value) } : res;
  };

  return {
    availability: () => call<CollabAvailabilitySnapshot>(''),
    start: (input) => send<JobAccepted>('/start', 'POST', input),
    // R-W4.1 — the repository goes in the path and comes back out of the body, so the
    // request says it exactly once. `encodeURIComponent` because the server decodes the
    // segment before validating it (R-W3.7): a repository that is not one is its refusal
    // to make, and a raw `/` here would silently become a different route instead.
    open: ({ repo, ...input }) =>
      send<JobAccepted>(
        repo ? `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/open` : '/open',
        'POST',
        input,
      ),
    status: (documentId) => call<CollabDocumentStatus>(`/${documentId}`),
    document: (documentId) => call<CollaborationRecord>(`/${documentId}/document`),
    comments: (documentId) => call<ReviewThreadRecord[]>(`/${documentId}/comments`),
    sync: (documentId, input) => send<JobAccepted>(`/${documentId}/sync`, 'POST', input ?? {}),
    publish: (documentId, input) => send<JobAccepted>(`/${documentId}/publish`, 'POST', input),
    addComment: (documentId, input) => send<CommentSaved>(`/${documentId}/comments`, 'POST', input),
    replyToComment: (documentId, commentId, input) =>
      send<CommentSaved>(`/${documentId}/comments/${commentId}/reply`, 'POST', input),
    patchComment: (documentId, commentId, patch) =>
      send<CommentUpdated>(`/${documentId}/comments/${commentId}`, 'PATCH', patch),
    pullRequests: (state) =>
      projected(call<{ pulls: PullRequestSummary[] }>(state ? `/pulls?state=${state}` : '/pulls'), (b) => b.pulls),
    mountedPullRequests: () =>
      projected(call<{ worktrees: MountedWorktree[] }>('/pulls/mounted'), (b) => b.worktrees),
    awaitingPullRequests: () => call<Awaiting>('/pulls/awaiting'),
    // No body: the pull number is the whole request, and it is in the path.
    mountPullRequest: (pullNumber) => send<WorktreeMounted>(`/pulls/${pullNumber}/mount`, 'POST', {}),
    unmountPullRequest: (pullNumber) => call<WorktreeRemoved>(`/pulls/${pullNumber}/mount`, { method: 'DELETE' }),
    pullRequestFiles: (pullNumber) => call<PullRequestChangedFiles>(`/pulls/${pullNumber}/files`),
    pullRequestTree: (pullNumber, path) =>
      call<PullRequestTree>(`/pulls/${pullNumber}/tree?path=${encodeURIComponent(path)}`),
    pullRequestFile: (pullNumber, path) =>
      call<PullRequestFile>(`/pulls/${pullNumber}/raw?path=${encodeURIComponent(path)}`),
    pullRequestDescription: (pullNumber) =>
      projected(call<{ body: string }>(`/pulls/${pullNumber}/description`), (b) => b.body),
    reviewDrafts: (pullNumber) =>
      projected(call<{ drafts: ReviewDraft[] }>(`/pulls/${pullNumber}/drafts`), (b) => b.drafts),
    reviewComments: (pullNumber) =>
      projected(call<{ threads: ReviewThreadRecord[] }>(`/pulls/${pullNumber}/comments`), (b) => b.threads),
    replyToReviewComment: (pullNumber, commentId, input) =>
      send<CommentSaved>(`/pulls/${pullNumber}/comments/${commentId}/reply`, 'POST', input),
    holdReviewDraft: (pullNumber, input) => send<ReviewDraftSaved>(`/pulls/${pullNumber}/drafts`, 'POST', input),
    discardReviewDraft: (pullNumber, draftId) =>
      call<ReviewDraftRemoved>(`/pulls/${pullNumber}/drafts/${draftId}`, { method: 'DELETE' }),
    publishReviewDraft: (pullNumber, draftId, input) =>
      send<ReviewDraftPublished>(`/pulls/${pullNumber}/drafts/${draftId}/publish`, 'POST', input ?? {}),
    eventsUrl: (documentId) => `${BASE}/${documentId}/events`,
  };
}

/**
 * Apply one streamed frame to a snapshot (R-8.2 / R-8.4). The `sync` frame *replaces*
 * the snapshot — it is authoritative, and is what recovers a subscriber that attached
 * after the log was trimmed. Every other frame is folded in, mirroring what the hub
 * does server-side, so a client never has to re-poll `GET /:id` to stay current.
 */
export function applyJobFrame(snapshot: JobSnapshot | null, frame: JobEvent | JobSync): JobSnapshot | null {
  if (frame.type === 'sync') {
    const { type: _type, ...rest } = frame;
    return rest;
  }
  if (!snapshot) return snapshot;
  const events = [...snapshot.events, frame];
  switch (frame.type) {
    case 'job-start':
      return {
        ...snapshot,
        running: true,
        events,
        job: {
          jobId: frame.jobId,
          kind: frame.kind,
          startedAt: frame.startedAt,
          finishedAt: null,
          ok: null,
          ...(frame.idempotencyKey ? { idempotencyKey: frame.idempotencyKey } : {}),
        },
      };
    case 'state':
      return { ...snapshot, state: frame.state, events };
    case 'job-done':
      return {
        ...snapshot,
        state: frame.state,
        running: false,
        events,
        job: snapshot.job ? { ...snapshot.job, ok: frame.ok, finishedAt: frame.finishedAt } : snapshot.job,
      };
    // `job-error` does not end the job on its own — `job-done` always follows it, and
    // it is that frame which carries the terminal state. Only the log changes here.
    case 'job-error':
    case 'log':
      return { ...snapshot, events };
  }
}
