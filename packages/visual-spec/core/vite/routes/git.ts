/**
 * routes/git.ts — `GET /__vs/git`, the git context of the directory currently
 * being served (R-2.1). One module, both hosts (R-2.3); the hosts own the
 * transport and the `/__vs` guard, this file owns nothing but the answer.
 *
 * THE ROOT IS MUTABLE. `POST /__vs/dir/pick` calls the host's `setRoot`, and the
 * served directory changes underneath a running process. So the root arrives on
 * every call — as a value or as a getter — and is never captured here at wiring
 * time. A module that closed over the startup directory would keep reporting the
 * old repository for the rest of the process's life, which is R-2.2 broken in the
 * one way nothing else on screen would reveal.
 *
 * NO CACHE (R-2.4). An earlier design cached the parse keyed on the `mtime` of
 * `HEAD` and `config`. It is deliberately absent, for two reasons:
 *
 *   1. it was state with an invalidation rule, built to make a polling timer
 *      cheap — and the timer is gone. The client reads on mount and on focus, so
 *      the work it saved is work that now barely happens;
 *   2. its key was never specified. A root change to a *different* repository
 *      whose `HEAD` and `config` mtimes were indistinguishable would have served
 *      the previous repository's context — contradicting R-2.2 head on.
 *
 * Consequently this module holds no module-level mutable state, and its tests
 * assert that two consecutive requests with different underlying git state
 * produce different answers.
 */
import { type GitContext, type GitExecutor, readGitContext } from '../../git-context';

export type RouteResult = { status: number; json: unknown };

/**
 * The served directory, per request. A plain string is what the hosts hand over
 * (both keep the root in a `let` that `setRoot` reassigns); the getter form is
 * there for a host that would rather wire the route once than thread the value
 * through each call. Both resolve at call time — that is the whole point.
 */
export type RootRef = string | (() => string);

/**
 * `exec` is `readGitContext`'s injectable process seam, forwarded so tests can
 * drive every state without building real repositories. Left out in production,
 * where `readGitContext` spawns the real `git`.
 *
 * `readGitContext` never throws (R-1.2), so there is no `try`/`catch` here: every
 * failure is already `{ state: 'none' }` by the time it returns. R-1.11 is held by
 * that module too — a `GitContext` carries no filesystem path, so serving it
 * verbatim cannot leak the served directory.
 */
export async function handleGitRequest(
  root: RootRef,
  method: string,
  pathname: string,
  exec?: GitExecutor,
): Promise<RouteResult> {
  if (method === 'GET' && (pathname === '' || pathname === '/')) {
    const dir = typeof root === 'function' ? root() : root;
    const context: GitContext = await readGitContext(dir, exec);
    return { status: 200, json: context };
  }
  return { status: 404, json: { error: `no route: ${method} /__vs/git${pathname}` } };
}
