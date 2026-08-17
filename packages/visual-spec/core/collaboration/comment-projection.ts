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
 * - **Extensible.** Unknown keys are carried through untouched, so 5.3 could add an
 *   idempotency `key=` without a format change and without breaking older readers.
 *
 * Known keys today: `documentId` (always written), `nodeId` (omitted for
 * document-level comments), and `key`, the idempotency key
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

/** R-5.7 — comments with no `nodeId`, in GitHub order. Never discarded, always shown. */
export function documentDiscussion(doc: CommentDoc): ProjectedCommentRecord[] {
  return (doc.comments as ProjectedCommentRecord[]).filter((c) => !c.collab?.nodeId);
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
// RESOLUTION IS NOT HERE ANY MORE (R-5.12 / R-5.13)
// ---------------------------------------------------------------------------
//
// This module used to carry a reply-marker protocol — a reply comment whose trailer
// held `replyTo` + `resolved`, with the latest marker winning — because a PR *issue*
// comment has no resolve bit to read. Review comments do: GitHub's review threads
// expose `isResolved`, and that is now the only source (R-5.12). It is READ and never
// written (R-5.13); resolving happens on github.com.
//
// So the marker protocol is gone rather than kept alongside. Two encodings of the same
// fact is exactly the drift R-5.12 forbids — a thread resolved on github.com would have
// disagreed with a marker written here, and nothing could say which was right. The
// projection of resolution now lives in `review-comments.ts` (`github.isResolved`), and
// the Ready gate reads it in `readiness.ts`.

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
 * The GitHub-backed store. Exactly a `CommentDocStore` and nothing more: it used to
 * carry `setResolved`, and it does not any more (R-5.13). Resolution is GitHub's own
 * review-thread state, read in `review-comments.ts` and never written from here.
 */
export type GitHubCommentStore = CommentDocStore;

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
    const doc: CommentDoc = { version: 1, comments: comments.map((c) => projectIssueComment(c, documentPath)) };
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
      /*
       * Only the text reaches GitHub. `status` is the LOCAL apply-agent flag (R-5.21) and
       * has no GitHub representation by design: resolution lives on the review thread and
       * is never written from here (R-5.13). A status-only patch is therefore answered
       * with the record as it stands, not with a write.
       */
      if (patch.comment === undefined) return current;
      const issueCommentId = current.github.issueCommentId;
      const body = formatCommentBody(patch.comment, current.collab);
      return projectIssueComment(await adapter.updateIssueComment(repo, issueCommentId, body), documentPath);
    },

    async deleteComment(id) {
      const issueCommentId = issueCommentIdFor(id);
      if (issueCommentId === null) return;
      await adapter.deleteIssueComment(repo, issueCommentId);
    },
  };
}
