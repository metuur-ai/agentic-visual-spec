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
import { type CollaborationPreflight, credentialFingerprint, preflightCollaboration } from '../../collaboration/credentials';
import { githubCommentStore } from '../../collaboration/comment-projection';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import type { GitHubBinding } from '../../collaboration/document-protocol';
import type { CollaborationDocument, DocumentFrontmatter, JsonDocument } from '../../collaboration/document-protocol';
import { newCollaborationDocument } from '../../collaboration/document-protocol';
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
export type OpenJobInput = JobInputBase & { pullNumber: number; discardLocal?: boolean };

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
  /** R-8.18 — re-derive state from GitHub; cleans up a partial create's orphan branch. */
  reconcile(input: RecoveryJobInput): JobBody;
  /** R-8.15 — re-derive readiness from GitHub and record it. Never trusts held state. */
  markReady(input: RecoveryJobInput): JobBody;
};

/** What both recovery bodies need. Mirrors 8.4's `RecoveryBodyInput`. */
export type RecoveryJobInput = {
  documentId: string;
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
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
 * `setResolved` is the GitHub-backed store's own (R-5.12): resolution is a reply comment
 * carrying a marker, not a field, because issue comments are flat and have no resolved
 * bit to set. It is optional here so a snapshot-only store still satisfies the type; the
 * PATCH route refuses a resolution rather than silently dropping it when it is absent.
 */
type CollabCommentStore = CommentDocStore &
  Required<Pick<CommentDocStore, 'addComment' | 'updateComment'>> & {
    setResolved?: (id: string, resolved: boolean) => Promise<CommentRecord | null>;
  };

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

const DEFAULT_PREFLIGHT_TTL_MS = 60_000;

export function createCollabRoutes(deps: CollabDeps): CollabRouter {
  const bodies: CollabJobBodies = { ...STUB_BODIES, ...deps.bodies };
  const authorize = deps.authorize;
  const now = deps.now ?? (() => new Date().toISOString());
  const runPreflight = deps.preflight ?? ((repo: ResolvedCollaborationConfig) => preflightCollaboration({ repo }));
  const preflightTtl = deps.preflightTtlMs ?? DEFAULT_PREFLIGHT_TTL_MS;
  const clock = deps.clock ?? (() => Date.now());

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

      /* POST /__vs/collab/start (R-8.5) */
      if (method === 'POST' && pathname === '/start') {
        const documentId = requireString(body, 'documentId');
        if (!DOCUMENT_ID_RE.test(documentId)) return bad(`invalid documentId: ${documentId}`);
        const documentPath = requireString(body, 'documentPath');
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
            newCollaborationDocument({
              documentId,
              documentPath,
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(body.frontmatter ? { frontmatter: body.frontmatter as DocumentFrontmatter } : {}),
              ...(body.doc ? { doc: body.doc as JsonDocument } : {}),
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
       * GET /__vs/collab/:id/document — R-7.3 / R-7.4. The canonical JSON the document
       * view stamps `data-vs-node-id` / `data-vs-node-version` from, and the anchor
       * resolver (R-6.1) looks `nodeId` up in. Deliberately NOT folded into `GET /:id`:
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
        const store = await commentsFor(documentId, loaded.document, gated.repo);
        if (!store.ok) return store.result;
        return { status: 200, json: (await store.store.read()).comments };
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
        /*
         * The routing tag the panel's "Apply via" control sets: which skill handles this
         * comment. It says nothing about whether the comment is worth acting on — both of
         * its values mean "actionable", they differ on by whom. It reached the browser's
         * request body and went no further, so every collaborative comment was born with
         * the default and the control was decorative.
         */
        const workflow = typeof body.workflow === 'string' && body.workflow.trim() ? body.workflow.trim() : undefined;
        const gated = await gate('comment', documentId);
        if (!gated.ok) return gated.result;
        const loaded = await load(documentId);
        if (!loaded.ok) return loaded.result;
        const store = await commentsFor(documentId, loaded.document, gated.repo);
        if (!store.ok) return store.result;
        const saved = await store.store.addComment(
          commentRecord(loaded.document.documentPath, text, now(), {
            ...(nodeId ? anchorFields(loaded.document, nodeId) : {}),
            ...(workflow ? { workflow } : {}),
          }),
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
        /*
         * The `replyTo` marker rides on the record's `collab` trailer fields. Persisting
         * it into the GitHub body is the projection layer's job (task 5.2); this layer
         * only states the intent.
         *
         * It states it as the parent's GITHUB issue-comment id, not our local `c-…` id.
         * That is what the trailer's `replyTo` means everywhere else — the resolution
         * replies write it that way and `markerOf` parses it as a number — and it is the
         * only id that survives a reader who has never seen this machine's store. Passing
         * the local id produced a trailer nothing could resolve, so the parent link was
         * lost the moment it reached GitHub and no reply could ever be threaded again.
         */
        const parentTrailer = (parent as { collab?: { nodeId?: string }; github?: { issueCommentId?: number } }).collab;
        const parentIssueCommentId = (parent as { github?: { issueCommentId?: number } }).github?.issueCommentId;
        const nodeId = parentTrailer?.nodeId;
        const saved = await store.store.addComment(
          commentRecord(loaded.document.documentPath, text, now(), {
            replyTo: String(parentIssueCommentId ?? commentId),
            ...(nodeId ? { nodeId } : {}),
          }),
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

        /*
         * A status change is a RESOLUTION, and resolution does not live in the same place
         * as the text. `updateComment` edits the issue comment's body and says so itself
         * ("Status/result have no GitHub representation") — so routing a resolve through
         * it answered 200 with the comment unchanged, and the panel's Resolve button did
         * nothing at all. Worse than nothing: unresolved comments gate publishing (R-8.15),
         * so a single comment locked the author out of publishing permanently.
         * `setResolved` posts the marker reply that R-5.12 specifies; it existed, tested,
         * with no caller. This is that caller.
         */
        if (patch.status !== undefined) {
          if (!store.store.setResolved) {
            return { status: 501, json: { error: 'comment store cannot record resolution' } };
          }
          const marker = await store.store.setResolved(commentId, patch.status === 'applied');
          if (!marker) return { status: 404, json: { error: `unknown comment: ${commentId}` } };
        }

        // Nothing left to edit — a resolve carries no text — so answer with the parent as
        // it now reads. Resolution is DERIVED from the comment list on read (R-5.14), so
        // returning the marker reply here would hand the client the wrong record entirely.
        if (patch.comment === undefined) {
          const refreshed = (await store.store.read()).comments.find((c) => c.id === commentId);
          if (!refreshed) return { status: 404, json: { error: `unknown comment: ${commentId}` } };
          return { status: 200, json: { ok: true, comment: refreshed } };
        }

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
