/**
 * routes/git.ts — `GET /__vs/git`, the git context of the directory currently
 * being served (R-2.1), plus `GET /__vs/git/branches` and
 * `POST /__vs/git/checkout` (R-5.1 / R-5.5). One module, both hosts (R-2.3); the
 * hosts own the transport and the `/__vs` guard, this file owns nothing but the
 * answer.
 *
 * THE BRANCH ROUTES ARE ABSENT UNLESS CONFIGURED (R-6.3), not present-and-403.
 * They fall through to the same 404 an unclaimed path under this prefix gets, and
 * carry the same body — so a client cannot tell "the flag is off" from "this server
 * is older than you are". Both answers mean the same thing to a client that behaves,
 * and the difference is only useful to one that does not: the routes reach the
 * user's own working tree, and the default is off precisely because they do.
 * `resolveConfig` makes that default explicit rather than incidental.
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
import { checkoutBranch, listBranches } from '../../git-branches';

export type RouteResult = { status: number; json: unknown };

/**
 * The served directory, per request. A plain string is what the hosts hand over
 * (both keep the root in a `let` that `setRoot` reassigns); the getter form is
 * there for a host that would rather wire the route once than thread the value
 * through each call. Both resolve at call time — that is the whole point.
 */
export type RootRef = string | (() => string);

export type GitRouteOptions = {
  /**
   * R-6.3. False, and the two branch routes below do not exist. The hosts pass the
   * resolved configuration's value, which is `false` for a configuration that says
   * nothing.
   */
  allowCheckout?: boolean;
  /**
   * `readGitContext`'s injectable process seam, forwarded so tests can drive every
   * state without building real repositories. Left out in production, where the
   * git modules spawn the real `git`.
   */
  exec?: GitExecutor;
};

/**
 * `readGitContext` never throws (R-1.2) and neither does anything in
 * `core/git-branches.ts` (R-5.11), so there is no `try`/`catch` here: every failure
 * is already a value by the time it returns. R-1.11 and R-5.10 are held by those
 * modules too — a `GitContext`, a branch listing and a `--porcelain` path all carry
 * no absolute filesystem path, so serving them verbatim cannot leak the served
 * directory.
 *
 * The status codes are the transport's share of the answer and nothing more: 409 for
 * the dirty refusal because the working tree is in a state the request conflicts
 * with, 400 for a branch the repository does not have, 500 for a `git` that could
 * not be asked. The body carries the reason in every case, because a client that
 * must display "these files stopped the change" (R-6.6) cannot get the paths from a
 * status line.
 */
export async function handleGitRequest(
  root: RootRef,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  options: GitRouteOptions = {},
): Promise<RouteResult> {
  const { allowCheckout = false, exec } = options;
  const dir = () => (typeof root === 'function' ? root() : root);

  if (method === 'GET' && (pathname === '' || pathname === '/')) {
    const context: GitContext = await readGitContext(dir(), exec);
    return { status: 200, json: context };
  }

  if (allowCheckout && method === 'GET' && pathname === '/branches') {
    const listed = await listBranches(dir(), exec);
    if (!listed.ok) return { status: 500, json: { error: listed.reason } };
    return { status: 200, json: listed.listing };
  }

  if (allowCheckout && method === 'POST' && pathname === '/checkout') {
    const branch = body?.branch;
    // Refused here rather than in `checkoutBranch`, which is entitled to assume a
    // string: this is where a request body stops being one.
    if (typeof branch !== 'string' || branch === '') {
      return { status: 400, json: { error: 'missing branch' } };
    }
    const result = await checkoutBranch(dir(), branch, exec);
    if (result.ok) return { status: 200, json: { context: result.context } };
    if (result.reason === 'dirty') return { status: 409, json: { error: 'dirty', paths: result.paths } };
    if (result.reason === 'unknown-branch') return { status: 400, json: { error: 'unknown-branch' } };
    return { status: 500, json: { error: result.reason } };
  }

  return { status: 404, json: { error: `no route: ${method} /__vs/git${pathname}` } };
}
