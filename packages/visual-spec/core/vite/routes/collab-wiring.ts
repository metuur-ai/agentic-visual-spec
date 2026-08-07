/**
 * collab-wiring.ts — the one piece of collaboration wiring both hosts share (R-7.6).
 *
 * WHY THIS FILE EXISTS. 7.2's `createCollabRoutes` injects its job bodies; 8.2's
 * `createLifecycle` owned them privately and called `hub.start()` itself. Neither could
 * reach the other, so the shipped routes ran 7.2's failing stubs and 8.2's real GitHub
 * work was unreachable over HTTP. 8.2 now exports `createLifecycleBodies` in the shape
 * 7.2 declares; this module is the single place that builds them and the poller, so
 * `src/server.ts` and `core/vite/md-plugin.ts` stay byte-identical on the collaboration
 * path and neither host owns any logic of its own (R-7.6).
 *
 * R-9.19 — LOCAL MODE IS ENTIRELY UNAFFECTED. With no `collaboration` block resolved,
 * this returns before `createGitHubAdapter` is ever called: no adapter, no lifecycle, no
 * poller, no bodies. The router still answers `GET /__vs/collab` with `not-configured`
 * because that path never needed any of them.
 *
 * WHAT IS STILL STUBBED. `bodies.open` is deliberately absent, so 7.2's honest
 * `notImplemented` stub keeps serving it:
 *   - `open` — task 11.x (R-11.2). It must export a factory
 *     `(input: OpenJobInput) => JobBody` and be added to the spread below, plus a
 *     `startPolling(input.documentId)` call once it has attached a PR, exactly as
 *     `create` does below.
 *
 * `publish` (task 8.3) is wired below from `core/collaboration/publish.ts`. It takes no
 * poller and no lifecycle — it commits the client payload to the PR branch, verifies the
 * committed blobs, and stops. It deliberately never merges (LLD §7).
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import { createCollabAuthorizer } from '../../collaboration/authorization';
import type { DocumentStore } from '../../collaboration/document-store';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import { type GhExecutor, defaultExecGh } from '../../collaboration/github-executor';
import type { JobHubRegistry } from '../../collaboration/job-hub';
import {
  type IntervalScheduler,
  type SyncResult,
  createLifecycle,
  createLifecycleBodies,
} from '../../collaboration/lifecycle';
import { createPublishBody } from '../../collaboration/publish';
import type { ResolvedVisualSpecConfig } from '../../config';
import type { CollabAuthorizer, CollabJobBodies } from './collab';

export type CollabWiringOptions = {
  /** Read once, at construction: the adapter is per-repo, not per-request. */
  config: () => ResolvedVisualSpecConfig;
  /** The host's own document-store thunk, so a runtime re-root is honoured. */
  documents: () => DocumentStore;
  /** The host's registry. The poller starts jobs on the same hubs the routes do. */
  jobs: JobHubRegistry;
  /** Task 5.3 plugs the comment cache in here — one line, in both hosts. */
  onSync?: (result: SyncResult) => void | Promise<void>;
  /** Injectable so tests never exec `gh`. Defaults to the real CLI. */
  exec?: GhExecutor;
  /** Injectable so tests never create a real timer. */
  scheduler?: IntervalScheduler;
};

export type CollabWiring = {
  /** Hand straight to `createCollabRoutes({ bodies })`. `{}` when collaboration is off. */
  bodies: Partial<CollabJobBodies>;
  /**
   * Task 9.2 — hand straight to `createCollabRoutes({ authorize })`. Author-only
   * enforcement (R-9.9 / R-9.10) for both hosts, built here so neither owns any of it.
   */
  authorize: CollabAuthorizer;
  /** Call on server shutdown, alongside `collab.dispose()`. */
  stopAllPolling(): void;
  /** Documents currently being polled, sorted. Empty when collaboration is off. */
  pollingDocumentIds(): string[];
};

const NOT_CONFIGURED: CollabWiring = {
  bodies: {},
  // Unreachable in practice — with no configuration every GitHub-touching route answers
  // 503 from the availability gate, which runs ahead of the authorizer. Denying anyway
  // so the "collaboration off" wiring is fail-closed by construction rather than by
  // depending on the order of two checks in another module.
  authorize: (op) => ({ ok: false, status: 403, error: `${op} is unavailable: collaboration is not configured.` }),
  stopAllPolling() {},
  pollingDocumentIds: () => [],
};

export function createCollabWiring(options: CollabWiringOptions): CollabWiring {
  const repo = options.config().collaboration;
  // R-9.19 — no configuration ⇒ nothing GitHub-touching is constructed at all.
  if (!repo) return NOT_CONFIGURED;

  const adapter = createGitHubAdapter(options.exec ?? defaultExecGh);
  const onSync = options.onSync;
  const bodies = createLifecycleBodies({ adapter, ...(onSync ? { onSync } : {}) });

  // The poller re-reads `documents()` per call rather than closing over one store, so a
  // runtime "change directory" re-roots the next tick too — the same discipline the
  // hosts already use for the route-facing store.
  const store: DocumentStore = {
    read: (id) => options.documents().read(id),
    write: (doc) => options.documents().write(doc),
    list: () => options.documents().list(),
    resolveNode: (id, nodeId) => options.documents().resolveNode(id, nodeId),
  };
  const lifecycle = createLifecycle({
    adapter,
    repo,
    store,
    hubs: options.jobs,
    ...(onSync ? { onSync } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });

  return {
    bodies: {
      // Polling begins the moment a document is PR-open, which is the only moment this
      // package can currently observe one reaching that state (R-8.6). It stops on
      // shutdown via `stopAllPolling`; per-document stops arrive with 11.x's close path.
      create: (input) => async (ctx) => {
        await bodies.create(input)(ctx);
        lifecycle.startPolling(input.documentId);
      },
      sync: (input) => bodies.sync(input),
      // R-8.9 … R-8.14. No wrapper: publish neither starts nor stops the poller — the
      // document stays PR-open on the branch until it is merged on github.com.
      publish: createPublishBody({ adapter }),
    },
    // R-9.7 … R-9.11. Same `documents()` thunk the poller uses, so a runtime re-root is
    // honoured on the next request too. It shares no cache with the routes: role state
    // is its own, with its own invalidation (see `authorization.ts`).
    authorize: createCollabAuthorizer({
      documents: () => store,
      ...(options.exec ? { exec: options.exec } : {}),
    }),
    stopAllPolling: () => lifecycle.stopAllPolling(),
    pollingDocumentIds: () => lifecycle.pollingDocumentIds(),
  };
}
