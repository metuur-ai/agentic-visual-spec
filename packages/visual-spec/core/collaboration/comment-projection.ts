/**
 * comment-projection.ts — projects GitHub PR **issue** comments into `CommentDoc`
 * shape (R-5.1), so `/__vs/comments` and the apply hub keep working against one
 * interface whether the conversation lives in a sidecar file or on a Pull Request.
 *
 * GitHub is the system of record (R-5.2). `read()` always goes to the API; the
 * sidecar is only ever a non-authoritative cache (R-5.3) and is never consulted
 * to answer a read. Only **issue** comments are created — never review comments
 * (R-5.5), which need a diff hunk a canonical JSON payload cannot provide.
 *
 * ---------------------------------------------------------------------------
 * THE TRAILER FORMAT (R-5.4) — tasks 5.2, 5.3, 6.1 and 8.x parse this. Do not
 * change it without changing them.
 * ---------------------------------------------------------------------------
 *
 * A visual-spec comment body is the author's text, then a blank line, then a
 * single-line HTML comment as the **last** line of the body:
 *
 *     Tighten this paragraph.
 *
 *     <!-- visual-spec: documentId=doc-1 nodeId=n-7 -->
 *
 * Shape: `<!-- visual-spec: <key>=<value> <key>=<value> ... -->`
 *
 * - **Unambiguous.** An HTML comment cannot be produced by prose accidentally, and
 *   the `visual-spec:` sentinel scopes it to this tool. Only a trailer occupying
 *   the final line is recognized, so a body quoting one mid-paragraph is text.
 * - **Unobtrusive.** GitHub's Markdown renderer drops HTML comments, so a human on
 *   github.com sees only "Tighten this paragraph."
 * - **Round-trips exactly.** Keys are `[A-Za-z][A-Za-z0-9]*`; values are
 *   percent-encoded with `encodeURIComponent`, so no space, newline or `-->` can
 *   appear inside one. `parseCommentBody(formatCommentBody(text, fields))` returns
 *   the original `text` and `fields` byte-for-byte.
 * - **Extensible.** Unknown keys are carried through untouched, so 5.2 can add a
 *   `resolved=` / `replyTo=` marker and 5.3 an idempotency `key=` without a format
 *   change and without breaking older readers.
 *
 * Known keys today: `documentId` (always written), `nodeId` (omitted for
 * document-level comments), the resolution pair `replyTo` + `resolved`
 * (task 5.2 — see "RESOLUTION" below), and `key`, the idempotency key
 * (task 5.3 — see "IDEMPOTENT CREATION" below). A comment with no trailer at all — anything
 * authored on github.com — is preserved and lands in the document-level bucket
 * (R-5.6 / R-5.7); nothing is ever discarded.
 *
 * This module is Node-reachable from the CLI: no react, no `@lyfie/luthor`.
 */
import type { CommentDoc, CommentRecord } from '../editing/comment-doc';
import { DEFAULT_WORKFLOW } from '../editing/comment-doc';
import type { CommentDocStore } from '../vite/routes/comments';
import type { GitHubAdapter, IssueComment, RepoRef } from './github-adapter';

/** Machine-readable trailer fields. Unknown keys survive a parse/format round-trip. */
export type CommentTrailer = {
  documentId?: string;
  nodeId?: string;
  [key: string]: string | undefined;
};

/**
 * A `CommentRecord` as projected from GitHub. Structurally still a `CommentRecord`
 * — the local shapes in `core/editing/comment-doc.ts` are untouched (R-1.7 / R-10.3)
 * — with the GitHub identity and the collaborative target carried alongside.
 */
export type ProjectedCommentRecord = CommentRecord & {
  /** R-5.4 — the id GitHub returned, persisted on the record. */
  github: {
    issueCommentId: number;
    user: string;
    htmlUrl: string;
    createdAt: string;
    updatedAt: string;
  };
  /** The trailer as parsed. `nodeId` absent ⇒ document-level discussion (R-5.7). */
  collab: CommentTrailer;
  /**
   * R-5.14 — resolution as derived from the latest marker among this comment's
   * replies. Absent when no reply ever carried a marker: absence means "never
   * toggled", which reads the same as `false` but is not a claim anyone made.
   * Mirrored onto `status` (`applied` when resolved) so the existing
   * `openByPath` / `openByWorkflow` groupings drop resolved comments for free.
   */
  resolved?: boolean;
};

const SENTINEL = 'visual-spec:';
/** Matches a trailer occupying the whole final line of a body. */
const TRAILER_RE = /^<!--\s*visual-spec:\s*([^]*?)\s*-->$/;

/** Serialize trailer fields. Undefined/empty values are omitted, keys sorted for stability. */
export function formatTrailer(fields: CommentTrailer): string {
  const pairs = Object.keys(fields)
    .sort()
    .filter((k) => fields[k] !== undefined && fields[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(fields[k] as string)}`);
  return `<!-- ${SENTINEL} ${pairs.join(' ')} -->`;
}

/** Author text + trailer → the GitHub comment body. Empty text yields the trailer alone. */
export function formatCommentBody(text: string, fields: CommentTrailer): string {
  const trailer = formatTrailer(fields);
  return text ? `${text}\n\n${trailer}` : trailer;
}

/**
 * Split a GitHub comment body into its author text and its trailer. A body with no
 * recognizable trailer comes back verbatim with `trailer: null` — never dropped
 * (R-5.6).
 */
export function parseCommentBody(body: string): { text: string; trailer: CommentTrailer | null } {
  const lines = body.split('\n');
  const last = lines[lines.length - 1] ?? '';
  const match = TRAILER_RE.exec(last.trim());
  if (!match) return { text: body, trailer: null };

  const trailer: CommentTrailer = {};
  for (const pair of (match[1] ?? '').split(/\s+/)) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    trailer[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  // Drop the trailer line and the blank separator `formatCommentBody` wrote.
  lines.pop();
  if (lines[lines.length - 1] === '') lines.pop();
  return { text: lines.join('\n'), trailer };
}

/**
 * Record id ⇄ GitHub comment id. Deterministic in both directions, so a sync holds
 * no local id map and the id stays stable across syncs (R-5.2). The `c-<hex>` shape
 * is what `handleCommentsRequest` routes on, so PATCH/DELETE keep working unchanged.
 */
export function recordIdFor(issueCommentId: number): string {
  return `c-${issueCommentId.toString(16).padStart(8, '0')}`;
}

/** Inverse of `recordIdFor`. Returns `null` for an id that was not projected. */
export function issueCommentIdFor(recordId: string): number | null {
  const hex = /^c-([0-9a-f]+)$/.exec(recordId)?.[1];
  if (!hex) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/** Project one GitHub issue comment into a `CommentRecord` (R-5.1). */
export function projectIssueComment(comment: IssueComment, documentPath: string): ProjectedCommentRecord {
  const { text, trailer } = parseCommentBody(comment.body);
  return {
    id: recordIdFor(comment.id),
    /*
     * Read back rather than stamped. A comment written through visual-spec carries its
     * routing tag in the trailer; before that tag was persisted it carried none, and
     * falls back to the default — that is the population the tag was always implicitly
     * `visual-spec` for, so nothing shifts underneath it and no migration is needed
     * (rewriting someone else's comment body would take their token anyway).
     *
     * A comment typed on github.com has no trailer and never chose anything. The field
     * still reads `visual-spec`, because `CommentRecord` requires a workflow and every
     * sentinel would collide with a namespace that is free text. `hasRoutingDecision`
     * below is the honest signal, and the ONE consumer that must not confuse the two is
     * whatever hands work to an agent — see the note there.
     */
    workflow: trailer?.workflow ?? DEFAULT_WORKFLOW,
    target: { path: documentPath, kind: 'file' },
    comment: text,
    status: 'open',
    ts: comment.createdAt,
    github: {
      issueCommentId: comment.id,
      user: comment.user,
      htmlUrl: comment.htmlUrl,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    },
    collab: trailer ?? {},
  };
}

/**
 * R-5.7 — comments with no `nodeId`, in GitHub order. Never discarded, always shown.
 * Resolution replies are excluded: they belong to the thread they reply to, not to
 * the document-level discussion. They stay in `doc.comments` regardless (R-5.6).
 */
export function documentDiscussion(doc: CommentDoc): ProjectedCommentRecord[] {
  return (doc.comments as ProjectedCommentRecord[]).filter((c) => !c.collab?.nodeId && !isResolutionReply(c));
}

/** Comments grouped by the `nodeId` they anchor to. Document-level ones are excluded. */
export function commentsByNode(doc: CommentDoc): Record<string, ProjectedCommentRecord[]> {
  const out: Record<string, ProjectedCommentRecord[]> = {};
  for (const c of doc.comments as ProjectedCommentRecord[]) {
    const nodeId = c.collab?.nodeId;
    if (nodeId) (out[nodeId] ??= []).push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RESOLUTION (task 5.2 — R-5.12 … R-5.15)
// ---------------------------------------------------------------------------
//
// Issue comments have no native resolve state and reviewers cannot push, so
// resolution is a **convention**: a reply issue comment carrying a marker in the
// same trailer (R-5.12) — no second encoding exists.
//
// Two keys are added, both reserved by 5.1:
//   `replyTo`  the parent's GitHub issue-comment id. Issue comments are a FLAT
//              list with no native threading, so the link has to be carried here.
//   `resolved` `true` | `false`.
//
// The body of a resolve reply is, exactly:
//
//     Resolved this comment: https://github.com/acme/docs/pull/42#issuecomment-700001
//
//     <!-- visual-spec: documentId=doc-1 replyTo=700001 resolved=true -->
//
// and of an unresolve reply the same with `Reopened` and `resolved=false`.
// GitHub's renderer HIDES the trailer, so the visible sentence is all a reader on
// github.com gets — it is a plain English statement plus a link straight to the
// comment it is about, legible to someone who has never heard of visual-spec
// (R-5.15). No participant identity is written into the body (R-5.13): the reply
// is created through the ordinary `createIssueComment` path, so GitHub attributes
// it to whichever credential the acting participant's own instance is using.
//
// Markers ACCUMULATE — an unresolve is a new reply, never an edit of the resolve.
// Editing would rewrite another participant's comment (which needs their token) and
// would erase the history the reply convention exists to provide. State is therefore
// the LATEST marker (R-5.14), ordered by `createdAt` ascending with the GitHub
// comment id ascending as the tie-break. `createdAt` is GitHub-assigned ISO-8601
// UTC, so lexicographic comparison is chronological; it has one-second granularity,
// so two replies posted in the same second can tie, and the id — monotonic per
// GitHub and unique — settles it. Derivation reads only the list just fetched from
// GitHub; the cache is never consulted.

/** A resolution marker as carried by one reply comment. */
type ResolutionMarker = { replyTo: number; resolved: boolean; createdAt: string; issueCommentId: number };

/** Read a marker off a projected record, or `null` when it carries none. */
function markerOf(record: ProjectedCommentRecord): ResolutionMarker | null {
  const replyTo = record.collab?.replyTo;
  const resolved = record.collab?.resolved;
  if (!replyTo || (resolved !== 'true' && resolved !== 'false')) return null;
  const parentId = Number(replyTo);
  if (!Number.isSafeInteger(parentId)) return null;
  return {
    replyTo: parentId,
    resolved: resolved === 'true',
    createdAt: record.github.createdAt,
    issueCommentId: record.github.issueCommentId,
  };
}

/**
 * R-5.6 — did anyone actually choose how this comment should be routed?
 *
 * `record.workflow` cannot answer that. It is required by `CommentRecord`, so a comment
 * typed straight into the PR conversation on github.com — no trailer, no control ever
 * seen — still reads `visual-spec`, and a sentinel value is not available either because
 * the workflow namespace is free text a user can type. The trailer's presence is the
 * signal: it is written by this tool and by nothing else.
 *
 * READ THE SCOPE. This says a routing decision exists, NOT that the comment is worth
 * acting on. Both workflow values mean actionable; they differ on by whom. Whether a
 * given comment is a sensible instruction, an aside, a question or noise is a judgement
 * about its text — a person makes that call, and the apply flow already lets them: a run
 * is scoped to the comment ids they picked. Do not grow this into a validity gate.
 */
export function hasRoutingDecision(record: ProjectedCommentRecord): boolean {
  return Object.keys(record.collab ?? {}).length > 0;
}

/** R-5.12 — true when this comment is a resolution reply rather than a comment of its own. */
export function isResolutionReply(record: ProjectedCommentRecord): boolean {
  return markerOf(record) !== null;
}

/** `a` is later than `b` under the documented ordering: createdAt, then id. */
function isLater(a: ResolutionMarker, b: ResolutionMarker): boolean {
  return a.createdAt === b.createdAt ? a.issueCommentId > b.issueCommentId : a.createdAt > b.createdAt;
}

/**
 * R-5.14 — parent issue-comment id → resolution state, taken from the LATEST marker
 * among its replies. Pure over the list handed in; nothing else is read.
 */
export function resolutionByComment(records: ProjectedCommentRecord[]): Map<number, boolean> {
  const latest = new Map<number, ResolutionMarker>();
  for (const record of records) {
    const marker = markerOf(record);
    if (!marker) continue;
    const previous = latest.get(marker.replyTo);
    if (!previous || isLater(marker, previous)) latest.set(marker.replyTo, marker);
  }
  const out = new Map<number, boolean>();
  for (const [parentId, marker] of latest) out.set(parentId, marker.resolved);
  return out;
}

/**
 * R-5.14 — stamp derived resolution onto the records it belongs to. Records with no
 * marker among their replies come back untouched, so "never toggled" stays distinct
 * from an explicit unresolve.
 */
export function withResolutionState(records: ProjectedCommentRecord[]): ProjectedCommentRecord[] {
  const state = resolutionByComment(records);
  return records.map((record) => {
    const resolved = state.get(record.github.issueCommentId);
    return resolved === undefined ? record : { ...record, resolved, status: resolved ? 'applied' : 'open' };
  });
}

/**
 * R-5.12 / R-5.15 — the exact body of a resolution reply: a human-visible sentence
 * linking the comment it is about, then the hidden marker trailer.
 */
export function formatResolutionReply(input: {
  documentId: string;
  parent: ProjectedCommentRecord;
  resolved: boolean;
}): string {
  const { documentId, parent, resolved } = input;
  const verb = resolved ? 'Resolved' : 'Reopened';
  // R-5.13 — the sentence names the comment, never the person. Authorship is
  // GitHub's, taken from the credential the reply is posted with.
  return formatCommentBody(`${verb} this comment: ${parent.github.htmlUrl}`, {
    documentId,
    replyTo: String(parent.github.issueCommentId),
    resolved: String(resolved),
  });
}

// ---------------------------------------------------------------------------
// IDEMPOTENT CREATION (task 5.3 — R-5.11)
// ---------------------------------------------------------------------------
//
// `POST /issues/:n/comments` has no server-side idempotency: GitHub creates a new
// comment on every request and offers no `Idempotency-Key` header to suppress the
// second one. A create that times out is therefore ambiguous — the comment may
// well exist — and a naive retry posts a duplicate that no reviewer can tell from
// a deliberate second comment.
//
// So the key is carried in the body, in the 5.1 trailer, under `key` (reserved by
// 5.1 for exactly this). The check is a read-before-write: list the PR's comments
// and, if one already carries this key, return THAT comment instead of creating a
// second one. The key must be supplied by the caller and must be STABLE across the
// retries of one logical create — a key generated inside `addComment` would differ
// on every attempt and dedupe nothing. When no key is supplied, behaviour is
// exactly as before, including the absence of the extra list call.
//
// RACE WINDOW — this narrows the duplicate window, it does not close it. Between
// the list response and the create request, another attempt's create can land;
// the classic case is the timed-out first attempt whose write GitHub accepted
// after the client gave up but before the retry's list ran. Two attempts running
// concurrently can also both list-then-create. Closing this needs a compare-and-set
// GitHub does not offer for issue comments, so a duplicate remains possible for
// the duration of one list→create round trip. It is detectable after the fact —
// two comments sharing a `key` — but not preventable here.

/** The trailer key carrying the idempotency key (R-5.11). */
export const IDEMPOTENCY_KEY = 'key';

/**
 * R-5.11 — the comment already carrying `key`, or `null`. Pure over the list handed
 * in, so the caller decides where that list came from (GitHub, always, in practice).
 * Ties go to the lowest GitHub id: if a duplicate did slip through the race window,
 * every retry still converges on the same, earliest comment.
 */
export function findByIdempotencyKey(records: ProjectedCommentRecord[], key: string): ProjectedCommentRecord | null {
  let found: ProjectedCommentRecord | null = null;
  for (const record of records) {
    if (record.collab?.[IDEMPOTENCY_KEY] !== key) continue;
    if (!found || record.github.issueCommentId < found.github.issueCommentId) found = record;
  }
  return found;
}

export type GitHubCommentStoreOptions = {
  adapter: GitHubAdapter;
  repo: RepoRef;
  /** The PR carrying this document's conversation. One document per PR. */
  pullNumber: number;
  /** Written into every trailer this store creates. */
  documentId: string;
  /** Repo-relative path used as the `CommentTarget.path` of every projected record. */
  documentPath: string;
  /**
   * R-5.3 — optional non-authoritative mirror. It is written to, never read from;
   * `read()` always goes to GitHub. Its lifecycle — and its deletion on merge
   * (R-5.8) — lives in `cache-lifecycle.ts`.
   */
  cache?: CommentDocStore;
};

/**
 * The GitHub-backed store. A `CommentDocStore` plus `setResolved`, which has no
 * place on the local interface — the sidecar has no reply comments to carry a marker.
 */
export type GitHubCommentStore = CommentDocStore & {
  /**
   * R-5.12 / R-5.13 — toggle resolution by posting a reply as the acting user.
   * Resolves the created reply record, or `null` when GitHub does not know `id`.
   */
  setResolved(id: string, resolved: boolean): Promise<ProjectedCommentRecord | null>;
};

/**
 * A `CommentDocStore` backed by a PR's issue comments (R-5.1).
 *
 * Mutations go through the intent methods, not `write()`: `write(doc)` is a
 * whole-document snapshot swap with no channel for the created comment's id, so a
 * GitHub-backed `write` could only guess at intent by diffing. Here it updates the
 * cache and nothing else — GitHub is only ever changed through `addComment`,
 * `updateComment` and `deleteComment`.
 */
export function githubCommentStore(options: GitHubCommentStoreOptions): GitHubCommentStore {
  const { adapter, repo, pullNumber, documentId, documentPath, cache } = options;

  async function read(): Promise<CommentDoc> {
    // R-5.2 / R-5.9 — always GitHub, never the cache.
    const comments = await adapter.listIssueComments(repo, pullNumber);
    // R-5.14 — resolution is derived from the list just fetched, never from the cache.
    const projected = withResolutionState(comments.map((c) => projectIssueComment(c, documentPath)));
    const doc: CommentDoc = { version: 1, comments: projected };
    await cache?.write(doc);
    return doc;
  }

  async function find(id: string): Promise<ProjectedCommentRecord | null> {
    const doc = await read();
    return (doc.comments as ProjectedCommentRecord[]).find((c) => c.id === id) ?? null;
  }

  return {
    read,

    /** R-5.3 — the sidecar is a cache; a snapshot swap never reaches GitHub. */
    async write(doc) {
      await cache?.write(doc);
    },

    /** R-5.4 — post an issue comment with a trailer and return the record carrying GitHub's id. */
    async addComment(record) {
      const collab = (record as Partial<ProjectedCommentRecord>).collab;
      const key = collab?.[IDEMPOTENCY_KEY];
      if (key) {
        // R-5.11 — read-before-write against GitHub. A retry of a create that already
        // landed finds it here and returns it instead of posting a duplicate.
        const existing = findByIdempotencyKey((await read()).comments as ProjectedCommentRecord[], key);
        if (existing) return existing;
      }
      /*
       * CARRY THE TRAILER THE CALLER BUILT, DO NOT REBUILD IT FROM A LIST.
       *
       * This used to name the keys it would write — documentId, nodeId, and the
       * idempotency key — which quietly made it the gatekeeper of the whole trailer
       * vocabulary. Every other key the caller computed was dropped on the floor, and
       * because issue comments are flat and this trailer is the only durable channel
       * (see the RESOLUTION note above), dropped means gone for good.
       *
       * Two requirements were dead in the water for exactly that reason, both of them
       * silently: `anchorFields` computes `nodeVersion` and the target text on every
       * anchored comment, and neither ever reached GitHub. Without `nodeVersion` no
       * comment can ever read as outdated (R-6.3) — everything resolves `exact`
       * forever. Without the text an orphan cannot say what it was about (R-6.5).
       * `replyTo` was the third, fixed earlier by adding it to the list, which treated
       * the symptom and left the mechanism.
       *
       * So the direction is inverted: the caller's fields go through, and this layer
       * only enforces what is genuinely its own.
       */
      const body = formatCommentBody(record.comment, {
        ...collab,
        // The store knows which document it serves; a caller must not be able to
        // address a comment at a different one.
        documentId,
        ...(key ? { [IDEMPOTENCY_KEY]: key } : {}),
      });
      // R-5.5 — issue comments only. The adapter has no review-comment method at all.
      const created = await adapter.createIssueComment(repo, pullNumber, body);
      return projectIssueComment(created, documentPath);
    },

    async updateComment(id, patch) {
      const current = await find(id);
      if (!current) return null;
      // Status/result have no GitHub representation yet — resolution markers are task 5.2.
      if (patch.comment === undefined) return current;
      const issueCommentId = current.github.issueCommentId;
      const body = formatCommentBody(patch.comment, current.collab);
      return projectIssueComment(await adapter.updateIssueComment(repo, issueCommentId, body), documentPath);
    },

    /**
     * R-5.12 / R-5.13 — resolution is a reply comment, created through the same
     * `createIssueComment` path as any other comment, so it carries no push
     * requirement and is authored by whichever credential this instance runs with.
     * Markers accumulate: an unresolve posts a second reply, it never edits the first.
     */
    async setResolved(id, resolved) {
      const parent = await find(id);
      if (!parent) return null;
      const body = formatResolutionReply({ documentId, parent, resolved });
      const created = await adapter.createIssueComment(repo, pullNumber, body);
      return projectIssueComment(created, documentPath);
    },

    async deleteComment(id) {
      const issueCommentId = issueCommentIdFor(id);
      if (issueCommentId === null) return;
      await adapter.deleteIssueComment(repo, issueCommentId);
    },
  };
}
