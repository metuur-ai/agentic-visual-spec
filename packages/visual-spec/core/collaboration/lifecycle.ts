/**
 * lifecycle.ts — document creation and sync (R-8.5 … R-8.8, R-11.1).
 *
 * This module supplies **job bodies** to the 8.1 hub; it owns no event log, no
 * subscriber set and no lifecycle state of its own. The bodies are exported on their
 * own as `createLifecycleBodies` — in the factory shape 7.2's `CollabJobBodies`
 * declares — so the `/__vs/collab` routes and the interval poller run the *same* code
 * rather than two implementations that drift. `createLifecycle` is a thin wrapper over
 * them that binds one repo + store and owns the poller. A body is
 * `(ctx: JobContext) => Promise<void>`: resolve means success, reject means the hub
 * emits `job-error` and records `failed`. Every GitHub call goes through the 4.1
 * adapter, every comment read goes through the 5.1 projection — there is no second
 * client and no second projection here.
 *
 * ---------------------------------------------------------------------------
 * HOW `pullNumber` + `headSha` REACH THE CALLER (R-8.5)
 * ---------------------------------------------------------------------------
 * A `JobBody` returns `void`, and the hub snapshot carries only `state` / `job` /
 * `events` — deliberately, since it is a generic runner. So the create job persists
 * the `GitHubBinding` (`owner`, `repo`, `branch`, `pullNumber`, `headSha`) onto the
 * stored document through the 3.1 `DocumentStore`, and `readGitHubBinding()` reads it
 * back. The store is the right channel because it is the only **durable** one: a
 * client that was not subscribed when the PR opened — or that reconnects after a
 * server restart — still finds the binding, which an in-memory job result could never
 * offer. The SSE stream carries the same facts as a human-readable log line plus the
 * `state: 'pr-open'` transition, so a live subscriber does not have to poll for them.
 *
 * ---------------------------------------------------------------------------
 * PARTIAL CREATE FAILURE (R-8.18 — task 8.4 cleans up, this leaves it tractable)
 * ---------------------------------------------------------------------------
 * The binding is written **twice**: once right after the branch exists, carrying
 * `branch` with **no `pullNumber`**, and once after the PR opens, carrying both. So if
 * commit or PR creation fails, the document is left with a binding that names a real
 * branch and has no `pullNumber` — the durable, on-disk signal of "a branch was
 * created for this document and nothing was opened against it". Task 8.4 detects the
 * orphan with `readGitHubBinding()` (`branch && pullNumber === undefined`), deletes
 * `refs/heads/<branch>`, and clears the binding. The branch name is also deterministic
 * (`branchNameFor`), so cleanup does not depend on the write having landed.
 *
 * ---------------------------------------------------------------------------
 * WHAT SYNC WRITES (R-8.6 / R-8.7)
 * ---------------------------------------------------------------------------
 * Sync writes **nothing** to the collaboration document. It reads PR issue comments
 * through the 5.1 projection and hands them to the `onSync` observer. It never touches
 * `doc`, `nodes`, `frontmatter`, `title` or the `GitHubBinding` — all of which are
 * owned by create (this module) and publish (8.3), and none of which sync fetched. A
 * poll that raced an in-flight edit therefore cannot clobber it.
 *
 * The interval poller is owned by this module and driven by an **injected** scheduler,
 * so no real timer exists in the tests. The host (7.2) calls `startPolling(documentId)`
 * once the document is PR-open and `stopPolling` / `stopAllPolling` when it is closed
 * or the server shuts down. Overlap is handled by the hub, not by a lock here: a tick
 * that fires while the previous sync is still running is refused with 409 and dropped,
 * so polls can never queue up behind a slow GitHub response.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import type { ResolvedCollaborationConfig } from '../config';
import { type ProjectedCommentRecord, formatTrailer, githubCommentStore } from './comment-projection';
import type { CollaborationDocument, GitHubBinding } from './document-protocol';
import { resolveDocumentTitle, serializeCollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import type { GitHubAdapter, RepoRef } from './github-adapter';
import type { JobBody, JobContext, JobHubRegistry, JobRouteResult } from './job-hub';

/** A stored document that has been through `start` at least once. */
export type BoundCollaborationDocument = CollaborationDocument & { github?: GitHubBinding };

/**
 * R-8.7 — who asked for a sync. The three triggers run **identical** code; this is
 * reporting only, so a log line can say where a sync came from. `webhook` exists today
 * so a future receiver is a caller of `Lifecycle.sync`, not a change to it (R-8.8: the
 * shipped product has no receiver — the interval poller runs in-process).
 */
export type SyncTrigger = 'user' | 'poll' | 'webhook';

/** What one sync observed. Handed to `onSync`; nothing here is persisted by sync. */
export type SyncResult = {
  documentId: string;
  pullNumber: number;
  trigger: SyncTrigger;
  comments: ProjectedCommentRecord[];
  at: number;
};

/**
 * Injected interval timer — `setInterval` is never called directly, so tests drive the
 * poller by hand and no real timer exists in the suite. Returns its own canceller, so
 * the handle type never leaks (node's `Timeout` vs the DOM's `number`).
 */
export type IntervalScheduler = (tick: () => void, ms: number) => () => void;

/**
 * 30s. Long enough that a session of several open documents stays well inside GitHub's
 * rate limit, short enough that a reviewer's comment shows up while they are still
 * looking at the page. Overridable per server.
 */
export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

/** Default scheduler: a real interval, `unref`'d so polling never holds the CLI open. */
const defaultScheduler: IntervalScheduler = (tick, ms) => {
  const handle = setInterval(tick, ms);
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
};

export type LifecycleOptions = {
  adapter: GitHubAdapter;
  /** R-9.4 — owner / repo / base branch. */
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
  hubs: JobHubRegistry;
  /** Called with every sync result, whatever the trigger. 5.3 plugs the cache in here. */
  onSync?: (result: SyncResult) => void | Promise<void>;
  syncIntervalMs?: number;
  scheduler?: IntervalScheduler;
};

export type StartDocumentInput = {
  documentId: string;
  /** Defaults to `branchNameFor(documentId)`. */
  branch?: string;
  /** Defaults to the document's resolved title. */
  title?: string;
  /** R-8.23 — carried to the hub. De-duplication itself is task 8.4. */
  idempotencyKey?: string;
};

export interface Lifecycle {
  /** R-8.5 — start a `create` job: branch, commit canonical JSON, open the PR. */
  start(input: StartDocumentInput): JobRouteResult;
  /**
   * R-8.6 / R-8.7 — **the single sync entrypoint**. The interval poller calls it, the
   * user-initiated action calls it, and a future webhook receiver calls it unchanged.
   * There is no other way to sync in this package.
   */
  sync(documentId: string, trigger: SyncTrigger): JobRouteResult;
  /** Begin interval polling for a document. Idempotent. */
  startPolling(documentId: string): void;
  /** Stop polling one document. */
  stopPolling(documentId: string): void;
  /** Stop every poller. Call on server shutdown. */
  stopAllPolling(): void;
  /** Documents currently being polled, sorted. */
  pollingDocumentIds(): string[];
}

/** Deterministic branch name, so 8.4 can find an orphaned branch without stored state. */
export function branchNameFor(documentId: string): string {
  return `visual-spec/${documentId}`;
}

/** The `GitHubBinding` persisted by `start`, or `null` when there is none yet. */
export async function readGitHubBinding(store: DocumentStore, documentId: string): Promise<GitHubBinding | null> {
  const doc = (await store.read(documentId)) as BoundCollaborationDocument | null;
  return doc?.github ?? null;
}

/**
 * The command a reviewer runs to open the document in their own visual-spec instance
 * (R-11.1). Exported so task 11.x renders the same string it parses.
 */
export function openCommandFor(repo: RepoRef, branch: string, documentId: string): string {
  return `npx @metuur/visual-spec collab open --repo ${repo.owner}/${repo.repo} --branch ${branch} --document ${documentId}`;
}

export type PullRequestBodyInput = {
  repo: RepoRef;
  branch: string;
  documentId: string;
  documentPath: string;
  title: string;
};

/**
 * R-11.1 — the PR body. Human-readable on github.com (a table and a copyable command),
 * machine-readable through the 5.1 trailer on the final line, so task 11.1 reads it
 * back with `parseCommentBody` — the same parser the comment path already uses, not a
 * second format.
 */
export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const { repo, branch, documentId, documentPath, title } = input;
  const command = openCommandFor(repo, branch, documentId);
  const text = [
    `**${title}** is a visual-spec collaboration document. Review it as a rendered document, not as a JSON diff.`,
    '',
    '| | |',
    '| --- | --- |',
    `| Repository | \`${repo.owner}/${repo.repo}\` |`,
    `| Branch | \`${branch}\` |`,
    `| Document | \`${documentPath}\` (id \`${documentId}\`) |`,
    '',
    'Open it in your own visual-spec instance:',
    '',
    '```sh',
    command,
    '```',
    '',
    'Comments left there are posted here as PR comments, and comments posted here appear there.',
  ].join('\n');
  const trailer = formatTrailer({ owner: repo.owner, repo: repo.repo, branch, documentId, documentPath });
  // No trailing newline: `parseCommentBody` only recognizes a trailer that *is* the
  // final line, so the body must end on it.
  return `${text}\n\n${trailer}`;
}

/** Abort between steps rather than after another network round-trip. */
function throwIfAborted(ctx: JobContext): void {
  if (ctx.signal.aborted) throw new Error(`${ctx.kind} cancelled for ${ctx.documentId}`);
}

/* ------------------------------------------------------------------ *
 * The job bodies, standalone — the 7.2 seam
 * ------------------------------------------------------------------ */

/**
 * What the `create` body needs. Deliberately a **subset** of 7.2's `CreateJobInput`
 * (`core/vite/routes/collab.ts`), so `createLifecycleBodies` is assignable straight into
 * `CollabDeps.bodies` and the route hands its own input through untouched.
 */
export type CreateBodyInput = {
  documentId: string;
  /** R-9.4 — owner / repo / base branch, supplied per call rather than per instance. */
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
  /** Defaults to `branchNameFor(documentId)`. */
  branch?: string;
  /** Defaults to the document's resolved title. */
  title?: string;
};

/** What the `sync` body needs. Also a subset of 7.2's `SyncJobInput`. */
export type SyncBodyInput = {
  documentId: string;
  repo: ResolvedCollaborationConfig;
  store: DocumentStore;
  /** R-8.7 — reporting only. Defaults to `user`, which is what the HTTP route is. */
  trigger?: SyncTrigger;
};

/**
 * The bodies this module owns, in the factory shape 7.2's `CollabJobBodies` declares.
 * `open` (R-11.2) and `publish` (R-8.9 …) are not here — see the module header of
 * `core/vite/routes/collab-wiring.ts` for what each still needs.
 */
export type LifecycleJobBodies = {
  create(input: CreateBodyInput): JobBody;
  sync(input: SyncBodyInput): JobBody;
};

export type LifecycleBodyOptions = {
  adapter: GitHubAdapter;
  /** Called with every sync result, whatever the trigger. 5.3 plugs the cache in here. */
  onSync?: (result: SyncResult) => void | Promise<void>;
};

/**
 * The real GitHub work, as bare `JobBody` factories. Nothing here touches a hub, a
 * poller or a route — `createLifecycle` below and the 7.2 routes are both just callers,
 * so the two reach identical code (that is the whole point of the split).
 */
export function createLifecycleBodies(options: LifecycleBodyOptions): LifecycleJobBodies {
  const { adapter, onSync } = options;

  return {
    /** R-8.5 — the `create` body. Every failure rejects; the hub records `failed`. */
    create: (input) => async (ctx) => {
      const { documentId, repo, store } = input;
      const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };
      const doc = (await store.read(documentId)) as BoundCollaborationDocument | null;
      if (!doc) throw new Error(`no collaboration document: ${documentId}`);

      const branch = input.branch ?? branchNameFor(documentId);
      const title = input.title || resolveDocumentTitle(doc) || documentId;

      ctx.log(`resolving ${repo.baseBranch}`, 'progress');
      const base = await adapter.getBranch(repoRef, repo.baseBranch);
      throwIfAborted(ctx);

      ctx.log(`creating branch ${branch} at ${base.sha}`, 'progress');
      await adapter.createBranch(repoRef, branch, base.sha);
      // Durable orphan marker: branch known, no PR yet. See the header (R-8.18 / 8.4).
      await store.write({ ...doc, github: { owner: repo.owner, repo: repo.repo, branch, resolved: false } });
      throwIfAborted(ctx);

      // Contents API only — a `git add` would normalize line endings and break the
      // publish byte-verification permanently (LLD §7).
      ctx.log(`committing ${doc.documentPath}`, 'progress');
      await adapter.commitFile(repoRef, {
        path: doc.documentPath,
        content: serializeCollaborationDocument(doc),
        message: `visual-spec: create ${documentId}`,
        branch,
      });
      throwIfAborted(ctx);

      ctx.log(`opening pull request against ${repo.baseBranch}`, 'progress');
      const pr = await adapter.createPullRequest(repoRef, {
        title,
        head: branch,
        base: repo.baseBranch,
        body: buildPullRequestBody({ repo: repoRef, branch, documentId, documentPath: doc.documentPath, title }),
      });

      const github: GitHubBinding = {
        owner: repo.owner,
        repo: repo.repo,
        branch,
        pullNumber: pr.number,
        headSha: pr.headSha,
        resolved: false,
      };
      await store.write({ ...doc, github });

      ctx.log(`pull request #${pr.number} open at ${pr.headSha} — ${pr.htmlUrl}`);
      ctx.setState('pr-open');
    },

    /** The `sync` body. One implementation, shared by the poller and the HTTP route. */
    sync: (input) => async (ctx) => {
      const { documentId, repo, store } = input;
      const trigger: SyncTrigger = input.trigger ?? 'user';
      const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };
      const doc = (await store.read(documentId)) as BoundCollaborationDocument | null;
      if (!doc) throw new Error(`no collaboration document: ${documentId}`);
      const pullNumber = doc.github?.pullNumber;
      if (typeof pullNumber !== 'number') throw new Error(`no open pull request for ${documentId}`);

      ctx.log(`sync (${trigger}) — reading comments on #${pullNumber}`, 'progress');
      // R-5.1 — the one projection. Sync does not read GitHub comments any other way.
      const comments = (await githubCommentStore({
        adapter,
        repo: repoRef,
        pullNumber,
        documentId,
        documentPath: doc.documentPath,
      }).read()).comments as ProjectedCommentRecord[];
      throwIfAborted(ctx);

      ctx.log(`sync (${trigger}) — ${comments.length} comment(s) on #${pullNumber}`);
      // Sync persists nothing about the document itself — see the header.
      await onSync?.({ documentId, pullNumber, trigger, comments, at: ctx.now() });
    },
  };
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const { adapter, repo, store, hubs, onSync } = options;
  const intervalMs = Math.max(1, options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
  const schedule = options.scheduler ?? defaultScheduler;
  const pollers = new Map<string, () => void>();
  // The same bodies the 7.2 routes run. `start` / `sync` below are thin wrappers that
  // bind this instance's repo + store and hand the body to the hub.
  const bodies = createLifecycleBodies({ adapter, ...(onSync ? { onSync } : {}) });

  const lifecycle: Lifecycle = {
    start(input) {
      return hubs.hub(input.documentId).start({
        kind: 'create',
        run: bodies.create({
          documentId: input.documentId,
          repo,
          store,
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.title ? { title: input.title } : {}),
        }),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
    },

    sync(documentId, trigger) {
      // The hub is also the overlap guard: it rejects a second job for a document with
      // 409, so a poll that fires while the previous one is still running is dropped
      // rather than queued. Polls cannot pile up behind a slow GitHub response.
      return hubs.hub(documentId).start({ kind: 'sync', run: bodies.sync({ documentId, repo, store, trigger }) });
    },

    startPolling(documentId) {
      if (pollers.has(documentId)) return;
      // Dereferenced through `lifecycle` at tick time, on purpose: the poller can never
      // drift onto a private copy of the sync path, and a test spying on the public
      // `sync` method observes the polled call as well as the user-initiated one (R-8.7).
      pollers.set(
        documentId,
        schedule(() => {
          lifecycle.sync(documentId, 'poll');
        }, intervalMs),
      );
    },

    stopPolling(documentId) {
      pollers.get(documentId)?.();
      pollers.delete(documentId);
    },

    stopAllPolling() {
      for (const cancel of pollers.values()) cancel();
      pollers.clear();
    },

    pollingDocumentIds() {
      return [...pollers.keys()].sort();
    },
  };

  return lifecycle;
}
