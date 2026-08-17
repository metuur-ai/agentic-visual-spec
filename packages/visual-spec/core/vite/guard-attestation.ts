/**
 * guard-attestation.ts — make "the request guard ran" a fact the collaboration
 * dispatch can check, instead of a property of source ordering that a future
 * edit can silently break.
 *
 * R-9.16 says the publish route must not be exposed until the request guard is
 * in place. Publish commits client-supplied bytes to a remote repository with
 * the author's credential, so "the guard is registered above it" is too weak a
 * guarantee to rest on: registration order is invisible at runtime, and both
 * hosts (`src/server.ts`, `core/vite/md-plugin.ts`) express it differently —
 * a Connect middleware in one, an `if` near the top of a request handler in the
 * other. Delete or move either one and every `/__vs/collab` route, publish
 * included, quietly becomes reachable.
 *
 * So the guard leaves a mark on the request it cleared, and the collaboration
 * dispatch refuses any request that does not carry it. The failure mode of a
 * removed guard becomes "collaboration returns 500" rather than "publish is
 * open to any web page in the user's browser" — fail closed, not fail open.
 *
 * The mark is a `WeakSet` keyed on the per-request headers object, not a header
 * or a field on the payload: nothing a client sends can forge it, and it cannot
 * outlive the request it describes.
 */

const cleared = new WeakSet<object>();

/** Message returned when the dispatch cannot confirm the guard ran. */
export const GUARD_NOT_RUN = 'request guard did not run for this request; refusing to dispatch';

/**
 * Record that `checkRequest` cleared this request. Called by each host at the
 * single point where the guard passes — never anywhere else.
 */
export function attestGuardRan(headers: object): void {
  cleared.add(headers);
}

/** True only for a request `attestGuardRan` was called on. */
export function guardRan(headers: object): boolean {
  return cleared.has(headers);
}
