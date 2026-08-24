/**
 * run-lock.ts — the one lock that makes "an apply and a review never run at the
 * same time" true rather than nominal (R-3.4, R-8.4, R-8.5).
 *
 * `createApplyHub` keeps its `running` flag private inside its closure
 * (`apply.ts`), so a second hub built by mirroring it would get its **own** flag
 * and the two could run concurrently and race the sidecar. Both hubs consult one
 * instance of this module instead. Nothing here is module-level mutable except
 * the process-wide `sharedRunLock` below: `createRunLock()` is a factory so tests
 * get an isolated lock instead of leaking state between cases.
 *
 * The lock is deliberately dumb — no queue, no waiters, no timers. A holder that
 * dies without releasing is the hub's problem to notice, not this module's; every
 * terminal path in a hub must call `release`.
 */

/** Who may hold the lock. One value per hub. */
export type RunHolder = 'apply' | 'review';

/** The 409 a hub returns when the lock is held. `holder` is what lets the UI say which one. */
export type RunLockConflict = { status: 409; json: { error: string; holder: RunHolder } };

export interface RunLock {
  /** Take the lock. `false` means someone else holds it — call `heldBy()` to find out who. */
  acquire(holder: RunHolder): boolean;
  /** Release, but only if `holder` is the current holder. A non-holder's call is a no-op. */
  release(holder: RunHolder): void;
  heldBy(): RunHolder | null;
}

const MESSAGES: Record<RunHolder, string> = {
  apply: 'an apply is already running',
  review: 'a review session is already running',
};

/**
 * The conflict body for a rejected start. R-8.5 requires the response to identify
 * the *current holder*, not just that something is running, so the caller can tell
 * "your own apply is still going" apart from "a review has the slot".
 */
export function conflictFor(holder: RunHolder): RunLockConflict {
  return { status: 409, json: { error: MESSAGES[holder], holder } };
}

export function createRunLock(): RunLock {
  let holder: RunHolder | null = null;
  return {
    acquire(next) {
      if (holder !== null) return false;
      holder = next;
      return true;
    },
    release(who) {
      // Guarded so a late release from a finished run cannot free someone else's slot.
      if (holder === who) holder = null;
    },
    heldBy() {
      return holder;
    },
  };
}

/**
 * The process-wide lock the real hubs share. Both servers build their hubs once at
 * startup, so a single instance per process is the whole scope of the mutual
 * exclusion — matching the existing "one run at a time" behaviour rather than
 * widening it.
 */
export const sharedRunLock: RunLock = createRunLock();
