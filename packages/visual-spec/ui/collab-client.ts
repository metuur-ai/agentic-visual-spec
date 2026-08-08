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
import type { JobEvent, JobKind, JobSnapshot, JobSync } from '../core/collaboration/job-hub';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { CommentPatch } from '../core/vite/routes/comments';
import type { CollaborationRecord, GitHubBinding } from '../core/collaboration/document-record';

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
  /** 409 — a job is already running, or (comment routes) there is no pull request yet. */
  | { ok: false; kind: 'conflict'; status: 409; message: string }
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
};

export type OpenDocumentInput = Idempotent & { documentId: string; pullNumber: number; discardLocal?: boolean };

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
  /** `POST /__vs/collab/open` — attach to a pull request that already exists. */
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
  /** The URL of the R-8.2 event stream, for whoever opens the `EventSource`. */
  eventsUrl(documentId: string): string;
}

/** The 503 body is the availability snapshot; every other failure body is `{ error }`. */
function failureOf(status: number, body: unknown): CollabFailure {
  const json = (body ?? {}) as { error?: string; message?: string };
  const message = json.error ?? json.message ?? `HTTP ${status}`;
  if (status === 503) {
    return { ok: false, kind: 'unavailable', status: 503, availability: body as CollabAvailabilitySnapshot, message };
  }
  if (status === 401 || status === 403) return { ok: false, kind: 'forbidden', status, message };
  if (status === 404) return { ok: false, kind: 'not-found', status, message };
  if (status === 409) return { ok: false, kind: 'conflict', status: 409, message };
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

  return {
    availability: () => call<CollabAvailabilitySnapshot>(''),
    start: (input) => send<JobAccepted>('/start', 'POST', input),
    open: (input) => send<JobAccepted>('/open', 'POST', input),
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
