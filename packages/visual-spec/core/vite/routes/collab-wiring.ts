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
 * `open` (task 11.1, R-11.2) is wired below from `core/collaboration/open.ts`, in the
 * same shape as `create`: it fetches the canonical JSON off the PR branch into the local
 * store, then starts the poller, because a reviewer's document is PR-open from the moment
 * it is opened and their comments arrive over the same sync path an author's do.
 *
 * NOTHING IS STUBBED HERE ANY MORE — every member of `CollabJobBodies` is supplied.
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
import { createRecoveryBodies, withOrphanCleanup, withPublishFailureStates } from '../../collaboration/failure-states';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import { type GhExecutor, defaultExecGh } from '../../collaboration/github-executor';
import type { JobHubRegistry } from '../../collaboration/job-hub';
import {
  type IntervalScheduler,
  type SyncResult,
  createLifecycle,
  createLifecycleBodies,
} from '../../collaboration/lifecycle';
import { createOpenBody } from '../../collaboration/open';
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
  const openBody = createOpenBody({ adapter });
  const publish = createPublishBody({ adapter });
  // 8.4's recovery bodies. Built here for the same reason the rest are: the module was
  // fully written and tested but had no caller, so `reconcile` and `markReady` answered
  // from the failing stub over HTTP.
  const recovery = createRecoveryBodies({ adapter });

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

  // R-8.6 — POLLING FOLLOWS WATCHERS, and that is the whole rule.
  //
  // The poller exists for one purpose: to feed `sync` frames to attached SSE
  // subscribers. So it runs exactly while a document has at least one, keyed on the same
  // `documentId` the hubs and the lifecycle already key on. The first subscriber to
  // attach starts it; the last to detach stops it; a reattach starts it again, because
  // this listener sees every change and not just the first. `dispose()` ends every
  // subscriber and announces the drop to zero, so a disposed document stops too, and
  // `stopAllPolling` on shutdown remains the backstop for anything still attached.
  //
  // This replaces the unconditional `startPolling` that `create` and `open` used to do.
  // That start ran *before* any subscriber existed, so a document created by the CLI
  // that nobody ever opened in a browser polled GitHub on the interval forever — which
  // is precisely the rate-limit burn this rule removes. An unwatched document therefore
  // does not poll at all now, freshly created or not: the browser that ran create or
  // open attaches to `GET /:id/events` immediately afterwards, and *that* is what starts
  // it. This is a deliberate narrowing, not a lost start.
  options.jobs.onWatchersChanged((documentId, count) => {
    if (count > 0) lifecycle.startPolling(documentId);
    else lifecycle.stopPolling(documentId);
  });

  return {
    bodies: {
      // R-8.18 (task 8.4) — `withOrphanCleanup` deletes the branch a partial create left
      // behind, on the way out of the failure. It adds no GitHub call to the success
      // path, so create's shipped call sequence is unchanged.
      create: (input) =>
        withOrphanCleanup(bodies.create(input), {
          adapter,
          repo: input.repo,
          store: input.store,
          documentId: input.documentId,
        }),
      // R-11.2 — the reviewer's entry point. The document reaches the local store here,
      // which is what `GET /__vs/collab/:id` then serves.
      open: (input) => openBody(input),
      sync: (input) => bodies.sync(input),
      // R-8.9 … R-8.14. Publish neither starts nor stops the poller — the document stays
      // PR-open on the branch until it is merged on github.com. R-8.21 / R-8.22 (task
      // 8.4) — `withPublishFailureStates` turns publish's typed errors into the distinct
      // recorded states `verification-failed` / `base-diverged`. It performs no GitHub
      // call of its own here: the pre-commit base-divergence read is opt-in and off.
      publish: (input) =>
        withPublishFailureStates(publish(input), {
          adapter,
          repo: input.repo,
          store: input.store,
          documentId: input.documentId,
        }),
      // R-8.18 / R-8.15 (task 8.4). Both re-read GitHub inside the body and record the
      // state they derive; nothing here pre-computes or caches either answer.
      reconcile: (input) => recovery.reconcile(input),
      markReady: (input) => recovery.markReady(input),
      // `merge` stays unwired on purpose: SC-1 ends the flow at "published to the
      // branch" and the HLD is explicit that merging happens on github.com.
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
