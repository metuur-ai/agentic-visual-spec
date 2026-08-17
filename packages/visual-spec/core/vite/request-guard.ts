/**
 * request-guard.ts — refuse `/__vs` requests that a browser made on behalf of
 * another origin. Shared by both hosts (standalone server + Vite plugin) so the
 * two cannot drift; a second copy of a security check is a second chance to get
 * it wrong.
 *
 * Why this exists: `/__vs` is an unauthenticated localhost server that holds a
 * working directory (and, in collaboration mode, a GitHub credential). Nothing
 * here checks `content-type`, so a cross-origin `POST` with `text/plain` is a
 * CORS *simple request* — no preflight — and its body parses normally. That puts
 * `POST /__vs/comments/add` and `POST /__vs/apply/start` in reach of any page in
 * the user's browser, and the apply run splices comment text into a prompt for an
 * agent running with `--permission-mode acceptEdits`.
 *
 * The check is `Sec-Fetch-Site` plus a `Host` allow-list rather than a session
 * token, because it covers GET, POST and SSE uniformly. `EventSource` cannot set
 * headers, so a token scheme needs a separate story for the SSE event routes and
 * usually ends up putting the secret in a query string, where it leaks into logs
 * and `Referer`.
 */

/** Loopback hosts a browser may legitimately address this server by. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  // Strip the port; IPv6 literals arrive bracketed ("[::1]:5173").
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a request may touch `/__vs`.
 *
 * `Sec-Fetch-Site` is set by browsers on every request and cannot be forged by
 * page script. Absence means the caller is not a browser (curl, the CLI, a test),
 * which has no ambient authority to borrow and therefore cannot be the CSRF
 * vector this guards against — so absence is allowed rather than rejected.
 */
export function checkRequest(headers: {
  'sec-fetch-site'?: string | string[];
  host?: string | string[];
}): GuardVerdict {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const site = first(headers['sec-fetch-site']);
  const host = first(headers.host);

  if (site === 'cross-site' || site === 'same-site') {
    return { ok: false, reason: `cross-origin request rejected (Sec-Fetch-Site: ${site})` };
  }

  // A DNS-rebinding attack reaches us with an attacker-controlled Host, so this
  // is the half of the check that `Sec-Fetch-Site` alone does not cover.
  if (!isLoopbackHost(host)) {
    return { ok: false, reason: `non-loopback Host rejected (${host ?? 'absent'})` };
  }

  return { ok: true };
}
