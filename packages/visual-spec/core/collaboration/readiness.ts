/**
 * readiness.ts — R-8.15's Ready gate, derived from GitHub's own review-thread state.
 *
 * WHY THIS IS NOT IN `failure-states.ts`. It used to be, and `ui/collab-app.tsx` imports
 * `deriveReadiness` to decide whether the Publish button is offered. `failure-states.ts`
 * also owns the recovery bodies, which reach `cache-lifecycle.ts` → `node:fs/promises`,
 * so that one value import dragged the filesystem into the browser bundle and the Vite
 * build failed on `"rm" is not exported by "__vite-browser-external"`. The gate is pure,
 * so it lives on its own; `failure-states.ts` re-exports it for existing callers.
 *
 * Nothing here may import a node builtin — `ui/browser-safety.test.ts` fails if one
 * becomes reachable from the app again. The `ReviewThreadRecord` import is type-only for
 * the same reason.
 *
 * WHAT CHANGED. The input used to be issue comments carrying a resolution marker this
 * package invented. It is now the projected review threads, and resolution is GitHub's
 * `isResolved` (R-5.12) — read, never written (R-5.13). Nothing local can make a document
 * Ready (R-8.26): with no thread state read from GitHub there is no verdict to reach.
 */
import type { ReviewThreadRecord } from './review-comments';

/* ------------------------------------------------------------------ *
 * Readiness — pure, derived, never stored (R-8.15 / R-8.16 / R-8.25)
 * ------------------------------------------------------------------ */

/** What one readiness derivation saw. Everything a refusal needs to explain itself. */
export type ReadinessVerdict = {
  /** R-8.15 — true only when every thread reports `isResolved: true`. Empty list ⇒ ready. */
  ready: boolean;
  /** Threads considered. Replies ride on their thread's record, so none is counted twice. */
  total: number;
  /** Threads GitHub reports as `isResolved: false`. */
  unresolved: number;
  /**
   * R-8.25 — threads whose `isResolved` is `undefined`: the GraphQL read did not run or
   * failed. Counted apart from `unresolved` because "nobody resolved it" and "we could not
   * ask" are different facts, and flattening the second into the first would let a failed
   * read read as a deliberate state.
   */
  unknown: number;
  /** Root review-comment ids of the unresolved threads, ascending. */
  unresolvedCommentIds: number[];
  /** Root review-comment ids of the threads whose resolution could not be read, ascending. */
  unknownCommentIds: number[];
  /**
   * R-8.25 — why the document is not Ready, naming the unknown state when there is one.
   * `undefined` when `ready`.
   */
  reason?: string;
};

const idsOf = (threads: readonly ReviewThreadRecord[]): number[] =>
  threads.map((t) => t.github.reviewCommentId).sort((a, b) => a - b);

/**
 * R-8.15 / R-8.25 — readiness from the projected review threads, and nothing else.
 *
 * A thread counts as resolved only on an explicit `isResolved: true`. `false` blocks
 * because a reviewer has not closed it; `undefined` blocks because nobody knows, and a
 * gate that guessed either way would be claiming a fact it does not hold (R-5.15).
 * Resolving is done on github.com — this reads the answer, it never writes one (R-5.13).
 */
export function deriveReadiness(threads: readonly ReviewThreadRecord[]): ReadinessVerdict {
  const unresolved = threads.filter((t) => t.github.isResolved === false);
  const unknown = threads.filter((t) => t.github.isResolved === undefined);
  const unresolvedCommentIds = idsOf(unresolved);
  const unknownCommentIds = idsOf(unknown);

  const parts: string[] = [];
  if (unresolved.length > 0) {
    parts.push(`${unresolved.length} of ${threads.length} thread(s) unresolved — resolve them on github.com`);
  }
  if (unknown.length > 0) {
    parts.push(`resolution unknown for ${unknown.length} of ${threads.length} thread(s) — GitHub's review-thread state could not be read`);
  }

  return {
    ready: parts.length === 0,
    total: threads.length,
    unresolved: unresolved.length,
    unknown: unknown.length,
    unresolvedCommentIds,
    unknownCommentIds,
    ...(parts.length > 0 ? { reason: parts.join('; ') } : {}),
  };
}
