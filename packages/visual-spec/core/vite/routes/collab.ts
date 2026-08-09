/**
 * routes/collab.ts — the `/__vs/collab/*` route family (R-7.1).
 *
 * THIS IS THE ROUTE LAYER AND NOTHING ELSE. It parses and validates a request,
 * resolves configuration / availability / the document, and then either calls a
 * landed module (`CollaborationStore`, `CommentDocStore`) or hands a **job body** to
 * `jobs.hub(id).start(...)`. It performs no GitHub work of its own: the bodies for
 * create / open / sync / publish are injected (`CollabJobBodies`), so tasks 8.2 and
 * 8.3 plug real behaviour in without reshaping a single route.
 *
 * WHY A SEPARATE FAMILY (R-7.2). `/__vs/comments` keeps serving local comments with
 * byte-identical semantics — `handleCommentsRequest` is not touched, not wrapped and
 * not re-entered from here. Collaboration comments travel their own paths and are
 * persisted through a `CommentDocStore` chosen per document (in practice
 * `githubCommentStore`, task 5.1), so the local sidecar path is never on the wire.
 *
 * WHY THE BROWSER NEVER TALKS TO GITHUB (R-7.7). Every GitHub touch happens behind
 * these handlers, on the server, through the adapter. The UI only ever sees
 * `/__vs/collab/*`. `collab.no-browser-github.test.ts` asserts the client sources
 * contain no GitHub host, SDK or credential header.
 *
 * WHY IT DOES NOT 500 WHEN COLLABORATION IS OFF (R-7.8). `resolveConfig()` yields
 * `collaboration: null` when the config block is absent, and `preflightCollaboration`
 * reports a missing credential as an ordinary result rather than a throw. Both are
 * folded into one `CollabAvailability`, served at `GET /__vs/collab`, which is what
 * the UI reads to decide whether to render collaboration controls at all. Every
 * GitHub-touching route answers `503` with the same payload instead of failing.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import type { ResolvedCollaborationConfig, ResolvedVisualSpecConfig } from '../../config';
import { type CollaborationPreflight, credentialFingerprint, preflightCollaboration } from '../../collaboration/credentials';
import { githubCommentStore } from '../../collaboration/comment-projection';
import {
  createGitHubAdapter,
  GitHubError,
  type GitHubAdapter,
  type PullRequestListState,
  type RepoRef,
} from '../../collaboration/github-adapter';
import { defaultExecGit, type GitExecutor } from '../../git-context';
import { listMountedWorktrees, mountPullRequest, unmountPullRequest, type WorktreeFailure } from '../../collaboration/worktree';
import {
  addReviewDraft,
  deleteReviewDraft,
  isStale,
  markDraftPublished,
  readReviewDrafts,
  type ReviewDraft,
} from '../../collaboration/review-drafts';
import type { CollaborationRecord, CompanionFile, GitHubBinding } from '../../collaboration/document-record';
import { DOCUMENT_ID_RE, newCollaborationRecord } from '../../collaboration/document-record';
import type { CollaborationStore } from '../../collaboration/record-store';
import { loadReviewThreadRecords } from '../../collaboration/review-anchoring';
import type { JobBody, JobHubRegistry, SseSink } from '../../collaboration/job-hub';
import {
  projectReviewThread,
  reviewCommentIdFor,
  type ReviewComment,
  type ReviewThreadRecord,
  type ThreadResolution,
} from '../../collaboration/review-comments';
import type { CommentStatus } from '../../editing/comment-doc';
import type { CommentDocStore, CommentPatch } from './comments';

/**
 * Mirrors `RouteResult` in `routes/comments.ts`. `streamed` marks the one response the
 * router wrote itself (SSE) so a host knows not to send a JSON body after it.
 */
export type CollabRouteResult = { status: number; json: unknown; streamed?: boolean };

/* ------------------------------------------------------------------ *
 * R-7.8 — availability
 * ------------------------------------------------------------------ */

/** Why collaboration is off, beyond the preflight's own reasons. */
export type CollabUnavailableReason = 'not-configured' | 'no_credential' | 'executor_unavailable' | 'missing_scope' | 'preflight_failed';

/**
 * R-7.8 — the single object the UI reads to decide whether to render collaboration
 * controls. `available: false` is a normal, expected answer, never an error.
 *
 * It deliberately carries no credential of any kind (R-9.2): `login` comes from the
 * preflight's identity probe, and the preflight never reads a token value.
 */
export type CollabAvailability =
  | {
      available: true;
      repo: ResolvedCollaborationConfig;
      /** The authenticated GitHub login. Role classification is task 9.2. */
      login: string;
      scopes: readonly string[];
      /**
       * R-9.7 as a display hint, not a gate: `true` when the credential has write access
       * to the repo, `false` when it does not, absent when GitHub could not be asked.
       * The UI reads it to tell a reviewer their session is comment-only before they
       * reach a publish control. Every author-only route is still authorized server-side.
       */
      canPublish?: boolean;
    }
  | {
      available: false;
      reason: CollabUnavailableReason;
      /** Actionable and already scrubbed by the preflight (R-9.3). */
      message: string;
      missingScopes: readonly string[];
    };

const NOT_CONFIGURED: CollabAvailability = {
  available: false,
  reason: 'not-configured',
  message:
    'Collaboration is not configured. On the CLI, restart with `--repo <owner>/<name>` (optionally `--base-branch <branch>`); ' +
    'under Vite, pass `config: { collaboration: { owner, repo } }` to `visualSpecMarkdown()` in vite.config.ts. Local mode is unaffected.',
  missingScopes: [],
};

/* ------------------------------------------------------------------ *
 * Job body injection — the 8.2 / 8.3 seam
 * ------------------------------------------------------------------ */

/** Everything a body gets for free, whatever the job. */
type JobInputBase = {
  documentId: string;
  repo: ResolvedCollaborationConfig;
  store: CollaborationStore;
  idempotencyKey?: string;
};

/** `POST /__vs/collab/start` — task 8.2 (R-8.5). */
export type CreateJobInput = JobInputBase & {
  documentPath: string;
  title?: string;
  /** R-0.1 — the document. Seeded by the route; the body commits what the store holds. */
  markdown?: string;
  /** R-8.29 — the files travelling with it. The body commits what the store holds. */
  companions?: CompanionFile[];
};

/** `POST /__vs/collab/open` — task 8.2: attach to an already-open Pull Request. */
export type OpenJobInput = JobInputBase & { pullNumber: number; discardLocal?: boolean };

/** `POST /__vs/collab/:id/sync` — task 8.2 (R-8.6 / R-8.7). */
export type SyncJobInput = JobInputBase & { document: CollaborationRecord | null };

/** `POST /__vs/collab/:id/publish` — task 8.3 (R-8.9 … R-8.14). */
export type PublishJobInput = JobInputBase & {
  document: CollaborationRecord | null;
  /**
   * R-8.9 — the whole publish payload. Markdown is the document (LLD §2), so there is
   * one artifact and no second, structured half to carry beside it.
   * R-8.12 — opaque bytes. This layer only checks that it is a string.
   */
  markdown: string;
};

/**
 * The bodies 8.2 and 8.3 supply. Each is a *factory*: the route builds the input, the
 * factory returns the `JobBody` the hub runs. Anything absent falls back to
 * `notImplemented`, which reports honestly over SSE rather than reporting success.
 */
export type CollabJobBodies = {
  create(input: CreateJobInput): JobBody;
  open(input: OpenJobInput): JobBody;
  sync(input: SyncJobInput): JobBody;
  publish(input: PublishJobInput): JobBody;
  /** R-8.18 — re-derive state from GitHub; cleans up a partial create's orphan branch. */
  reconcile(input: RecoveryJobInput): JobBody;
  /** R-8.15 — re-derive readiness from GitHub and record it. Never trusts held state. */
  markReady(input: RecoveryJobInput): JobBody;
};

/** What both recovery bodies need. Mirrors 8.4's `RecoveryBodyInput`. */
export type RecoveryJobInput = {
  documentId: string;
  repo: ResolvedCollaborationConfig;
  store: CollaborationStore;
};

/**
 * The placeholder body. It **fails** rather than resolving: a stub that resolves would
 * have the hub broadcast `job-done ok:true` for work that never happened, which is the
 * one lie this layer must not tell.
 */
function notImplemented(what: string, task: string): JobBody {
  return async (ctx) => {
    ctx.log(`${what} is not implemented yet (task ${task})`, 'error');
    throw new Error(`${what} is not implemented yet (task ${task})`);
  };
}

const STUB_BODIES: CollabJobBodies = {
  create: () => notImplemented('collab create', '8.2'),
  open: () => notImplemented('collab open', '8.2'),
  sync: () => notImplemented('collab sync', '8.2'),
  publish: () => notImplemented('collab publish', '8.3'),
  reconcile: () => notImplemented('collab reconcile', '8.4'),
  markReady: () => notImplemented('collab mark-ready', '8.4'),
};

/* ------------------------------------------------------------------ *
 * Role enforcement seam — task 9.2 (R-9.9 / R-9.10)
 * ------------------------------------------------------------------ */

/** Every operation the family can perform, as the vocabulary 9.2 gates on. */
export type CollabOperation =
  | 'read'
  | 'create'
  | 'open'
  | 'sync'
  | 'comment'
  | 'reply'
  | 'edit-comment'
  | 'publish'
  | 'reconcile'
  | 'mark-ready';

export type AuthorizationVerdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * TASK 9.2 PLUGS IN HERE. Every handler below calls `authorize(op, ctx)` after the
 * availability check and before it touches a store or starts a job, so author-only
 * gating (R-9.9) and the reviewer rejection (R-9.10) land in exactly one place with no
 * route changes. There is no default: `authorize` is required on `CollabDeps`, so a host
 * that forgets to wire `createCollabAuthorizer` fails to compile rather than silently
 * serving every operation to everyone.
 */
/**
 * R-12.5 — the write probe's answer. Three outcomes, because "no" has two causes that
 * need different words: the credential is fine but carries no write grant, or the
 * repository itself could not be found. `write: null` is the outage case and must never
 * be rendered as either.
 */
export type WriteAccessVerdict =
  | { write: true }
  | { write: false; reason: 'no_write_access' | 'no_repo'; message: string }
  | { write: null; reason: 'unknown' };

export type CollabAuthorizer = ((
  op: CollabOperation,
  ctx: { documentId: string | null; login: string; repo: ResolvedCollaborationConfig },
) => AuthorizationVerdict | Promise<AuthorizationVerdict>) & {
  /**
   * The same write-access fact the verdicts are derived from, asked as a question so the
   * availability snapshot can carry it (`canPublish`). A `write: null` verdict means "could
   * not be determined" — never "allowed". Optional so a test or a local-mode host can pass a
   * bare function; an absent probe simply leaves `canPublish` off the snapshot.
   */
  writeAccess?: (repo: ResolvedCollaborationConfig) => Promise<WriteAccessVerdict>;
};

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

export type CollabDeps = {
  /** One registry per server (never module-level). The router never creates it. */
  jobs: JobHubRegistry;
  /** Read per request, so a runtime re-root takes effect on the next call. */
  config: () => ResolvedVisualSpecConfig;
  /** Where collaboration documents are cached locally (task 3.1). */
  documents: () => CollaborationStore;
  /**
   * The comment store for one document. Defaults to `githubCommentStore` built from the
   * document's own GitHub binding, so comments are server-side by construction (R-7.7).
   * Returning `null` means "this document has no conversation yet" → 409.
   */
  commentStore?: (ctx: {
    documentId: string;
    document: CollaborationRecord;
    repo: ResolvedCollaborationConfig;
  }) => Promise<CommentDocStore | null> | CommentDocStore | null;
  /** Tasks 8.2 / 8.3. Partial: anything missing uses the failing stub. */
  bodies?: Partial<CollabJobBodies>;
  /**
   * The GitHub adapter the three **review-comment** routes drive (R-7.7 — every GitHub
   * touch is server-side). Built per request from the document's own binding by default,
   * so a re-synced document that moved Pull Requests is picked up without a restart.
   * Injectable so a test never execs `gh`.
   */
  adapter?: (ctx: {
    documentId: string;
    document: CollaborationRecord;
    repo: ResolvedCollaborationConfig;
  }) => GitHubAdapter;
  /**
   * The adapter the **repo-level** routes drive (the Pull Request list, the compare a
   * mounted PR's file list comes from). Deliberately not `adapter` above: that one is
   * built from a document's binding and there is no document in play here — the question
   * "which Pull Requests can I review?" is asked before any document is chosen.
   * Injectable so a test never execs `gh`.
   */
  repoAdapter?: () => GitHubAdapter;
  /**
   * The served directory PR worktrees are mounted under, read per request so a runtime
   * re-root is honoured. Optional with a `process.cwd()` default so the two existing
   * hosts keep compiling; both pass their content directory.
   */
  baseDir?: () => string;
  /** Injectable so tests never exec `git`. Defaults to the real CLI. */
  git?: GitExecutor;
  /** Injectable so tests never exec `gh`. Memoized by the router, successes only. */
  preflight?: (repo: ResolvedCollaborationConfig) => Promise<CollaborationPreflight>;
  /** How long a successful preflight may be reused. Mirrors `createCollabAuthorizer`. */
  preflightTtlMs?: number;
  /** Injectable numeric clock for the preflight TTL. `now` is a string clock, not usable here. */
  clock?: () => number;
  /**
   * Env the credential fingerprint is derived from; defaults to `process.env`. Injectable
   * so a test can simulate a token swap without mutating the real environment.
   */
  env?: Record<string, string | undefined>;
  /** Task 9.2. Required: there is no permissive default, so a host cannot omit gating. */
  authorize: CollabAuthorizer;
  now?: () => string;
};

export interface CollabRouter {
  /** Handle one request whose path starts with `/__vs/collab`. */
  handle(req: CollabRequest): Promise<CollabRouteResult>;
  /** R-7.8 — the availability snapshot, also served at `GET /__vs/collab`. */
  availability(): Promise<CollabAvailability>;
  /** Abort every running job and drop every hub. Call on server shutdown. */
  dispose(): void;
}

export type CollabRequest = {
  method: string;
  /** The path **after** `/__vs/collab` (`''`, `/start`, `/doc-1/events`, …). */
  pathname: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  /** The response, for `GET /:id/events`. Absent on every other route. */
  sse?: SseSink;
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const bad = (error: string): CollabRouteResult => ({ status: 400, json: { error } });
const notFound = (method: string, pathname: string): CollabRouteResult => ({
  status: 404,
  json: { error: `no route: ${method} /__vs/collab${pathname}` },
});

/** `c-<hex>` — the id shape `recordIdFor` produces and `handleCommentsRequest` routes on. */
const COMMENT_ID_RE = /^c-[0-9a-f]+$/;

/**
 * A `CommentDocStore` that implements the intent methods collaboration requires.
 *
 * There is deliberately no resolution method on it (R-5.13). Resolution is GitHub's own
 * review-thread state, read on `GET /:id/comments` and written nowhere — resolving a
 * thread happens on github.com.
 */
type CollabCommentStore = CommentDocStore & Required<Pick<CommentDocStore, 'addComment' | 'updateComment'>>;

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing ${key}`);
  return value;
}

function optionalKey(body: Record<string, unknown>): string | undefined {
  const key = body.idempotencyKey;
  return typeof key === 'string' && key ? key : undefined;
}

/**
 * R-8.27 … R-8.32 — the `files` array on `POST /start`, reduced to the companions.
 *
 * THE PRIMARY IS NOT A COMPANION. `documentPath` names the one file that `documentId`
 * refers to (R-8.30), and clients send it in both places: it is the open file, so it is
 * naturally first in the selection. Listing it here too would commit it twice and put it
 * in the Pull Request body's companion row, so it is filtered out rather than rejected —
 * sending the document among the files is correct, not a mistake to refuse.
 *
 * EVERY REFUSAL NAMES THE PATH. These are author mistakes made in a picker, and "invalid
 * request" would leave someone re-selecting files to find which one it meant.
 */
type CompanionParse = { ok: true; files: CompanionFile[] } | { ok: false; message: string };

function parseCompanions(raw: unknown, documentPath: string): CompanionParse {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'files must be an array of { path, markdown }' };

  const files: CompanionFile[] = [];
  const seen = new Set<string>([documentPath]);
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'files must be an array of { path, markdown }' };
    }
    const { path, markdown } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || !path.trim()) return { ok: false, message: 'every file needs a path' };
    if (typeof markdown !== 'string') return { ok: false, message: `missing markdown for ${path}` };
    // R-8.32 — the containment rule, applied before anything is written. `safeJoin` in
    // the store enforces it again at the moment of writing; this is the half that can
    // refuse the WHOLE request, which is what the requirement asks for.
    if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
      return { ok: false, message: `invalid path: ${path}` };
    }
    // R-8.31 — a duplicate against the document is silently the document (see above); a
    // duplicate against another companion is the author's mistake and is named.
    if (seen.has(path)) {
      if (path === documentPath) continue;
      return { ok: false, message: `duplicate path: ${path}` };
    }
    seen.add(path);
    files.push({ path, markdown });
  }
  return { ok: true, files };
}

/** The document's GitHub binding, if it carries one an issue-comment store can use. */
function bindingOf(document: CollaborationRecord): GitHubBinding | null {
  const raw = (document as { github?: unknown }).github;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const binding = raw as Partial<GitHubBinding>;
  if (typeof binding.pullNumber !== 'number' || !binding.owner || !binding.repo) return null;
  return binding as GitHubBinding;
}

/**
 * The default comment store: the PR's issue comments, read and written **server-side**
 * through the adapter (R-7.7). Built per request from the document's own binding so a
 * re-synced document that moved PRs is picked up without restarting the server.
 */
function defaultCommentStore(documentId: string, document: CollaborationRecord): CommentDocStore | null {
  const binding = bindingOf(document);
  if (!binding) return null;
  return githubCommentStore({
    adapter: createGitHubAdapter(),
    repo: { owner: binding.owner, repo: binding.repo },
    pullNumber: binding.pullNumber as number,
    documentId,
    documentPath: document.documentPath,
  });
}

/* ------------------------------------------------------------------ *
 * Review comments — the conversation itself (R-4.13, R-5.11, R-7.12, R-7.13)
 * ------------------------------------------------------------------ */

/**
 * What a create/reply/list needs: the adapter, the repo it addresses, and the pull
 * number carrying the conversation. All three come off the document's own binding, so
 * nothing here is cached across documents.
 */
type ReviewContext = { adapter: GitHubAdapter; repoRef: RepoRef; pullNumber: number };

/** Positive integer or `undefined`. A line of 0 or 1.5 is a malformed request, not a line. */
function optionalLine(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`invalid ${key}`);
  return value;
}

/**
 * R-7.12 — the body of a comment posted against the FILE rather than a line.
 *
 * The line is the whole reference, and a file-level comment throws it away: on
 * github.com the thread hangs off the filename with nothing saying which paragraph the
 * reviewer meant. So the reference is restated in the text, where it survives for a
 * reader who has this tool installed and for one who does not.
 *
 * The user's own words are appended **unchanged and last** (R-7.13 — nothing the user
 * typed is discarded or reworded). With no line to name there is nothing to restate, so
 * a genuinely document-level comment passes through untouched rather than growing a
 * preamble about itself.
 */
function fileLevelBody(
  comment: string,
  ref: { path: string; startLine?: number; endLine?: number; selectedText?: string },
): string {
  const { path, startLine, endLine, selectedText } = ref;
  if (startLine === undefined) return comment;
  const lines = endLine !== undefined && endLine !== startLine ? `lines ${startLine}–${endLine}` : `line ${startLine}`;
  const header = `> **${path} ${lines}** — posted against the file because this line is not part of the pull request's diff.`;
  if (!selectedText) return `${header}\n\n${comment}`;
  const quoted = selectedText
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `${header}\n>\n${quoted}\n\n${comment}`;
}

/**
 * Create one review comment, applying the R-7.13 degrade-once policy.
 *
 * TWO RULES LIVE HERE AND NOWHERE ELSE.
 *
 * R-4.13 — `commit_id` is the Pull Request's CURRENT head, re-read from `getPullRequest`
 * on every create. A sha cached at open time is stale as soon as anyone pushes, and a
 * comment posted against a stale sha is born outdated: GitHub reports `line: null`
 * immediately and the reviewer's words arrive already detached from the text.
 *
 * R-7.13 — a line outside the Pull Request's diff is refused with `422`
 * (`errors[0].field: pull_request_review_thread.line`, recorded in
 * `collaboration/fixtures/error-line-not-in-diff.json`). The retry is **here**, not in
 * the adapter: the adapter deliberately surfaces the 422 so this policy — degrade once,
 * then say so — stays visible at the layer that answers the user. It runs exactly once;
 * a second 422 is a real failure and is reported as one.
 *
 * The 422 is discriminated on status alone, because `GitHubError` carries `status` and
 * `errors[0].code` but not `field`. With a valid head sha, an existing path and a
 * non-empty body already established, the unresolvable line is the remaining way for a
 * line create to be refused — and degrading on some other 422 costs a file-level comment
 * rather than a lost one.
 *
 * `input.commitId` is the one way to skip the `getPullRequest` above, and it exists for a
 * caller that has *just* read the current head for another reason — the draft-publish
 * route reads it to decide whether the draft is stale. Re-reading it here would be a
 * second answer to the same question, and the two could disagree, which is the one thing
 * the staleness check exists to prevent. It is not an escape hatch for a cached sha:
 * R-4.13 is about freshness, not about who made the call.
 */
async function createReviewCommentWithPolicy(
  ctx: ReviewContext,
  input: { path: string; comment: string; commitId?: string; startLine?: number; endLine?: number; selectedText?: string },
): Promise<{ created: ReviewComment; degraded?: { to: 'file'; reason: string } }> {
  const { adapter, repoRef, pullNumber } = ctx;
  const { path, comment, startLine, endLine, selectedText } = input;

  // R-4.13 — re-read at creation time. Never a sha held from open.
  const commitId = input.commitId ?? (await adapter.getPullRequest(repoRef, pullNumber)).headSha;

  // No line to anchor to: a document-level comment is file-level by intent, not by
  // degradation, so it carries no "we had to" disclosure.
  if (startLine === undefined) {
    return { created: await adapter.createReviewComment(repoRef, pullNumber, { path, body: comment, commitId }) };
  }

  const line = endLine ?? startLine;
  try {
    const created = await adapter.createReviewComment(repoRef, pullNumber, {
      path,
      body: comment,
      commitId,
      line,
      startLine,
      side: 'RIGHT',
    });
    return { created };
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 422) throw err;
    // The one retry. `line` is omitted, which is how the adapter is told to send
    // `subject_type: file` (R-4.14).
    const created = await adapter.createReviewComment(repoRef, pullNumber, {
      path,
      body: fileLevelBody(comment, {
        path,
        startLine,
        ...(endLine !== undefined ? { endLine } : {}),
        ...(selectedText ? { selectedText } : {}),
      }),
      commitId,
    });
    return { created, degraded: { to: 'file', reason: err.message } };
  }
}

/**
 * Project one just-created comment into the record the client renders.
 *
 * A create answers with a single comment, so its thread is that comment with no
 * replies — what `groupIntoThreads` would return for a one-element list. Resolution is
 * deliberately absent: a brand-new thread is unresolved, but "unresolved" is GitHub's
 * answer to give (R-5.12 / R-5.15), and `undefined` here reads as "not yet known" rather
 * than as a guess this layer made.
 */
function projectCreated(created: ReviewComment, workflow?: string): ReviewThreadRecord {
  const record = projectReviewThread({ root: created, replies: [] });
  // R-5.4 — the routing tag cannot be written into the body, so it lives only on this
  // response. A later read from GitHub projects the default; the tag does not round-trip.
  return workflow ? { ...record, workflow } : record;
}

/** Map an adapter failure onto a response. A 4xx is the caller's; anything else is ours. */
function githubFailure(err: GitHubError): CollabRouteResult {
  const status = err.status !== undefined && err.status >= 400 && err.status < 500 ? err.status : 502;
  return { status, json: { error: err.message } };
}

/* ------------------------------------------------------------------ *
 * Pull Requests and their worktrees (repo-level, no document in play)
 * ------------------------------------------------------------------ */

/**
 * A pull number as it arrives in a path segment.
 *
 * Validated **here**, at the edge, and not left to `worktree.ts`'s own
 * `assertPullNumber`: that one throws, and a throw inside `handle` lands in the catch-all
 * that answers `400` with the raw message — which happens to be right, but by accident.
 * Returning `null` keeps the refusal a route decision with the route's own wording.
 */
function parsePullNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Why a mount did not happen, said in the words of the thing the user has to fix.
 *
 * Each reason gets its own status because each is a different actor's problem: the first
 * two are the served directory's (nothing to do with GitHub, so `409` — the request was
 * fine, the state it addresses is not), `fetch-failed` is the network or the credential
 * (`502` — an upstream we depend on refused), and `worktree-failed` is git on this
 * machine (`500` — ours). Collapsing them into one "mount failed" would leave a user
 * with an unconfigured `origin` reading a message about GitHub being unreachable.
 */
const MOUNT_FAILURE: Record<WorktreeFailure, { status: number; message: string }> = {
  'not-a-repo': {
    status: 409,
    message:
      'The served directory is not a git working tree, so a pull request cannot be checked out next to it. ' +
      'Serve a directory inside the repository this pull request belongs to.',
  },
  'no-origin': {
    status: 409,
    message:
      'The served directory has no `origin` remote, so there is nowhere to fetch the pull request from. ' +
      'Add one with `git remote add origin <url>`.',
  },
  'fetch-failed': {
    status: 502,
    message:
      'The pull request head could not be fetched from `origin`. Check that you are online, that the pull ' +
      'request number is right, and that `gh auth status` reports a credential that can read the repository.',
  },
  'worktree-failed': {
    status: 500,
    message:
      'git refused to create the worktree. Run `git worktree prune` in the served directory and try again — ' +
      'a leftover registration from a previous mount is the usual cause.',
  },
};

/* ------------------------------------------------------------------ *
 * Held review comments on a checked-out Pull Request (Unit 13, R-13.13 … R-13.18)
 * ------------------------------------------------------------------ */

/**
 * A draft id as it arrives in a path segment. Same edge-validation argument as
 * `parsePullNumber`: `review-drafts.ts` looks the id up and reports "unknown draft", which
 * would read as a 404 for a request that was never well formed. The shape is the one
 * `newDraftId` mints — `d-` plus four hex bytes — so a `c-<hex>` GitHub comment id, which
 * is a *different id space* entirely, is refused here rather than missed later.
 */
const DRAFT_ID_RE = /^d-[0-9a-f]{8}$/;

/**
 * The line a held comment should be anchored to, read off its stored target.
 *
 * A `file` target has no line by construction and posts file-level (`subject_type: file`,
 * R-4.14). A `range` carries `startLine` and, only when the range spans more than one
 * line, `endLine` — `targetFor` normalises a one-line range to the former, so this reads
 * the two spellings back into the one pair GitHub takes.
 */
function draftLines(draft: ReviewDraft): { startLine?: number; endLine?: number } {
  const { target } = draft;
  if (target.kind !== 'range' || typeof target.startLine !== 'number') return {};
  return {
    startLine: target.startLine,
    ...(typeof target.endLine === 'number' ? { endLine: target.endLine } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

const DEFAULT_PREFLIGHT_TTL_MS = 60_000;

export function createCollabRoutes(deps: CollabDeps): CollabRouter {
  const bodies: CollabJobBodies = { ...STUB_BODIES, ...deps.bodies };
  const authorize = deps.authorize;
  const runPreflight = deps.preflight ?? ((repo: ResolvedCollaborationConfig) => preflightCollaboration({ repo }));
  const preflightTtl = deps.preflightTtlMs ?? DEFAULT_PREFLIGHT_TTL_MS;
  const clock = deps.clock ?? (() => Date.now());
  const repoAdapter = deps.repoAdapter ?? (() => createGitHubAdapter());
  const baseDir = deps.baseDir ?? (() => process.cwd());
  const git = deps.git ?? defaultExecGit;
  /** The configured repo as the adapter addresses it — `baseBranch` is not part of a ref. */
  const repoRefOf = (repo: ResolvedCollaborationConfig): RepoRef => ({ owner: repo.owner, repo: repo.repo });

  // Memoized per repo *and* credential identity: the preflight shells out to `gh`, and
  // every mutating route consults it. Keyed by owner/repo/base plus
  // `credentialFingerprint`, so both a repo change and an env token swap re-probe.
  // A `gh auth switch` still does not — it rewrites `gh`'s config, not the environment,
  // so it fingerprints identically and stays invisible until the entry expires. The TTL
  // is the bound for that case; see the note on `credentialFingerprint`.
  //
  // Only successes are cached, and only until `expiresAt`, matching the invariant
  // `collaboration/authorization.ts` already states: failures are never cached, in
  // either direction, so a transient network error can neither pin a deny nor pin an
  // allow. `preflightCollaboration` resolves `unavailable(...)` rather than rejecting,
  // so caching it would 503 every gated route for the life of the process — and
  // `github-adapter`'s `classify` cannot tell a rate-limit 403 from a permissions 403,
  // so plain throttling was enough to poison it.
  const cache = new Map<string, { snapshot: CollabAvailability; expiresAt: number }>();

  async function availability(): Promise<CollabAvailability> {
    const repo = deps.config().collaboration;
    if (!repo) return NOT_CONFIGURED;
    const key = `${repo.owner}/${repo.repo}#${repo.baseBranch}@${credentialFingerprint(deps.env)}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > clock()) return cached.snapshot;
    const result = await runPreflight(repo);
    if (!result.available) {
      cache.delete(key);
      return {
        available: false,
        reason: result.reason,
        message: result.message,
        missingScopes: result.missingScopes,
      };
    }
    const snapshot: CollabAvailability = {
      available: true,
      repo: result.repo,
      login: result.login,
      scopes: result.scopes,
    };
    cache.set(key, { snapshot, expiresAt: clock() + preflightTtl });
    return snapshot;
  }

  /**
   * Availability + authorization in one step, because no GitHub-touching route may skip
   * either. Resolves to the enabled context or to the response to send instead.
   */
  async function gate(
    op: CollabOperation,
    documentId: string | null,
  ): Promise<{ ok: true; repo: ResolvedCollaborationConfig; login: string } | { ok: false; result: CollabRouteResult }> {
    const state = await availability();
    // R-7.8 — "off" is a 503 carrying the same payload the UI already understands,
    // never a 500 and never a thrown error.
    if (!state.available) return { ok: false, result: { status: 503, json: state } };
    const verdict = await authorize(op, { documentId, login: state.login, repo: state.repo });
    if (!verdict.ok) return { ok: false, result: { status: verdict.status, json: { error: verdict.error } } };
    return { ok: true, repo: state.repo, login: state.login };
  }

  /** Load a document, or the response to send when it is unknown. */
  async function load(
    documentId: string,
  ): Promise<{ ok: true; document: CollaborationRecord } | { ok: false; result: CollabRouteResult }> {
    const document = await deps.documents().read(documentId);
    if (!document) return { ok: false, result: { status: 404, json: { error: `unknown document: ${documentId}` } } };
    return { ok: true, document };
  }

  /** Resolve the comment store for a document, or the response to send instead. */
  async function commentsFor(
    documentId: string,
    document: CollaborationRecord,
    repo: ResolvedCollaborationConfig,
  ): Promise<{ ok: true; store: CollabCommentStore } | { ok: false; result: CollabRouteResult }> {
    const store = deps.commentStore
      ? await deps.commentStore({ documentId, document, repo })
      : defaultCommentStore(documentId, document);
    if (!store) {
      return {
        ok: false,
        result: { status: 409, json: { error: `document ${documentId} has no pull request yet — run start or open first` } },
      };
    }
    // The intent methods are optional on `CommentDocStore` (a snapshot-only store is
    // still valid for local mode), but a collaborative conversation has no snapshot to
    // swap — `write(doc)` cannot express "post this one comment" or return its id.
    if (!store.addComment || !store.updateComment) {
      return { ok: false, result: { status: 501, json: { error: 'comment store does not support collaborative comments' } } };
    }
    return { ok: true, store: store as CollabCommentStore };
  }

  /**
   * Resolve the review-comment context for a document, or the response to send instead.
   * The same 409 the comment-store path answers, for the same reason: a document with no
   * Pull Request has nowhere to host a conversation.
   */
  function reviewFor(
    documentId: string,
    document: CollaborationRecord,
    repo: ResolvedCollaborationConfig,
  ): { ok: true; ctx: ReviewContext } | { ok: false; result: CollabRouteResult } {
    const binding = bindingOf(document);
    if (!binding) {
      return {
        ok: false,
        result: { status: 409, json: { error: `document ${documentId} has no pull request yet — run start or open first` } },
      };
    }
    const adapter = deps.adapter ? deps.adapter({ documentId, document, repo }) : createGitHubAdapter();
    return {
      ok: true,
      ctx: { adapter, repoRef: { owner: binding.owner, repo: binding.repo }, pullNumber: binding.pullNumber as number },
    };
  }

  /*
   * R-5.11 — comment-creation idempotency.
   *
   * The trailer-carried key the issue-comment store used is gone with the trailer: R-5.4
   * forbids writing a machine-readable reference into a review comment's body, so there
   * is nothing on GitHub to read a key back off, and `POST /pulls/:n/comments` offers no
   * `Idempotency-Key` header either. The deduplication therefore lives here.
   *
   * It is the in-flight **promise** that is keyed, not the finished result, and that is
   * what makes it cover the case the requirement names: a client that gave up on a slow
   * create and retried joins the request already running instead of starting a second
   * one. The entry outlives the response, so a retry sent after the answer was lost still
   * resolves to the first comment. A failure is dropped, so retrying something that
   * failed genuinely retries.
   *
   * Scope is this process. A create in flight across a server restart can still
   * duplicate — narrowed, not closed, exactly as the issue-comment store's
   * read-before-write was, and detectable afterwards on GitHub.
   */
  const pendingCreates = new Map<string, Promise<CollabRouteResult>>();

  function onceByKey(key: string | undefined, run: () => Promise<CollabRouteResult>): Promise<CollabRouteResult> {
    if (!key) return run();
    const inFlight = pendingCreates.get(key);
    if (inFlight) return inFlight;
    const promise = run().then(
      (result) => {
        // Only a success is worth remembering; a failed create must stay retryable.
        if (result.status < 200 || result.status >= 300) pendingCreates.delete(key);
        return result;
      },
      (err: unknown) => {
        pendingCreates.delete(key);
        throw err;
      },
    );
    pendingCreates.set(key, promise);
    return promise;
  }

  async function handle(req: CollabRequest): Promise<CollabRouteResult> {
    const { method, pathname, body } = req;
    try {
      /* GET /__vs/collab — R-7.8, the flag the UI renders (or hides) controls on. */
      if (method === 'GET' && (pathname === '' || pathname === '/')) {
        const state = await availability();
        if (!state.available) return { status: 200, json: state };
        // The publish hint (R-9.7) is added HERE and not inside `availability()`, which
        // every gated route shares: a reviewer operation must not pay for — or depend on —
        // a write-access probe (R-9.8). It reuses the authorizer's own permission cache,
        // so it costs at most one `gh api` per repo per TTL. A refusal or an outage leaves
        // the field off rather than guessing either way.
        // R-12.5 — when the answer is "no", say which no. `publishBlocked` carries the
        // remediation the author would otherwise only meet at publish time, or never at
        // all in the `no_repo` case. The outage answer still leaves both fields off.
        const verdict = (await authorize.writeAccess?.(state.repo)) ?? { write: null, reason: 'unknown' };
        if (verdict.write === null) return { status: 200, json: state };
        if (verdict.write) return { status: 200, json: { ...state, canPublish: true } };
        return {
          status: 200,
          json: {
            ...state,
            canPublish: false,
            publishBlocked: { reason: verdict.reason, message: verdict.message },
          },
        };
      }

      /* POST /__vs/collab/start (R-8.5, R-8.27 … R-8.32) */
      if (method === 'POST' && pathname === '/start') {
        const documentId = requireString(body, 'documentId');
        if (!DOCUMENT_ID_RE.test(documentId)) return bad(`invalid documentId: ${documentId}`);
        const documentPath = requireString(body, 'documentPath');
        /*
         * R-8.31 / R-8.32 — validated here, before `gate` and long before a branch could
         * exist. Both requirements say the *whole* request is refused, and the only place
         * that is cheap to guarantee is the one where nothing has happened yet: once the
         * create job is running, "reject" means unwinding a branch.
         */
        const companions = parseCompanions(body.files, documentPath);
        if (!companions.ok) return bad(companions.message);
        const gated = await gate('create', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);

        /*
         * Materialize the document before the job runs. `create` commits what
         * `store.read(documentId)` returns and throws when that is null, so without this
         * the route accepted a request no job could complete — the operation was
         * reachable and the path through it was not.
         *
         * Seed only when absent. A retried `start` (R-8.23) must find the document it
         * created the first time, not a blank one: overwriting here would silently
         * discard an author's content on a double click.
         */
        const store = deps.documents();
        if (!(await store.read(documentId))) {
          await store.write(
            newCollaborationRecord({
              documentId,
              documentPath,
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.markdown === 'string' ? { markdown: body.markdown } : {}),
              ...(companions.files.length ? { companions: companions.files } : {}),
            }),
          );
        }

        return deps.jobs.hub(documentId).start({
          kind: 'create',
          idempotencyKey,
          run: bodies.create({
            documentId,
            documentPath,
            repo: gated.repo,
            store: deps.documents(),
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(typeof body.markdown === 'string' ? { markdown: body.markdown } : {}),
            ...(companions.files.length ? { companions: companions.files } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        });
      }

      /* POST /__vs/collab/open — attach to a Pull Request that already exists. */
      if (method === 'POST' && pathname === '/open') {
        const documentId = requireString(body, 'documentId');
        if (!DOCUMENT_ID_RE.test(documentId)) return bad(`invalid documentId: ${documentId}`);
        const pullNumber = body.pullNumber;
        if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber <= 0) {
          return bad('missing pullNumber');
        }
        const gated = await gate('open', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);
        // `open` is NOT a sync job, however much it rhymes with one. Sync pulls comments;
        // open fetches the whole document off the branch and rewrites the local copy. The
        // browser reads the kind off the `job-done` frame to decide what to re-read, and
        // it correctly skips the document read for comment-only kinds — so labelling this
        // `sync` left a reviewer looking at the seed document until they reloaded the page.
        return deps.jobs.hub(documentId).start({
          kind: 'open',
          idempotencyKey,
          run: bodies.open({
            documentId,
            pullNumber,
            // R-11.8 — the discard is a request, so it is read off the request.
            ...(body.discardLocal === true ? { discardLocal: true } : {}),
            repo: gated.repo,
            store: deps.documents(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        });
      }

      /*
       * `/pulls/*` — the repo-level family, and it MUST stay above the document-scoped
       * match below. That match takes the first path segment as a documentId, and `pulls`
       * satisfies `DOCUMENT_ID_RE`, so a family placed after it is not merely unreachable —
       * it is silently answered by the wrong handler: `GET /pulls` becomes the status
       * snapshot of a document called "pulls" and returns `200` with an empty document.
       * Nothing about that reads as a routing bug from the client, which is why the
       * ordering is asserted in `collab.pulls.test.ts` rather than left to a comment.
       *
       * Every route in the family is a READ (`read` is `any-role`, R-9.8). Mounting looks
       * like a write because it puts files on disk, but what it writes is a detached,
       * read-only checkout in this user's own working directory — nothing reaches GitHub,
       * and gating it author-only would lock reviewers out of the one feature that exists
       * for them.
       */

      /* GET /__vs/collab/pulls — which Pull Requests can I review? */
      if (method === 'GET' && (pathname === '/pulls' || pathname === '/pulls/')) {
        const state = req.query.state ?? 'open';
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
          return bad(`invalid state: ${state} — expected open, closed or all`);
        }
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;
        try {
          const pulls = await repoAdapter().listPullRequests(repoRefOf(gated.repo), state as PullRequestListState);
          return { status: 200, json: { pulls } };
        } catch (err) {
          if (err instanceof GitHubError) return githubFailure(err);
          throw err;
        }
      }

      /*
       * GET /__vs/collab/pulls/mounted — what is checked out right now.
       *
       * Answered from git's own worktree registry rather than from anything this process
       * remembers, so a mount made by a previous run of the server, or a worktree removed
       * by hand, is reported correctly on the first request after a restart.
       */
      if (method === 'GET' && pathname === '/pulls/mounted') {
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;
        return { status: 200, json: { worktrees: await listMountedWorktrees(baseDir(), git) } };
      }

      const mount = /^\/pulls\/([^/]+)\/mount$/.exec(pathname);
      if (mount && (method === 'POST' || method === 'DELETE')) {
        const pullNumber = parsePullNumber(mount[1]!);
        if (pullNumber === null) return bad(`invalid pullNumber: ${mount[1]!}`);
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;

        /* DELETE — "already gone" is the outcome the caller wanted, so it is a 200. */
        if (method === 'DELETE') {
          const removed = await unmountPullRequest(baseDir(), pullNumber, git);
          return { status: 200, json: { ok: true, removed } };
        }

        const result = await mountPullRequest(baseDir(), pullNumber, git);
        if (!result.ok) {
          const { status, message } = MOUNT_FAILURE[result.reason];
          return { status, json: { error: message, reason: result.reason } };
        }
        return { status: 200, json: { ok: true, worktree: result.worktree } };
      }

      /*
       * GET /__vs/collab/pulls/:n/files — the paths the Pull Request changed.
       *
       * The head is named by **sha**, not by branch: a pull request from a fork has a head
       * branch that does not exist on this repository, and comparing against its name
       * would 404 for exactly the contributors a reviewer most needs to read.
       */
      /*
       * GET /__vs/collab/pulls/:n/description — what the pull request SAYS it is (R-13.1).
       *
       * The listing deliberately does not carry bodies: it is every open pull request, and
       * a body is unbounded prose that most rows will never have read. So the description
       * is its own read, made once, for the row a reviewer actually opened.
       *
       * IT SERVES THE BODY AND NOT THE DETAIL. `getPullRequest` answers merge state, head
       * sha, both branches — all of which the listing already gave the browser, and two of
       * which (`mergeable`, `mergeableState`) it has no way to keep current. Handing the
       * whole record over would put a second, staler copy of those facts on the same screen
       * as the first. The body is the one field the browser does not already have.
       *
       * A `read` gate, like the listing: reading a description writes nothing.
       */
      const pullDescription = /^\/pulls\/([^/]+)\/description$/.exec(pathname);
      if (pullDescription && method === 'GET') {
        const pullNumber = parsePullNumber(pullDescription[1]!);
        if (pullNumber === null) return bad(`invalid pullNumber: ${pullDescription[1]!}`);
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;
        try {
          const pull = await repoAdapter().getPullRequest(repoRefOf(gated.repo), pullNumber);
          // An empty body is a real answer — the pull request has no description — and the
          // UI says so in its own words. `null` would make "none" indistinguishable from
          // "not read yet".
          return { status: 200, json: { pullNumber, body: pull.body ?? '' } };
        } catch (err) {
          if (err instanceof GitHubError) return githubFailure(err);
          throw err;
        }
      }

      const pullFiles = /^\/pulls\/([^/]+)\/files$/.exec(pathname);
      if (pullFiles && method === 'GET') {
        const pullNumber = parsePullNumber(pullFiles[1]!);
        if (pullNumber === null) return bad(`invalid pullNumber: ${pullFiles[1]!}`);
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;
        const repoRef = repoRefOf(gated.repo);
        try {
          const adapter = repoAdapter();
          const pull = await adapter.getPullRequest(repoRef, pullNumber);
          const comparison = await adapter.compareCommits(repoRef, pull.baseBranch, pull.headSha);
          return {
            status: 200,
            json: {
              pullNumber,
              headSha: pull.headSha,
              baseBranch: pull.baseBranch,
              headBranch: pull.headBranch,
              mergeBaseSha: comparison.mergeBaseSha,
              files: comparison.files,
            },
          };
        } catch (err) {
          if (err instanceof GitHubError) return githubFailure(err);
          throw err;
        }
      }

      /*
       * `/pulls/:n/drafts*` — the held review comments of a checked-out Pull Request
       * (R-13.13 … R-13.18). Part of the `/pulls` family and therefore still ABOVE the
       * scoped match, for the reason spelled out at the top of the family.
       *
       * WHY THESE ARE NOT DOCUMENT-SCOPED. A reviewer reading a mounted Pull Request is
       * reading a *tree*, not one collaboration document: the file they comment on may
       * never have been published through this tool and has no `CollaborationRecord`, no
       * binding and no job hub. Hanging the drafts off `/:documentId` would mean minting a
       * document for a file nobody is collaborating on, and the whole of Unit 13 exists
       * precisely so a reviewer does not have to.
       *
       * THE AUTHORIZATION OPERATION IS `read` FOR THE LOCAL ONES AND `comment` FOR
       * PUBLISH. Writing, listing and deleting a draft never leaves this machine — the
       * bytes land in the git-ignored `.visual-spec/reviews/` (R-13.13) — so `read` is
       * both sufficient and honest; a stronger op would lock reviewers out of the feature
       * built for them. Publishing DOES contact GitHub, and what it creates there is a
       * pull-request review comment, which is exactly what `OPERATION_POLICY` already
       * classifies as `comment`: `any-role`, R-9.8, and COLLABORATION.md's table states
       * that commenting needs no write access. Gating it `publish` would be wrong twice —
       * `publish` is author-only and means "commit the document to the branch", which this
       * does not do.
       */

      const draftsList = /^\/pulls\/([^/]+)\/drafts$/.exec(pathname);
      if (draftsList && (method === 'GET' || method === 'POST')) {
        const pullNumber = parsePullNumber(draftsList[1]!);
        if (pullNumber === null) return bad(`invalid pullNumber: ${draftsList[1]!}`);

        /* GET — everything held for this Pull Request, published records included
         * (R-13.17: a published comment is retained, not deleted, so the reviewer can see
         * what they already sent alongside what they have not). Ordering is creation
         * order, straight off the store. */
        if (method === 'GET') {
          const gated = await gate('read', null);
          if (!gated.ok) return gated.result;
          return { status: 200, json: { drafts: await readReviewDrafts(baseDir(), pullNumber) } };
        }

        /*
         * POST — hold a comment locally. Validated fully before the gate, and long before
         * disk: the same order `POST /:id/publish` uses, so a malformed body is a 400 that
         * needs no credential and touches no filesystem.
         */
        const path = requireString(body, 'path');
        const comment = requireString(body, 'comment');
        const headSha = requireString(body, 'headSha');
        // `line` is the single-line spelling the file tree sends; `startLine`/`endLine` is
        // the range spelling `POST /:id/comments` already takes. Accepting both here means
        // the client that has one line does not have to pretend it has a range.
        const startLine = optionalLine(body, 'startLine') ?? optionalLine(body, 'line');
        const endLine = optionalLine(body, 'endLine');
        if (startLine === undefined && endLine !== undefined) return bad('endLine without startLine');
        if (startLine !== undefined && endLine !== undefined && endLine < startLine) return bad('endLine precedes startLine');
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;
        try {
          const draft = await addReviewDraft(baseDir(), pullNumber, {
            path,
            comment,
            headSha,
            ...(startLine !== undefined ? { startLine } : {}),
            ...(endLine !== undefined ? { endLine } : {}),
            ...(typeof body.snippet === 'string' && body.snippet ? { snippet: body.snippet } : {}),
            ...(typeof body.heading === 'string' || body.heading === null ? { heading: body.heading as string | null } : {}),
          });
          return { status: 200, json: { ok: true, draft } };
        } catch (err) {
          // The store's own path guard (a target that would escape the worktree root). It
          // throws rather than returning, and a traversal attempt is the caller's mistake.
          return bad((err as Error).message);
        }
      }

      const draftItem = /^\/pulls\/([^/]+)\/drafts\/([^/]+)$/.exec(pathname);
      if (draftItem && method === 'DELETE') {
        const pullNumber = parsePullNumber(draftItem[1]!);
        if (pullNumber === null) return bad(`invalid pullNumber: ${draftItem[1]!}`);
        const draftId = draftItem[2]!;
        if (!DRAFT_ID_RE.test(draftId)) return bad(`invalid draftId: ${draftId}`);
        const gated = await gate('read', null);
        if (!gated.ok) return gated.result;
        try {
          // "Already gone" is the outcome the caller asked for, so it is a 200 with
          // `removed: false` — the same answer `DELETE /pulls/:n/mount` gives.
          return { status: 200, json: { ok: true, removed: await deleteReviewDraft(baseDir(), pullNumber, draftId) } };
        } catch {
          /*
           * R-13.17 — the store refuses to delete a published record, and this is the
           * status for it: the request was well formed, the state it addresses forbids it.
           * Deleting it would destroy the only local evidence that the comment went out,
           * which is the evidence R-13.16's gate below reads. The comment itself is still
           * on GitHub either way, so the deletion would not even mean what it looks like —
           * withdrawing it is a github.com action.
           */
          return {
            status: 409,
            json: {
              error:
                `${draftId} has already been published to pull request #${pullNumber}, so the local record cannot be deleted — ` +
                'it is what stops the comment being posted a second time. Delete the comment on github.com instead.',
              reason: 'already-published',
            },
          };
        }
      }

      const draftPublish = /^\/pulls\/([^/]+)\/drafts\/([^/]+)\/publish$/.exec(pathname);
      if (draftPublish && method === 'POST') {
        const pullNumber = parsePullNumber(draftPublish[1]!);
        if (pullNumber === null) return bad(`invalid pullNumber: ${draftPublish[1]!}`);
        const draftId = draftPublish[2]!;
        if (!DRAFT_ID_RE.test(draftId)) return bad(`invalid draftId: ${draftId}`);
        const gated = await gate('comment', null);
        if (!gated.ok) return gated.result;

        const draft = (await readReviewDrafts(baseDir(), pullNumber)).find((d) => d.id === draftId);
        if (!draft) return { status: 404, json: { error: `unknown draft: ${draftId}` } };

        /*
         * R-13.16 LIVES HERE — "requesting publication twice results in at most one
         * comment on the pull request".
         *
         * `markDraftPublished` is first-write-wins, but that is a guarantee about the
         * FILE, not about the network: it runs *after* the POST, so on its own it would
         * happily record one id while GitHub had already been given two comments. The
         * duplicate has to be stopped before the call, and the only fact that survives a
         * restart, a second browser tab or a lost response is the one on disk. So the
         * draft is re-read from disk here — not taken from the request, not from a cache —
         * and a record that is no longer `draft` short-circuits.
         *
         * It answers 200, not 409 or 304. "This comment is on the pull request and here is
         * its link" is precisely what the caller asked for and precisely what it got the
         * first time; an error would push every client into distinguishing a failed
         * publish from a redundant one, and the ones that got it wrong would retry. The
         * `alreadyPublished` flag is there for a client that wants to say "already sent"
         * rather than "sent" — nothing more depends on it.
         *
         * What this does NOT close, deliberately: two publishes racing within the same few
         * milliseconds both read `draft` and both post. Closing it needs a lock file or a
         * "publishing" reservation state, and `review-drafts.ts` weighs and rejects both
         * for the same reason — it costs a stuck-lock recovery path to defend against two
         * humans sharing one checkout. Sequential retries, the case the requirement is
         * actually about, are closed.
         */
        if (draft.status !== 'draft') {
          return { status: 200, json: { ok: true, alreadyPublished: true, draft } };
        }

        const repoRef = repoRefOf(gated.repo);
        const adapter = repoAdapter();
        try {
          // R-4.13 — the head GitHub will anchor against, read now. The `headSha` on the
          // draft is the head it was WRITTEN against and is deliberately not used as the
          // commit id: that is the whole distinction the staleness check below rests on.
          const pull = await adapter.getPullRequest(repoRef, pullNumber);

          /*
           * R-13.14's payoff. The draft names a line in a tree that has since moved, and
           * GitHub would anchor it to whatever now sits at that line — confidently wrong,
           * in the author's inbox, with the reviewer's name on it. So it is refused, both
           * shas named, and the refusal is 409 for the same reason the delete above is:
           * the request is fine, the state is not.
           *
           * `force: true` exists because the alternative is worse. Most head moves do not
           * touch the file being commented on, and a hard refusal would mean re-typing the
           * comment after every push — so the reviewer is given the fact and the choice
           * rather than a wall. It is opt-in per request and never a default, so nothing
           * publishes against a moved head without someone having said so.
           */
          if (isStale(draft, pull.headSha) && body.force !== true) {
            return {
              status: 409,
              json: {
                error:
                  `This comment was written against ${draft.headSha}, and pull request #${pullNumber} is now at ` +
                  `${pull.headSha}. Publishing it now would anchor it to whatever currently sits at that line. ` +
                  'Re-mount the pull request and check the line still says what you meant, or send `force: true` to publish anyway.',
                reason: 'stale-draft',
                draftHeadSha: draft.headSha,
                currentHeadSha: pull.headSha,
              },
            };
          }

          const { created, degraded } = await createReviewCommentWithPolicy(
            { adapter, repoRef, pullNumber },
            {
              path: draft.target.path,
              comment: draft.comment,
              commitId: pull.headSha,
              ...draftLines(draft),
              ...(draft.target.snippet ? { selectedText: draft.target.snippet } : {}),
            },
          );

          // R-13.17 — the record is kept and marked, never removed. `alreadyPublished` can
          // still come back true from a write that raced this one; the store's
          // first-write-wins means the stored link is the first publisher's, and reporting
          // it is more honest than overwriting it with ours.
          const marked = await markDraftPublished(baseDir(), pullNumber, draftId, {
            reviewCommentId: created.id,
            htmlUrl: created.htmlUrl,
          });
          return {
            status: 200,
            json: {
              ok: true,
              alreadyPublished: marked.alreadyPublished,
              draft: marked.draft,
              comment: projectCreated(created),
              ...(degraded ? { degraded } : {}),
            },
          };
        } catch (err) {
          // A failed publish leaves the record a `draft`, which is the correct resting
          // state: nothing on GitHub, and the comment still retryable.
          if (err instanceof GitHubError) return githubFailure(err);
          throw err;
        }
      }

      // Everything below is document-scoped. One match, then a switch on the tail —
      // hand-rolled to match the rest of `/__vs`, no router library.
      const scoped = /^\/([^/]+)(\/.*)?$/.exec(pathname);
      if (!scoped) return notFound(method, pathname);
      const documentId = scoped[1]!;
      const tail = scoped[2] ?? '';
      if (!DOCUMENT_ID_RE.test(documentId)) return bad(`invalid documentId: ${documentId}`);

      /* GET /__vs/collab/:id — R-8.4 status snapshot a late subscriber recovers from. */
      if (method === 'GET' && (tail === '' || tail === '/')) {
        const snapshot = deps.jobs.hub(documentId).snapshot();
        const document = await deps.documents().read(documentId);
        return {
          status: 200,
          json: {
            ...snapshot,
            document: document
              ? { documentId: document.documentId, documentPath: document.documentPath, title: document.title, github: bindingOf(document) }
              : null,
          },
        };
      }

      /*
       * GET /__vs/collab/:id/document — R-7.3 / R-7.9. The Markdown as it stands on the
       * Pull Request branch, which the review surface renders and the anchor resolver
       * locates `data-vs-loc` blocks in. Deliberately NOT folded into `GET /:id`:
       * that body is also the SSE `sync` frame (`JobSync = { type:'sync' } & JobSnapshot`,
       * `collaboration/job-hub.ts`), so widening it would push the whole document down
       * the stream on every job transition. Served from our own store, so the browser
       * still issues no GitHub call (R-7.7).
       */
      if (method === 'GET' && tail === '/document') {
        const gated = await gate('read', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        return { status: 200, json: loaded.document };
      }

      /*
       * GET /__vs/collab/:id/comments — R-5.7 / R-6.5, the conversation the
       * document-level discussion view presents (orphaned and node-less comments
       * included; this route filters nothing). Read through the same `commentsFor`
       * store the POST/PATCH routes write through, so GitHub stays the system of record
       * (R-5.2) and the read stays server-side (R-7.7). Gated and authorized exactly as
       * its siblings are — `read` is `any-role` (R-9.8), so a reviewer may list.
       */
      if (method === 'GET' && tail === '/comments') {
        const gated = await gate('read', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const review = reviewFor(documentId, loaded.document, gated.repo);
        if (!review.ok) return review.result;
        const { adapter, repoRef, pullNumber } = review.ctx;

        /*
         * R-4.12 / R-5.15 — resolution is a GraphQL read alongside a REST one, and it can
         * fail on its own. When it does the conversation is still served; every thread
         * simply carries no `isResolved`, which the projection renders as "unknown". The
         * one answer forbidden here is `false`: "nobody resolved it" and "we could not ask"
         * drive different UI and a different Ready gate (R-8.25).
         */
        let resolutions: ThreadResolution[] | undefined;
        try {
          resolutions = [...(await adapter.listThreadResolution(repoRef, pullNumber))];
        } catch {
          resolutions = undefined;
        }

        /*
         * R-5.17 accumulates every page before grouping, R-6.3 / R-6.7 capture the text an
         * outdated thread was written about and re-anchor it on an exact unique match, and
         * R-4.15 joins resolution on the root's REST integer id. All three live in
         * `loadReviewThreadRecords`, which is handed the document text so re-anchoring has
         * something to search — the Markdown this document *is* (R-0.1).
         */
        const projected = await loadReviewThreadRecords(adapter, repoRef, pullNumber, loaded.document.markdown, {
          documentPath: loaded.document.documentPath,
          ...(resolutions ? { resolutions } : {}),
        });
        return { status: 200, json: projected };
      }

      /* GET /__vs/collab/:id/events — R-8.2 SSE. `subscribe` writes the head itself. */
      if (method === 'GET' && tail === '/events') {
        if (!req.sse) return bad('events requires a streaming response');
        deps.jobs.hub(documentId).subscribe(req.sse);
        return { status: 200, json: null, streamed: true };
      }

      /* POST /__vs/collab/:id/sync — R-8.6 / R-8.7, the one sync entrypoint. */
      if (method === 'POST' && tail === '/sync') {
        const gated = await gate('sync', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);
        return deps.jobs.hub(documentId).start({
          kind: 'sync',
          idempotencyKey,
          run: bodies.sync({
            documentId,
            document: await deps.documents().read(documentId),
            repo: gated.repo,
            store: deps.documents(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        });
      }

      /*
       * POST /__vs/collab/:id/reconcile — R-8.18. The recovery entrypoint for a document
       * whose local state and GitHub disagree, including the partial create that left a
       * branch with no Pull Request behind it. It re-derives state from GitHub and may
       * delete that orphan branch, so it is author-only.
       */
      if (method === 'POST' && tail === '/reconcile') {
        const gated = await gate('reconcile', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);
        return deps.jobs.hub(documentId).start({
          kind: 'reconcile',
          idempotencyKey,
          run: bodies.reconcile({ documentId, repo: gated.repo, store: deps.documents() }),
        });
      }

      /*
       * POST /__vs/collab/:id/ready — R-8.15. Readiness is re-derived from GitHub inside
       * the body; neither this route nor the hub's held state is consulted, which is
       * exactly what the requirement forbids trusting.
       */
      if (method === 'POST' && tail === '/ready') {
        const gated = await gate('mark-ready', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);
        return deps.jobs.hub(documentId).start({
          kind: 'ready',
          idempotencyKey,
          run: bodies.markReady({ documentId, repo: gated.repo, store: deps.documents() }),
        });
      }

      /* POST /__vs/collab/:id/publish — R-8.9 payload validation is route-layer. */
      if (method === 'POST' && tail === '/publish') {
        // Validated BEFORE the gate so R-12.7's assertion holds without a credential:
        // an incomplete payload is a malformed request, not an authorization problem.
        // R-8.9 — `markdown` is the entire payload; a request that omits it is rejected.
        if (typeof body.markdown !== 'string') return bad('missing markdown');
        const gated = await gate('publish', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);
        return deps.jobs.hub(documentId).start({
          kind: 'publish',
          idempotencyKey,
          run: bodies.publish({
            documentId,
            document: await deps.documents().read(documentId),
            markdown: body.markdown,
            repo: gated.repo,
            store: deps.documents(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        });
      }

      /*
       * POST /__vs/collab/:id/comments — R-5.4 / R-7.5, a PR **review** comment anchored
       * on `path` + line.
       *
       * `path` defaults to the document's own path: the review surface renders one
       * document (R-7.9), and a client that names no other file means that one. A request
       * with no `startLine` is a document-level comment and is posted file-level by intent.
       */
      if (method === 'POST' && tail === '/comments') {
        const text = requireString(body, 'comment');
        const startLine = optionalLine(body, 'startLine');
        const endLine = optionalLine(body, 'endLine');
        if (startLine !== undefined && endLine !== undefined && endLine < startLine) return bad('endLine precedes startLine');
        /*
         * The routing tag the panel's "Apply via" control sets: which skill handles this
         * comment. It says nothing about whether the comment is worth acting on — both of
         * its values mean "actionable", they differ on by whom. It survives on the response
         * only: R-5.4 forbids writing a machine-readable reference into the body, so GitHub
         * has nowhere to keep it.
         */
        const workflow = typeof body.workflow === 'string' && body.workflow.trim() ? body.workflow.trim() : undefined;
        // R-7.12's raw material. The browser holds the selected text; the server does not
        // re-read the branch for it, which would be a second answer to what was selected.
        const selectedText = typeof body.selectedText === 'string' && body.selectedText ? body.selectedText : undefined;
        const gated = await gate('comment', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const review = reviewFor(documentId, loaded.document, gated.repo);
        if (!review.ok) return review.result;
        const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : loaded.document.documentPath;

        // R-5.11 — the whole create runs under the key, so a retry joins the first attempt
        // rather than posting a second comment.
        const key = optionalKey(body);
        return onceByKey(key ? `${documentId}:${key}` : undefined, async () => {
          try {
            const { created, degraded } = await createReviewCommentWithPolicy(review.ctx, {
              path,
              comment: text,
              ...(startLine !== undefined ? { startLine } : {}),
              ...(endLine !== undefined ? { endLine } : {}),
              ...(selectedText ? { selectedText } : {}),
            });
            const record = projectCreated(created, workflow);
            return {
              status: 200,
              json: {
                ok: true,
                id: record.id,
                comment: record,
                // R-7.13 — the caller is told it degraded and why, in GitHub's own words.
                ...(degraded ? { degraded } : {}),
              },
            };
          } catch (err) {
            // R-7.14 — the cause is reported; the text the user typed is theirs and is
            // never consumed by a failed create, so the panel can re-submit it unchanged.
            if (err instanceof GitHubError) return githubFailure(err);
            throw err;
          }
        });
      }

      /*
       * POST /__vs/collab/:id/comments/:commentId/reply — R-7.15.
       *
       * Replies are NATIVE now: GitHub's replies endpoint attaches the reply to the
       * thread and the reply inherits the thread's anchor, so nothing here computes a
       * position or writes a `replyTo` marker into a body (R-5.4). `commentId` decodes
       * through the same `c-<8hex>` bijection `PATCH` uses; the integer it carries is the
       * thread root's, which is what the endpoint keys on (R-5.19).
       *
       * An unknown root is GitHub's 404, not a local list lookup — the list is not read
       * here, so a reply costs one request rather than a page walk plus one.
       */
      const reply = /^\/comments\/([^/]+)\/reply$/.exec(tail);
      if (reply && method === 'POST') {
        const commentId = reply[1]!;
        if (!COMMENT_ID_RE.test(commentId)) return bad(`invalid commentId: ${commentId}`);
        const rootId = reviewCommentIdFor(commentId);
        if (rootId === null) return bad(`invalid commentId: ${commentId}`);
        const text = requireString(body, 'comment');
        const gated = await gate('reply', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const review = reviewFor(documentId, loaded.document, gated.repo);
        if (!review.ok) return review.result;
        const { adapter, repoRef, pullNumber } = review.ctx;
        try {
          const created = await adapter.replyToReviewComment(repoRef, pullNumber, rootId, text);
          const record = projectCreated(created);
          return { status: 200, json: { ok: true, id: record.id, comment: record } };
        } catch (err) {
          if (err instanceof GitHubError) return githubFailure(err);
          throw err;
        }
      }

      /* PATCH /__vs/collab/:id/comments/:commentId */
      const single = /^\/comments\/([^/]+)$/.exec(tail);
      if (single && method === 'PATCH') {
        const commentId = single[1]!;
        if (!COMMENT_ID_RE.test(commentId)) return bad(`invalid commentId: ${commentId}`);
        const gated = await gate('edit-comment', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const store = await commentsFor(documentId, loaded.document, gated.repo);
        if (!store.ok) return store.result;
        const patch: CommentPatch = {
          ...('status' in body ? { status: body.status as CommentStatus } : {}),
          ...(typeof body.result === 'string' ? { result: body.result } : {}),
          ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
        };

        /*
         * A `status` change is NOT a resolution (R-5.21). It records whether the local
         * apply agent has acted on a comment, it stays local, and it is never written back
         * to GitHub. Resolution is GitHub's review-thread `isResolved`: read on
         * `GET /:id/comments`, never written from anywhere in this package (R-5.13), and
         * changed by a reviewer on github.com. This route used to post a marker reply here;
         * that protocol is gone, and with it the second, disagreeing source of truth.
         *
         * So everything goes through `updateComment`, which is the store's own business:
         * a local store records the status, and the GitHub-backed store answers with the
         * record unchanged because the text is what it can express.
         */
        const updated = await store.store.updateComment(commentId, patch);
        if (!updated) return { status: 404, json: { error: `unknown comment: ${commentId}` } };
        return { status: 200, json: { ok: true, comment: updated } };
      }

      return notFound(method, pathname);
    } catch (err) {
      // `hub()` throws on a documentId failing DOCUMENT_ID_RE, and `requireString`
      // throws on a missing field — both are malformed requests, so 400 (not 500).
      return bad((err as Error).message);
    }
  }

  return {
    handle,
    availability,
    dispose() {
      deps.jobs.disposeAll();
    },
  };
}
