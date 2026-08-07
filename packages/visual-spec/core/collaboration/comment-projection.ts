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
 * document-level comments). A comment with no trailer at all — anything authored
 * on github.com — is preserved and lands in the document-level bucket (R-5.6 /
 * R-5.7); nothing is ever discarded.
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
    workflow: DEFAULT_WORKFLOW,
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
   * `read()` always goes to GitHub. Cache lifecycle proper is task 5.3.
   */
  cache?: CommentDocStore;
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
export function githubCommentStore(options: GitHubCommentStoreOptions): CommentDocStore {
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
      const nodeId = (record as Partial<ProjectedCommentRecord>).collab?.nodeId;
      const body = formatCommentBody(record.comment, { documentId, ...(nodeId ? { nodeId } : {}) });
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

    async deleteComment(id) {
      const issueCommentId = issueCommentIdFor(id);
      if (issueCommentId === null) return;
      await adapter.deleteIssueComment(repo, issueCommentId);
    },
  };
}
