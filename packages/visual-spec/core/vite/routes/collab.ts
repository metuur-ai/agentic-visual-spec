/**
 * routes/collab.ts — the `/__vs/collab/*` route family (R-7.1).
 *
 * THIS IS THE ROUTE LAYER AND NOTHING ELSE. It parses and validates a request,
 * resolves configuration / availability / the document, and then either calls a
 * landed module (`DocumentStore`, `CommentDocStore`) or hands a **job body** to
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
import { COLLAB_TARGET_TEXT_KEY, captureTargetText, collabNodeVersion } from '../../collaboration/anchor-resolution';
import { type CollaborationPreflight, preflightCollaboration } from '../../collaboration/credentials';
import { githubCommentStore } from '../../collaboration/comment-projection';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import type { GitHubBinding } from '../../collaboration/document-protocol';
import type { CollaborationDocument, DocumentFrontmatter, JsonDocument } from '../../collaboration/document-protocol';
import { DOCUMENT_ID_RE, type DocumentStore } from '../../collaboration/document-store';
import type { JobBody, JobHubRegistry, SseSink } from '../../collaboration/job-hub';
import { DEFAULT_WORKFLOW, type CommentRecord, type CommentStatus } from '../../editing/comment-doc';
import { randomHex8 } from '../../editing/id';
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
    'Collaboration is not configured. Add a `collaboration: { owner, repo }` block to visual-spec.config.ts to enable it. Local mode is unaffected.',
  missingScopes: [],
};

/* ------------------------------------------------------------------ *
 * Job body injection — the 8.2 / 8.3 seam
 * ------------------------------------------------------------------ */

/** Everything a body gets for free, whatever the job. */
type JobInputBase = {
  documentId: string;
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
  idempotencyKey?: string;
};

/** `POST /__vs/collab/start` — task 8.2 (R-8.5). */
export type CreateJobInput = JobInputBase & {
  documentPath: string;
  title?: string;
  frontmatter?: DocumentFrontmatter;
  doc?: JsonDocument;
};

/** `POST /__vs/collab/open` — task 8.2: attach to an already-open Pull Request. */
export type OpenJobInput = JobInputBase & { pullNumber: number };

/** `POST /__vs/collab/:id/sync` — task 8.2 (R-8.6 / R-8.7). */
export type SyncJobInput = JobInputBase & { document: CollaborationDocument | null };

/** `POST /__vs/collab/:id/publish` — task 8.3 (R-8.9 … R-8.14). */
export type PublishJobInput = JobInputBase & {
  document: CollaborationDocument | null;
  /** The structured document, exactly as received. Never re-derived server-side. */
  json: unknown;
  /** R-8.12 — opaque bytes. This layer only checks that it is a string (R-8.9). */
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
  | 'publish';

export type AuthorizationVerdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * TASK 9.2 PLUGS IN HERE. Every handler below calls `authorize(op, ctx)` after the
 * availability check and before it touches a store or starts a job, so author-only
 * gating (R-9.9) and the reviewer rejection (R-9.10) land in exactly one place with no
 * route changes. There is no default: `authorize` is required on `CollabDeps`, so a host
 * that forgets to wire `createCollabAuthorizer` fails to compile rather than silently
 * serving every operation to everyone.
 */
export type CollabAuthorizer = (
  op: CollabOperation,
  ctx: { documentId: string | null; login: string; repo: ResolvedCollaborationConfig },
) => AuthorizationVerdict | Promise<AuthorizationVerdict>;

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

export type CollabDeps = {
  /** One registry per server (never module-level). The router never creates it. */
  jobs: JobHubRegistry;
  /** Read per request, so a runtime re-root takes effect on the next call. */
  config: () => ResolvedVisualSpecConfig;
  /** Where collaboration documents are cached locally (task 3.1). */
  documents: () => DocumentStore;
  /**
   * The comment store for one document. Defaults to `githubCommentStore` built from the
   * document's own GitHub binding, so comments are server-side by construction (R-7.7).
   * Returning `null` means "this document has no conversation yet" → 409.
   */
  commentStore?: (ctx: {
    documentId: string;
    document: CollaborationDocument;
    repo: ResolvedCollaborationConfig;
  }) => Promise<CommentDocStore | null> | CommentDocStore | null;
  /** Tasks 8.2 / 8.3. Partial: anything missing uses the failing stub. */
  bodies?: Partial<CollabJobBodies>;
  /** Injectable so tests never exec `gh`. Memoized by the router. */
  preflight?: (repo: ResolvedCollaborationConfig) => Promise<CollaborationPreflight>;
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

/** A `CommentDocStore` that implements the intent methods collaboration requires. */
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

/** The document's GitHub binding, if it carries one an issue-comment store can use. */
function bindingOf(document: CollaborationDocument): GitHubBinding | null {
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
function defaultCommentStore(documentId: string, document: CollaborationDocument): CommentDocStore | null {
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
 * The router
 * ------------------------------------------------------------------ */

export function createCollabRoutes(deps: CollabDeps): CollabRouter {
  const bodies: CollabJobBodies = { ...STUB_BODIES, ...deps.bodies };
  const authorize = deps.authorize;
  const now = deps.now ?? (() => new Date().toISOString());
  const runPreflight = deps.preflight ?? ((repo: ResolvedCollaborationConfig) => preflightCollaboration({ repo }));

  // Memoized per repo identity: the preflight shells out to `gh`, and every mutating
  // route consults it. Keyed by owner/repo/base so a runtime config change re-probes.
  const cache = new Map<string, Promise<CollaborationPreflight>>();

  async function availability(): Promise<CollabAvailability> {
    const repo = deps.config().collaboration;
    if (!repo) return NOT_CONFIGURED;
    const key = `${repo.owner}/${repo.repo}#${repo.baseBranch}`;
    let probe = cache.get(key);
    if (!probe) {
      probe = runPreflight(repo);
      cache.set(key, probe);
    }
    const result = await probe;
    if (result.available) {
      return { available: true, repo: result.repo, login: result.login, scopes: result.scopes };
    }
    return {
      available: false,
      reason: result.reason,
      message: result.message,
      missingScopes: result.missingScopes,
    };
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
  ): Promise<{ ok: true; document: CollaborationDocument } | { ok: false; result: CollabRouteResult }> {
    const document = await deps.documents().read(documentId);
    if (!document) return { ok: false, result: { status: 404, json: { error: `unknown document: ${documentId}` } } };
    return { ok: true, document };
  }

  /** Resolve the comment store for a document, or the response to send instead. */
  async function commentsFor(
    documentId: string,
    document: CollaborationDocument,
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

  async function handle(req: CollabRequest): Promise<CollabRouteResult> {
    const { method, pathname, body } = req;
    try {
      /* GET /__vs/collab — R-7.8, the flag the UI renders (or hides) controls on. */
      if (method === 'GET' && (pathname === '' || pathname === '/')) {
        return { status: 200, json: await availability() };
      }

      /* POST /__vs/collab/start (R-8.5) */
      if (method === 'POST' && pathname === '/start') {
        const documentId = requireString(body, 'documentId');
        if (!DOCUMENT_ID_RE.test(documentId)) return bad(`invalid documentId: ${documentId}`);
        const documentPath = requireString(body, 'documentPath');
        const gated = await gate('create', documentId);
        if (!gated.ok) return gated.result;
        const idempotencyKey = optionalKey(body);
        return deps.jobs.hub(documentId).start({
          kind: 'create',
          idempotencyKey,
          run: bodies.create({
            documentId,
            documentPath,
            repo: gated.repo,
            store: deps.documents(),
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(body.frontmatter ? { frontmatter: body.frontmatter as DocumentFrontmatter } : {}),
            ...(body.doc ? { doc: body.doc as JsonDocument } : {}),
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
        return deps.jobs.hub(documentId).start({
          kind: 'sync',
          idempotencyKey,
          run: bodies.open({
            documentId,
            pullNumber,
            repo: gated.repo,
            store: deps.documents(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        });
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

      /* POST /__vs/collab/:id/publish — R-8.9 payload validation is route-layer. */
      if (method === 'POST' && tail === '/publish') {
        // Validated BEFORE the gate so R-12.7's assertion holds without a credential:
        // an incomplete payload is a malformed request, not an authorization problem.
        if (body.json === undefined || body.json === null) return bad('missing json');
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
            json: body.json,
            markdown: body.markdown,
            repo: gated.repo,
            store: deps.documents(),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        });
      }

      /* POST /__vs/collab/:id/comments — R-7.5, anchored on nodeId. */
      if (method === 'POST' && tail === '/comments') {
        const text = requireString(body, 'comment');
        const nodeId = typeof body.nodeId === 'string' && body.nodeId ? body.nodeId : undefined;
        const gated = await gate('comment', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const store = await commentsFor(documentId, loaded.document, gated.repo);
        if (!store.ok) return store.result;
        const saved = await store.store.addComment(
          commentRecord(loaded.document.documentPath, text, now(), nodeId ? anchorFields(loaded.document, nodeId) : {}),
        );
        return { status: 200, json: { ok: true, id: saved.id, comment: saved } };
      }

      /* POST /__vs/collab/:id/comments/:commentId/reply */
      const reply = /^\/comments\/([^/]+)\/reply$/.exec(tail);
      if (reply && method === 'POST') {
        const commentId = reply[1]!;
        if (!COMMENT_ID_RE.test(commentId)) return bad(`invalid commentId: ${commentId}`);
        const text = requireString(body, 'comment');
        const gated = await gate('reply', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const store = await commentsFor(documentId, loaded.document, gated.repo);
        if (!store.ok) return store.result;
        const parent = (await store.store.read()).comments.find((c) => c.id === commentId);
        if (!parent) return { status: 404, json: { error: `unknown comment: ${commentId}` } };
        // The `replyTo` marker rides on the record's `collab` trailer fields. Persisting
        // it into the GitHub body is the projection layer's job (task 5.2); this layer
        // only states the intent.
        const nodeId = (parent as { collab?: { nodeId?: string } }).collab?.nodeId;
        const saved = await store.store.addComment(
          commentRecord(loaded.document.documentPath, text, now(), { replyTo: commentId, ...(nodeId ? { nodeId } : {}) }),
        );
        return { status: 200, json: { ok: true, id: saved.id, comment: saved } };
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

/**
 * R-6.5 / R-7.5 — the anchor a new collaborative comment is born with.
 *
 * `nodeId` is the primary identity. The other two are captured **here, at creation
 * time, and nowhere else**, because after the fact they are unrecoverable:
 *
 *   `text`        the block's text as it reads now (`captureTargetText`). Once the node
 *                 is deleted the `nodes` projection entry goes with it, and the trailer
 *                 is the only part of the comment that survives a GitHub round-trip —
 *                 so an orphan with no captured text can never say what it was about.
 *   `nodeVersion` the version the comment was authored against. Without it R-6.3 has
 *                 nothing to compare and every comment resolves `exact` forever.
 *
 * Both are omitted rather than faked when the document cannot supply them — a fabricated
 * version would flag comments outdated for edits nobody made.
 */
function anchorFields(document: CollaborationDocument, nodeId: string): Record<string, string> {
  const targetText = captureTargetText(document, nodeId);
  const version = collabNodeVersion(document, nodeId);
  return {
    nodeId,
    ...(targetText ? { [COLLAB_TARGET_TEXT_KEY]: targetText } : {}),
    ...(version !== null ? { nodeVersion: String(version) } : {}),
  };
}

/**
 * One collaborative comment, in the shape every `CommentDocStore` already accepts.
 * `target` still carries the document path so the record stays a valid `CommentRecord`
 * (R-1.7 — `CommentTarget` is unchanged); `collab.nodeId` is the primary identity
 * (R-7.5) and is what `githubCommentStore` writes into the trailer.
 *
 * The generated `id` is a placeholder: a GitHub-backed store replaces it with
 * `recordIdFor(issueCommentId)` in the record it returns.
 */
function commentRecord(
  documentPath: string,
  text: string,
  ts: string,
  collab: Record<string, string>,
): CommentRecord {
  return {
    id: `c-${randomHex8()}`,
    workflow: DEFAULT_WORKFLOW,
    target: { path: documentPath, kind: 'file' },
    comment: text,
    status: 'open',
    ts,
    ...(Object.keys(collab).length > 0 ? { collab } : {}),
  } as CommentRecord;
}
