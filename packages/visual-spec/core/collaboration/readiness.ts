/**
 * readiness.ts — R-8.15's Ready gate, derived from a comment list and nothing else.
 *
 * WHY THIS IS NOT IN `failure-states.ts`. It used to be, and `ui/collab-app.tsx` imports
 * `deriveReadiness` to decide whether the Publish button is offered. `failure-states.ts`
 * also owns the recovery bodies, which reach `cache-lifecycle.ts` → `node:fs/promises`,
 * so that one value import dragged the filesystem into the browser bundle and the Vite
 * build failed on `"rm" is not exported by "__vite-browser-external"`. The gate is pure,
 * so it lives on its own; `failure-states.ts` re-exports it for existing callers.
 *
 * Nothing here may import a node builtin — `ui/browser-safety.test.ts` fails if one
 * becomes reachable from the app again.
 */
import type { ProjectedCommentRecord } from './comment-projection';

/* ------------------------------------------------------------------ *
 * Readiness — pure, derived, never stored (R-8.15 / R-8.16)
 * ------------------------------------------------------------------ */

/** What one readiness derivation saw. Everything a refusal needs to explain itself. */
export type ReadinessVerdict = {
  /** R-8.15 — true only when every open thread is resolved. Empty list ⇒ ready. */
  ready: boolean;
  /** Top-level comments considered, i.e. excluding replies and resolution markers. */
  total: number;
  unresolved: number;
  /** GitHub issue-comment ids of the unresolved threads, ascending. */
  unresolvedCommentIds: number[];
};

/**
 * R-8.15 — readiness from a comment list, and nothing else.
 *
 * Only **top-level** comments are gated. A record carrying `collab.replyTo` is a reply
 * (a resolution marker among them), and a reply belongs to its parent's thread — asking
 * a reply to be resolved on its own would make a thread unresolvable by construction.
 * Resolution itself is whatever `withResolutionState` derived, which `read()` already
 * applied; `resolved` absent means "never toggled", which is not resolved (R-5.14 keeps
 * that distinct from an explicit unresolve, but neither one is Ready).
 */
export function deriveReadiness(comments: readonly ProjectedCommentRecord[]): ReadinessVerdict {
  const threads = comments.filter((c) => !c.collab?.replyTo);
  const unresolvedCommentIds = threads
    .filter((c) => c.resolved !== true)
    .map((c) => c.github.issueCommentId)
    .sort((a, b) => a - b);
  return {
    ready: unresolvedCommentIds.length === 0,
    total: threads.length,
    unresolved: unresolvedCommentIds.length,
    unresolvedCommentIds,
  };
}
