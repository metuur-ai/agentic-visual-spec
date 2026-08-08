/**
 * failure-states.ts — the gates, the failure states and the reconciler (R-8.15 … R-8.24).
 *
 * A sibling of `lifecycle.ts` and `publish.ts`, in the same shape: bare `JobBody`
 * factories plus pure derivations. It owns no hub, no state and no poller, and every
 * GitHub call goes through the 4.1 adapter. `lifecycle.ts` and `publish.ts` are not
 * modified by this task — the two behaviours that had to reach *inside* them
 * (orphan cleanup on a partial create, failure-state recording on a failed publish)
 * are applied here as **wrappers** around their bodies, so both modules and both of
 * their suites are untouched.
 *
 * ---------------------------------------------------------------------------
 * READY IS DERIVED, NOT STORED (LLD §7, R-8.15 / R-8.16 / R-8.17)
 * ---------------------------------------------------------------------------
 * There is no `ready` field anywhere — not on `CollaborationDocument`, not on
 * `GitHubBinding`, not in the hub. `deriveReadiness()` is a pure function of the
 * comment list, and `deriveLifecycleState()` a pure function of that plus the Pull
 * Request's own state. Every caller that needs readiness recomputes it from a list it
 * just fetched from GitHub.
 *
 * That is what makes R-8.16 fall out for free rather than needing a rule: a document
 * whose comments were all resolved derives `ready`; the moment an unresolved comment
 * exists the same function derives `pr-open`. Nothing has to *notice* the new comment
 * and demote anything, because nothing was ever promoted.
 *
 * And it is what closes R-8.17's TOCTOU window. `merge` does not consult the state the
 * hub last recorded, nor the result of the last poll: it re-reads the review threads and
 * their resolution from GitHub itself, immediately before the merge, and refuses on what
 * *that* returns. A comment that arrives after the poll said "ready" and before the merge
 * request is therefore seen. The window that remains is the one round trip between that
 * read and GitHub's merge — irreducible without a lock GitHub does not offer, and orders
 * of magnitude narrower than a 30s poll interval.
 *
 * Resolution itself is GitHub's, read and never written (R-5.12 / R-5.13). A thread whose
 * resolution could not be read counts as unknown, and unknown is not Ready (R-8.25).
 *
 * ---------------------------------------------------------------------------
 * WHY THE FAILURES ARE FOUR STATES AND NOT ONE (R-8.20 … R-8.22)
 * ---------------------------------------------------------------------------
 * `LifecycleState` gained `conflicted`, `verification-failed` and `base-diverged`
 * beside the existing `failed`. They are separate strings, declared through
 * `ctx.setState()`, so they arrive on the SSE stream as ordinary
 * `{ type: 'state', state: … }` frames and a client discriminates on a field rather
 * than by pattern-matching an error message. `base-diverged` in particular must not
 * read as `verification-failed`: base legitimately moving is a correct outcome that
 * needs a rebase, while a blob mismatch means someone pushed to the branch or the bytes
 * were mangled — an integrity alarm. Reporting the first as the second would cry wolf.
 *
 * A refusal is not a failure either. `markReady` and `merge` decline by declaring the
 * state the document is *actually* in (`pr-open`, `conflicted`, `closed`) and then
 * rejecting, so the caller gets an error and the document keeps an honest state. The
 * hub honours that instead of overwriting it with `failed`, because every error thrown
 * from here says so — see `markStateDecided` in `job-hub.ts`. The distinction therefore
 * survives into the `job-done` frame and the R-8.4 recovery snapshot as well.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE IS RECONCILABLE (R-8.24)
 * ---------------------------------------------------------------------------
 * `reconcile` is the single answer to "what state is this document actually in?". It
 * reads the durable signals — the stored binding, the Pull Request, the comments — and
 * declares the derived state. It is therefore the recovery path from *any* of the
 * failures below, including the one that left nothing but an orphaned branch, and it is
 * safe to run repeatedly. Nothing in this module needs a durable failure record,
 * because nothing here derives state from one.
 *
 * Node-reachable from the CLI: node builtins and sibling core modules only — no
 * `@lyfie/luthor`, no react (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import type { ResolvedCollaborationConfig } from '../config';
import { mergeAndDropCommentCache } from './cache-lifecycle';
import { githubCommentStore } from './comment-projection';
import { type ThreadResolution, groupIntoThreads, projectReviewThread } from './review-comments';
import type { CollaborationRecord, GitHubBinding } from './document-record';
import type { CollaborationStore } from './record-store';
import type { GitHubAdapter, MergeMethod, PullRequestStatus, RepoRef } from './github-adapter';
import { type JobBody, type LifecycleState, markStateDecided } from './job-hub';
import { branchNameFor } from './lifecycle';
import { PublishVerificationError } from './publish';

import { type ReadinessVerdict, deriveReadiness } from './readiness';

// Re-exported so every existing caller keeps importing readiness from here.
export { deriveReadiness };
export type { ReadinessVerdict };

/** The Pull Request facts a derivation needs. A subset of `PullRequestStatus`. */
export type PullSnapshot = Pick<PullRequestStatus, 'state' | 'merged' | 'mergeable'>;

/**
 * LLD §7 — the document's state, derived from the durable facts rather than recalled.
 *
 * Order matters and is the requirement order: a merged PR is `merged`, a PR closed
 * without merging is `closed` (R-8.19 — never left in `pr-open` forever), a PR GitHub
 * says cannot merge is `conflicted` (R-8.20), otherwise readiness decides between
 * `ready` and `pr-open` (R-8.15 / R-8.16). `mergeable: null` means GitHub has not
 * finished computing it and is deliberately NOT treated as a conflict.
 */
export function deriveLifecycleState(input: { pull: PullSnapshot; readiness: ReadinessVerdict }): LifecycleState {
  const { pull, readiness } = input;
  if (pull.merged) return 'merged';
  if (pull.state === 'closed') return 'closed';
  if (pull.mergeable === false) return 'conflicted';
  return readiness.ready ? 'ready' : 'pr-open';
}

/* ------------------------------------------------------------------ *
 * Typed failures — one class per state a client must tell apart
 * ------------------------------------------------------------------ */

/** R-8.15 — mark-ready refused because unresolved comments exist. */
export class ReadyGateError extends Error {
  readonly name = 'ReadyGateError';
  /** The body recorded `pr-open` before throwing this — see `markStateDecided`. */
  readonly stateDecided = true;
  readonly documentId: string;
  readonly verdict: ReadinessVerdict;

  constructor(documentId: string, verdict: ReadinessVerdict) {
    // R-8.25 — the verdict names its own reason, unknown resolution included.
    super(`${documentId} is not ready: ${verdict.reason ?? 'no reason recorded'}`);
    this.documentId = documentId;
    this.verdict = verdict;
  }
}

/** Why a merge was refused. Each maps to exactly one recorded state. */
export type MergeRefusal = 'unresolved-comments' | 'base-conflict' | 'not-open';

/**
 * R-8.17 / R-8.20 — the merge did not happen, and no attempt was made to make it
 * happen. `reason` is the discriminator; the state recorded alongside it is
 * `pr-open` for `unresolved-comments`, `conflicted` for `base-conflict`, and the PR's
 * own derived state for `not-open`.
 */
export class MergeRefusedError extends Error {
  readonly name = 'MergeRefusedError';
  /** The body recorded the refusal's own state before throwing this. */
  readonly stateDecided = true;
  readonly documentId: string;
  readonly reason: MergeRefusal;
  readonly verdict: ReadinessVerdict | null;

  constructor(documentId: string, reason: MergeRefusal, message: string, verdict: ReadinessVerdict | null = null) {
    super(message);
    this.documentId = documentId;
    this.reason = reason;
    this.verdict = verdict;
  }
}

/**
 * R-8.22 — the base branch changed one of the paths this document generates, since the
 * branch point. A *distinct* failure from `PublishVerificationError`: the bytes on the
 * branch are exactly what was sent, and merging would legitimately produce different
 * content. The fix is a rebase, not an investigation.
 */
export class BaseDivergedError extends Error {
  readonly name = 'BaseDivergedError';
  /** The wrapper recorded `base-diverged` before throwing this. */
  readonly stateDecided = true;
  readonly documentId: string;
  readonly branch: string;
  readonly baseBranch: string;
  /** The generated paths that moved on base. Never empty when this is thrown. */
  readonly paths: string[];

  constructor(args: { documentId: string; branch: string; baseBranch: string; paths: string[] }) {
    super(
      `${args.baseBranch} has changed ${args.paths.join(', ')} since ${args.branch} was branched — rebase before publishing (no automatic resolution)`,
    );
    this.documentId = args.documentId;
    this.branch = args.branch;
    this.baseBranch = args.baseBranch;
    this.paths = args.paths;
  }
}

/* ------------------------------------------------------------------ *
 * R-8.18 — orphaned branch cleanup
 * ------------------------------------------------------------------ */

/** What one cleanup pass found and did. All four combinations are meaningful. */
export type OrphanCleanupResult = {
  /** True when the durable signal "branch created, nothing opened against it" was present. */
  orphaned: boolean;
  branch: string | null;
  /** False when the ref was already gone — which is still the outcome asked for. */
  branchDeleted: boolean;
  bindingCleared: boolean;
};

export type OrphanCleanupInput = {
  adapter: GitHubAdapter;
  repo: ResolvedCollaborationConfig;
  store: CollaborationStore;
  documentId: string;
  /** Optional progress sink, so the cleanup is visible on the SSE stream (R-8.24). */
  log?: (text: string) => void;
};

/**
 * R-8.18 — leave no orphaned branch behind after a partial create.
 *
 * 8.2 writes the binding **twice**: `{ branch }` once the branch exists, then
 * `{ branch, pullNumber, headSha }` once the PR is open. So `branch && pullNumber ===
 * undefined` is the durable, on-disk signal of "a branch was created and nothing was
 * opened against it" — that is what this detects. The branch name is also deterministic
 * (`branchNameFor`), so a create that died between `createBranch` and the binding write
 * is still cleaned up: with no binding at all, the deterministic name is probed and the
 * ref deleted if it happens to exist.
 *
 * Deleting an already-absent ref is success, not failure (`deleteBranch` resolves
 * `false`), which is what makes this safe to run on every retry.
 */
export async function cleanupOrphanedBranch(input: OrphanCleanupInput): Promise<OrphanCleanupResult> {
  const { adapter, repo, store, documentId, log } = input;
  const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };
  const doc = await store.read(documentId);
  const binding = doc?.github ?? null;

  if (binding && typeof binding.pullNumber === 'number') {
    // A PR exists: the branch is not an orphan, it is the conversation.
    return { orphaned: false, branch: binding.branch, branchDeleted: false, bindingCleared: false };
  }

  const branch = binding?.branch ?? branchNameFor(documentId);
  log?.(`cleaning up orphaned branch ${branch} (no pull request was opened)`);
  const branchDeleted = await adapter.deleteBranch(repoRef, branch);

  let bindingCleared = false;
  if (doc && binding) {
    // Clear the binding, not the document: the draft itself is still the user's work.
    const { github: _dropped, ...rest } = doc;
    await store.write(rest as CollaborationRecord);
    bindingCleared = true;
  }
  return { orphaned: binding !== null || branchDeleted, branch, branchDeleted, bindingCleared };
}

/**
 * R-8.18 — wrap 8.2's `create` body so a partial failure cleans up after itself and
 * still fails. A wrapper rather than an edit to `lifecycle.ts`: create's own contract
 * ("every failure rejects, the hub records `failed`") is unchanged, and its 21 tests
 * keep describing exactly what create does on its own.
 *
 * The cleanup runs on the way out of a rejection and its own errors are swallowed into
 * a log line — a GitHub outage during cleanup must not replace the real failure with a
 * less useful one, and `reconcile` will find the orphan again later (R-8.24).
 */
export function withOrphanCleanup(
  body: JobBody,
  input: { adapter: GitHubAdapter; repo: ResolvedCollaborationConfig; store: CollaborationStore; documentId: string },
): JobBody {
  return async (ctx) => {
    try {
      await body(ctx);
    } catch (err) {
      try {
        const result = await cleanupOrphanedBranch({ ...input, log: (text) => ctx.log(text, 'progress') });
        if (result.branchDeleted) ctx.log(`deleted orphaned branch ${result.branch}`, 'progress');
      } catch (cleanupErr) {
        ctx.log(`orphaned branch cleanup failed: ${(cleanupErr as Error).message} — a later sync reconciles it`, 'error');
      }
      throw err;
    }
  };
}

/* ------------------------------------------------------------------ *
 * R-8.22 — base divergence
 * ------------------------------------------------------------------ */

export type BaseDivergenceInput = {
  adapter: GitHubAdapter;
  repo: ResolvedCollaborationConfig;
  branch: string;
  /** The generated paths whose divergence matters. */
  paths: readonly string[];
};

/**
 * R-8.22 — the generated paths that changed **on base** since the branch point.
 *
 * `compareCommits(repo, branch, baseBranch)` answers exactly that: its `files` are the
 * paths differing between the merge base (the branch point) and base's current head, so
 * a path this document generates appearing there means base moved it underneath us.
 *
 * The rejected alternative was comparing the blob at each path on base against the blob
 * on the branch. It cannot work: publish's own commits make branch and base differ at
 * those paths by design, so every second publish would report divergence. The compare
 * endpoint is the only formulation that asks about the *branch point* without anything
 * having been stored at create time.
 */
export async function detectBaseDivergence(input: BaseDivergenceInput): Promise<string[]> {
  const { adapter, repo, branch, paths } = input;
  const comparison = await adapter.compareCommits({ owner: repo.owner, repo: repo.repo }, branch, repo.baseBranch);
  const changed = new Set(comparison.files);
  return paths.filter((p) => changed.has(p));
}

/**
 * R-8.21 / R-8.22 — wrap 8.3's `publish` body so its typed failures become distinct
 * recorded states instead of a generic `failed`.
 *
 * A wrapper, again, rather than an edit to `publish.ts`: that module's suite asserts
 * both its exact state sequence and that it never reads `repo.baseBranch`, and both
 * remain true of the body itself. The states are declared here, on the way out:
 *   - `PublishVerificationError` → `verification-failed` (R-8.21). The body has already
 *     aborted before any merge — publish never merges at all — so "no merge follows" is
 *     structural, and re-asserted by the test.
 *   - `BaseDivergedError` → `base-diverged` (R-8.22), thrown by the optional pre-check
 *     **before** the wrapped body runs, so nothing is committed.
 * Anything else rejects unchanged and the hub records `failed`.
 *
 * `checkBaseDivergence` is opt-in because turning it on adds a GitHub read to every
 * publish, which changes publish's shipped call sequence — a contract change that
 * belongs to whoever owns that route, not to a wrapper.
 */
export function withPublishFailureStates(
  body: JobBody,
  input: {
    adapter: GitHubAdapter;
    repo: ResolvedCollaborationConfig;
    store: CollaborationStore;
    documentId: string;
    /** R-8.22 — run the pre-commit base-divergence check. Off by default. */
    checkBaseDivergence?: boolean;
  },
): JobBody {
  return async (ctx) => {
    if (input.checkBaseDivergence) {
      const doc = await input.store.read(input.documentId);
      const branch = doc?.github?.branch;
      if (doc && branch) {
        // Publish commits one artifact, at the document's own path (LLD §7), so that
        // is the only path a base change could legitimately diverge on.
        const paths = [doc.documentPath];
        const diverged = await detectBaseDivergence({ adapter: input.adapter, repo: input.repo, branch, paths });
        if (diverged.length > 0) {
          // Before the commit, so nothing is written and nothing is resolved for anyone.
          ctx.setState('base-diverged');
          throw new BaseDivergedError({ documentId: input.documentId, branch, baseBranch: input.repo.baseBranch, paths: diverged });
        }
      }
    }
    try {
      await body(ctx);
    } catch (err) {
      // `PublishVerificationError` belongs to 8.3 and is left exactly as it is; the
      // marker is attached here, at the point that also recorded the state.
      if (err instanceof PublishVerificationError) {
        ctx.setState('verification-failed');
        throw markStateDecided(err);
      }
      throw err;
    }
  };
}

/* ------------------------------------------------------------------ *
 * The job bodies this module owns
 * ------------------------------------------------------------------ */

/** What every body here needs. The same subset shape as 8.2's `CreateBodyInput`. */
export type RecoveryBodyInput = {
  documentId: string;
  repo: ResolvedCollaborationConfig;
  store: CollaborationStore;
};

/** `merge` additionally chooses how (R-4.7). Defaults to a merge commit. */
export type MergeBodyInput = RecoveryBodyInput & { method?: MergeMethod };

export type RecoveryBodyOptions = {
  adapter: GitHubAdapter;
  /**
   * R-5.8 — absolute path of the local comment cache, dropped when a merge actually
   * merges. A thunk, not a value, for the same reason the document store is one: a
   * runtime "change directory" must retire the *current* cache, not the one that existed
   * when the bodies were built. Omit when the session runs without a cache.
   */
  commentCachePath?: () => string | undefined;
};

export type RecoveryJobBodies = {
  /** R-8.19 / R-8.20 / R-8.24 — re-derive the document's state from GitHub. */
  reconcile(input: RecoveryBodyInput): JobBody;
  /** R-8.15 — declare `ready`, or refuse with the unresolved threads named. */
  markReady(input: RecoveryBodyInput): JobBody;
  /** R-8.17 / R-8.20 — re-verify at merge time, then merge, or refuse. */
  merge(input: MergeBodyInput): JobBody;
};

/** The binding, or a rejection naming what is missing. */
async function requireBinding(
  store: CollaborationStore,
  documentId: string,
): Promise<{ doc: CollaborationRecord; binding: GitHubBinding & { pullNumber: number } }> {
  const doc = await store.read(documentId);
  if (!doc) throw new Error(`no collaboration document: ${documentId}`);
  const binding = doc.github;
  if (!binding || typeof binding.pullNumber !== 'number') throw new Error(`no open pull request for ${documentId}`);
  return { doc, binding: binding as GitHubBinding & { pullNumber: number } };
}

/**
 * The freshest possible readiness, read at the moment of asking (R-8.17). Straight from
 * GitHub: the review comments over REST, grouped into threads (R-5.17), with the
 * review-thread resolution joined on by the root's `databaseId` (R-4.15). No cache is
 * consulted anywhere on this path (R-5.9), and nothing here writes resolution (R-5.13).
 *
 * The GraphQL half is allowed to fail on its own (R-4.12): every thread then carries no
 * `isResolved`, `deriveReadiness` counts it as unknown, and the document is NOT Ready
 * with the unknown state named (R-8.25). Refusing on a failed read is the whole point —
 * a caught error that fell through to "resolved" would be R-8.26 exactly.
 */
async function readReadiness(
  adapter: GitHubAdapter,
  repo: ResolvedCollaborationConfig,
  pullNumber: number,
): Promise<ReadinessVerdict> {
  const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };
  const threads = groupIntoThreads(await adapter.listReviewComments(repoRef, pullNumber));

  let resolutions: Map<number, ThreadResolution> | null = null;
  try {
    const read = await adapter.listThreadResolution(repoRef, pullNumber);
    resolutions = new Map(read.map((r) => [r.rootCommentId, r]));
  } catch {
    resolutions = null;
  }

  return deriveReadiness(
    threads.map((thread) => {
      const resolution = resolutions?.get(thread.root.id);
      return projectReviewThread(thread, { ...(resolution ? { resolution } : {}) });
    }),
  );
}

export function createRecoveryBodies(options: RecoveryBodyOptions): RecoveryJobBodies {
  const { adapter, commentCachePath } = options;

  return {
    /**
     * R-8.24 — the reconciler. Every failure below (and every failure anywhere else in
     * the lifecycle) is recoverable by running this: it reads the durable signals and
     * declares what is actually true, so nothing is stranded in a state the system
     * cannot leave. R-8.19 in particular is *this* body: a PR closed on github.com is
     * only ever observed here — the poll does *not* see it. The `sync` body
     * (`lifecycle.ts`) reads comments via `githubCommentStore().read()` and never calls
     * `getPullRequest`, so no amount of polling will move a document to `closed`.
     * `reconcile` is also wired to no route in either host today, so in practice
     * nothing observes a closed PR at all. Both facts are tracked as U-4 in
     * `docs/tasks/github-pr-collaborative-documents.md`; do not read this body as a
     * live safety net until one of them is fixed.
     */
    reconcile: (input) => async (ctx) => {
      const { documentId, repo, store } = input;
      const doc = await store.read(documentId);
      if (!doc) throw new Error(`no collaboration document: ${documentId}`);

      const pullNumber = doc.github?.pullNumber;
      if (typeof pullNumber !== 'number') {
        // R-8.18 — the partial-create case. Clean up and report the document as what it
        // now is: a draft with nothing open against it, which `start` can retry.
        const cleanup = await cleanupOrphanedBranch({
          adapter,
          repo,
          store,
          documentId,
          log: (text) => ctx.log(text, 'progress'),
        });
        ctx.log(
          cleanup.orphaned
            ? `reconciled ${documentId}: orphaned branch ${cleanup.branch} removed (deleted=${cleanup.branchDeleted})`
            : `reconciled ${documentId}: no pull request and no branch — still a draft`,
        );
        ctx.setState('draft');
        return;
      }

      const pull = await adapter.getPullRequest({ owner: repo.owner, repo: repo.repo }, pullNumber);
      const readiness = await readReadiness(adapter, repo, pullNumber);
      const state = deriveLifecycleState({ pull, readiness });
      ctx.log(
        `reconciled ${documentId}: #${pullNumber} is ${pull.state}${pull.merged ? ' (merged)' : ''}, ` +
          `${readiness.unresolved} of ${readiness.total} thread(s) unresolved, ${readiness.unknown} unknown — ${state}`,
      );
      // R-8.20 — a conflict is reported and nothing else. No rebase, no force push, no
      // regenerated content: this package never resolves a conflict on anyone's behalf.
      if (state === 'conflicted') {
        ctx.log(`#${pullNumber} cannot merge into ${repo.baseBranch} (${pull.mergeableState}) — resolve it on github.com`, 'error');
      }
      ctx.setState(state);
    },

    /**
     * R-8.15 — the Ready gate. Note what it does NOT do: it stores nothing. It reads the
     * conversation, derives, and declares. A caller that asks twice gets two independent
     * derivations, which is the whole point (R-8.16).
     */
    markReady: (input) => async (ctx) => {
      const { documentId, repo, store } = input;
      const { binding } = await requireBinding(store, documentId);
      const readiness = await readReadiness(adapter, repo, binding.pullNumber);
      if (!readiness.ready) {
        // R-8.25 — the reason names the unknown state when the resolution read failed.
        // The ids follow it so an operator can go straight to the threads in question.
        ctx.log(
          `not ready: ${readiness.reason} — ${[...readiness.unresolvedCommentIds, ...readiness.unknownCommentIds].join(', ')}`,
          'error',
        );
        ctx.setState('pr-open');
        throw new ReadyGateError(documentId, readiness);
      }
      ctx.log(`all ${readiness.total} thread(s) resolved on GitHub — ready`);
      ctx.setState('ready');
    },

    /**
     * R-8.17 — merge, with readiness re-derived **here**, from GitHub, at merge time.
     * The state the hub holds and the result of the last poll are both ignored on
     * purpose; they are exactly what the requirement forbids trusting.
     */
    merge: (input) => async (ctx) => {
      const { documentId, repo, store } = input;
      const repoRef: RepoRef = { owner: repo.owner, repo: repo.repo };
      const { doc, binding } = await requireBinding(store, documentId);

      const pull = await adapter.getPullRequest(repoRef, binding.pullNumber);
      if (pull.merged || pull.state === 'closed') {
        const state = deriveLifecycleState({ pull, readiness: deriveReadiness([]) });
        ctx.setState(state);
        throw new MergeRefusedError(documentId, 'not-open', `#${binding.pullNumber} is already ${state}`);
      }

      // The re-verification. Fetched now, not recalled.
      const readiness = await readReadiness(adapter, repo, binding.pullNumber);
      if (!readiness.ready) {
        // R-8.25 — same reason string at merge time; unknown resolution refuses too.
        ctx.log(
          `merge refused at merge time: ${readiness.reason} — ${[...readiness.unresolvedCommentIds, ...readiness.unknownCommentIds].join(', ')}`,
          'error',
        );
        // R-8.16 — back to PR-open, because that is what it derives to now.
        ctx.setState('pr-open');
        throw new MergeRefusedError(documentId, 'unresolved-comments', `merge refused for ${documentId}: unresolved comments`, readiness);
      }

      // R-8.20 — GitHub says it cannot merge. Report, do not resolve.
      if (pull.mergeable === false) {
        ctx.log(`merge refused: #${binding.pullNumber} conflicts with ${repo.baseBranch} (${pull.mergeableState})`, 'error');
        ctx.setState('conflicted');
        throw new MergeRefusedError(documentId, 'base-conflict', `merge refused for ${documentId}: base conflict`);
      }

      // R-5.8 — the merge goes through `mergeAndDropCommentCache` so the cache is retired
      // by the same act that merges, and only when the merge actually merged. The
      // pre-merge conversation it returns is read from GitHub (R-5.9), never the cache.
      const { merge: result, cacheDeleted } = await mergeAndDropCommentCache({
        store: githubCommentStore({
          adapter,
          repo: repoRef,
          pullNumber: binding.pullNumber,
          documentId: doc.documentId,
          documentPath: doc.documentPath,
        }),
        merge: () => adapter.mergePullRequest(repoRef, binding.pullNumber, input.method),
        ...((): { cachePath?: string } => {
          const cachePath = commentCachePath?.();
          return cachePath ? { cachePath } : {};
        })(),
      });
      if (!result.merged) {
        // GitHub declined at the last moment — most often a base change between the
        // check above and this call. Conflicted, not failed, and still not resolved.
        ctx.log(`merge declined by GitHub: ${result.message}`, 'error');
        ctx.setState('conflicted');
        throw new MergeRefusedError(documentId, 'base-conflict', `merge declined for ${documentId}: ${result.message}`);
      }
      ctx.log(`merged #${binding.pullNumber} at ${result.sha}${cacheDeleted ? ' — local comment cache dropped' : ''}`);
      ctx.setState('merged');
    },
  };
}

/**
 * The states this module can leave a document in, as a value — so a client (and the
 * test matrix) can enumerate them rather than hard-coding a list that drifts.
 */
export const FAILURE_STATES: readonly LifecycleState[] = ['failed', 'conflicted', 'verification-failed', 'base-diverged'];

/** True when `state` is a decided failure a later `reconcile` should be run against. */
export function isFailureState(state: LifecycleState): boolean {
  return FAILURE_STATES.includes(state);
}
