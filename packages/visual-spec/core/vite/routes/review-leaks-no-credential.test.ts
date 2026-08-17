/**
 * review-leaks-no-credential.test.ts — R-W5.8: no credential reaches a response body, an
 * SSE event, or any other client-visible state.
 *
 * WHY A SCAN AND NOT AN ASSERTION PER FIELD. The requirement is a universal — *no*
 * response, *no* event — and a per-field assertion is a list of the fields somebody
 * thought of. So the shape here is: plant one recognisable credential where a credential
 * really lives, drive the whole review surface, serialise everything that came back, and
 * require the string to be absent from all of it. A route added tomorrow is covered by
 * the same scan the moment it is added to the walk, and a route that starts echoing `gh`'s
 * stderr fails without anyone having predicted which field it would echo it into.
 *
 * WHERE THE CREDENTIAL IS PLANTED, AND WHY THERE. Not in a field this package controls —
 * that would test that we do not deliberately serialise a token, which nobody was going to
 * do. It is planted in `gh`'s own output, which is where a leak actually comes from: `gh`
 * echoes request context on failure, and that context carries the `Authorization` header.
 * Every route below therefore fails with a real `GitHubError` built from real token-bearing
 * stderr, because the error path is the one that carries process output to the user. The
 * token is `ghp_`-shaped for the same reason: `scrubCredentials` is pattern-based, so a
 * credential of an invented shape would prove the scan works and nothing about the product.
 *
 * AND IN THE ENVIRONMENT. `GH_TOKEN` is set in the injected env, which is what
 * `credentialFingerprint` reads. That digest is legitimate to hold — it is a cache key and
 * cannot authenticate anything — but it is derived from the credential and it is
 * *server-side state*, so R-W5.8's "client-visible state" clause is only meaningful if the
 * digest is scanned for as well. It is.
 *
 * THE SSE HALF IS NOT THE SAME CLAIM AS THE RESPONSE HALF. A response body is built by a
 * route that can be read; an SSE frame is built by `job-hub.ts` from `(err as Error).message`
 * of whatever a job body rejected with, and no route is involved. That is a genuinely
 * separate path to the browser and it is driven separately, with a job body that rejects
 * with an error the token-bearing `gh` produced.
 *
 * WHY R-W5.5 IS NOT RE-ASSERTED HERE. "A review issues no git write" is already proved,
 * over argv, in `review-issues-no-git-write.test.ts`, and over the served directory in
 * `review-leaves-served-dir-alone.test.ts`. This file is the third clause of the same
 * story and deliberately overlaps neither.
 *
 * No network, no real `gh`, no real `git`: every executor is injected (R-4.8 / R-12.3).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialFingerprint, preflightCollaboration } from '../../collaboration/credentials';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import type { GhExecutor } from '../../collaboration/github-executor';
import { createJobHubRegistry, type SseSink } from '../../collaboration/job-hub';
import type { GitExecutor } from '../../git-context';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabDeps, type CollabRouteResult, createCollabRoutes } from './collab';

/**
 * The credential. `ghp_` plus enough alphanumerics to match a classic personal access
 * token, because that is the shape `scrubCredentials` recognises and the shape a real
 * leak has.
 */
const TOKEN = 'ghp_R3vi3wLeak0123456789abcdefGHIJKLMN';

/** The digest `credentialFingerprint` derives from it — server-side, and equally forbidden. */
const FINGERPRINT = credentialFingerprint({ GH_TOKEN: TOKEN });

/** `gh`'s verbose request log, which is how the header reaches stderr in the first place. */
const LEAKY_STDERR = `gh: HTTP 401 Bad credentials\n> GET /repos/acme/specs\n> Authorization: token ${TOKEN}\n`;

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO }, git: { allowCheckout: false } };
const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });
const ENV = { GH_TOKEN: TOKEN } as Record<string, string | undefined>;

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

/**
 * Every occurrence of a forbidden string in `text`, with a little context so a failure
 * shows *where* rather than merely *that*.
 *
 * The digest is searched for alongside the token itself. It is not a credential, but it is
 * derived from one and it is state the server holds about it, which is the clause R-W5.8
 * spends its last three words on.
 */
function leaks(label: string, text: string): string[] {
  const out: string[] = [];
  for (const [what, needle] of [
    ['the credential', TOKEN],
    ['the credential fingerprint', FINGERPRINT],
  ] as const) {
    let at = text.indexOf(needle);
    while (at !== -1) {
      out.push(`${label}: ${what} at ${at}: …${text.slice(Math.max(0, at - 60), at + needle.length + 20)}…`);
      at = text.indexOf(needle, at + 1);
    }
  }
  return out;
}

/** Serialise anything a route or a frame can carry, including the parts JSON drops. */
function serialise(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)) ?? String(value);
}

/* ------------------------------------------------------------------ *
 * Doubles that carry the credential the way the real ones would
 * ------------------------------------------------------------------ */

/**
 * A `gh` that authenticates successfully and then fails every call, echoing the request's
 * `Authorization` header into stderr exactly as the real one does.
 *
 * The preflight has to SUCCEED, or every route below refuses before it reaches the code
 * that could leak — a scan over a wall of 503s proves nothing. Its own stderr carries the
 * header too, so the successful arm is covered as well as the failing one.
 */
const leakyGh: GhExecutor = async (args) => {
  const isUserProbe = args.includes('/user');
  if (isUserProbe) {
    return {
      stdout: ['HTTP/2.0 200 OK', 'X-OAuth-Scopes: repo', 'Content-Type: application/json', '', '{"login":"octocat"}'].join('\n'),
      stderr: `> Authorization: token ${TOKEN}\n`,
      exitCode: 0,
    };
  }
  return { stdout: '', stderr: LEAKY_STDERR, exitCode: 1 };
};

/**
 * A `gh` whose preflight fails for a reason this package cannot classify.
 *
 * Deliberately NOT a 401. A 401 lands on the fixed `NO_CREDENTIAL` sentence, which quotes
 * nothing and could not leak whatever `gh` said — so scanning it would prove only that a
 * constant is a constant. The unclassified arm is the one that interpolates `gh`'s stderr
 * into the message a browser renders, which is the arm worth scanning.
 */
const unclassifiedGh: GhExecutor = async () => ({
  stdout: 'HTTP/2.0 500 Internal Server Error\n\n{"message":"upstream is unwell"}',
  stderr: LEAKY_STDERR,
  exitCode: 1,
});

/**
 * A served directory that is not a git working tree, so source resolution falls through to
 * the host (R-W1.3) and every read of the review is a `gh` call — which is what puts the
 * leaky executor on the path of every route below.
 */
const notARepo: GitExecutor = async () => ({ stdout: '', exitCode: 128 });

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'vs-no-credential-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function router(gh: GhExecutor, overrides: Partial<CollabDeps> = {}) {
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents: () => {
      throw new Error('a review must not read the document store');
    },
    // The real preflight, over the leaky executor: its message is one of the strings a
    // browser renders, and it is built from `gh`'s stderr.
    preflight: (repo) => preflightCollaboration({ repo, exec: gh, env: ENV }),
    authorize: ALLOW_ALL,
    baseDir: () => baseDir,
    git: notARepo,
    // The real adapter, so the errors the routes see are the real `GitHubError`s built
    // from the real stderr — not an invented rejection this file decided was realistic.
    repoAdapter: () => createGitHubAdapter(gh),
    env: ENV,
    ...overrides,
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): Promise<CollabRouteResult> => r.handle({ method, pathname, query, body });

/** Every route a review touches, in the order a reviewer touches them. */
const REVIEW_ROUTES: { method: string; pathname: string; body?: Record<string, unknown>; query?: Record<string, string> }[] = [
  { method: 'GET', pathname: '' },
  { method: 'GET', pathname: '/pulls' },
  { method: 'GET', pathname: '/pulls/awaiting' },
  { method: 'GET', pathname: '/pulls/mounted' },
  { method: 'POST', pathname: '/pulls/7/mount' },
  { method: 'GET', pathname: '/pulls/7/files' },
  { method: 'GET', pathname: '/pulls/7/description' },
  { method: 'GET', pathname: '/pulls/7/tree', query: { path: '' } },
  { method: 'GET', pathname: '/pulls/7/raw', query: { path: 'docs/spec.md' } },
  { method: 'GET', pathname: '/pulls/7/comments' },
  { method: 'GET', pathname: '/pulls/7/drafts' },
  { method: 'POST', pathname: '/pulls/7/drafts', body: { path: 'docs/spec.md', comment: 'a held note', headSha: 'a'.repeat(40), line: 3 } },
  { method: 'DELETE', pathname: '/pulls/7/mount' },
];

/* ================================================================== *
 * R-W5.8 — responses
 * ================================================================== */
describe('R-W5.8 — no response of a review carries a credential', () => {
  it('walks the whole review surface with a leaky gh behind it and leaks nothing', async () => {
    const r = router(leakyGh);
    const found: string[] = [];
    let sawFailure = false;

    for (const { method, pathname, body, query } of REVIEW_ROUTES) {
      const res = await call(r, method, pathname, body ?? {}, query ?? {});
      // The routes really did reach `gh` and really did fail on it — otherwise the scan
      // below is over a surface the credential never had a chance to reach.
      if (res.status >= 400) sawFailure = true;
      found.push(...leaks(`${method} ${pathname} → ${res.status}`, serialise(res.json)));
    }
    r.dispose();

    expect(sawFailure, 'no route failed, so nothing carried gh output at all').toBe(true);
    expect(found.join('\n')).toBe('');
  });

  it('reports the failure the leaky gh caused, with the credential taken out of it', async () => {
    /*
     * The positive half, and the reason the test above is not passing merely because the
     * responses are empty: `gh`'s stderr really is surfaced to the user — that is
     * deliberate, an unexplained 502 is worse than a bad one — and what reaches them is
     * the same text with the credential replaced.
     */
    const r = router(leakyGh);
    const res = await call(r, 'GET', '/pulls');
    r.dispose();

    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = serialise(res.json);
    expect(text).toContain('Bad credentials');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(TOKEN);
  });

  it('the availability payload of a server whose preflight failed carries none of it either', async () => {
    // The other end of the surface: the first thing the browser asks for, answered from a
    // message that really does quote `gh`.
    const r = router(unclassifiedGh);
    const availability = await r.availability();
    const res = await call(r, 'GET', '');
    r.dispose();

    expect(leaks('availability()', serialise(availability)).join('\n')).toBe('');
    expect(leaks('GET /__vs/collab', serialise(res.json)).join('\n')).toBe('');
    // It really is the unavailable payload, and it really did quote the stderr — so the
    // absence above is the scrubber's doing rather than the message's brevity.
    expect(res.json).toMatchObject({ available: false, reason: 'preflight_failed' });
    expect(serialise(res.json)).toContain('[redacted]');
  });

  it('detects the credential when one genuinely is present', () => {
    /*
     * The scan's negative control. Three absences above pass exactly as well when the
     * needle is wrong as when the product is right, so the scanner is shown to answer
     * differently for a payload that really does leak — including one that leaks only the
     * fingerprint, which is the half most easily lost to a typo.
     */
    expect(leaks('x', serialise({ error: `denied: ${TOKEN}` })).length).toBe(1);
    expect(leaks('x', serialise({ cacheKey: FINGERPRINT })).length).toBe(1);
    expect(leaks('x', serialise({ error: 'denied' }))).toEqual([]);
  });
});

/* ================================================================== *
 * R-W5.8 — SSE events
 * ================================================================== */
describe('R-W5.8 — no SSE event of a review carries a credential', () => {
  /** An `SseSink` that keeps every frame written to it. */
  function recordingSink(): { sink: SseSink; frames: string[] } {
    const frames: string[] = [];
    return {
      frames,
      sink: {
        writeHead: () => undefined,
        write: (chunk: string) => frames.push(chunk),
        on: () => undefined,
        end: () => undefined,
        writableEnded: false,
      },
    };
  }

  it('a job that fails on the leaky gh streams the failure without the credential in it', async () => {
    const jobs = createJobHubRegistry();
    const r = router(leakyGh, { jobs });
    const { sink, frames } = recordingSink();

    // Subscribe through the route, not through the hub: the frames a browser sees are the
    // ones this path writes, and `subscribe` is what replays the snapshot into them.
    const subscribed = await r.handle({ method: 'GET', pathname: '/doc-1/events', query: {}, body: {}, sse: sink });
    expect(subscribed).toMatchObject({ status: 200, streamed: true });

    /*
     * A job body that fails the way a real one does: it calls the adapter, the adapter
     * calls the leaky `gh`, and the `GitHubError` it throws is what the hub turns into a
     * `job-error` frame. The hub reads `(err as Error).message` verbatim — it does no
     * scrubbing of its own and should not, because the scrubbing belongs at the process
     * seam — so this is the assertion that the seam is where the message came from.
     */
    const adapter = createGitHubAdapter(leakyGh);
    const started = jobs.hub('doc-1').start({
      kind: 'sync',
      run: async () => {
        await adapter.getPullRequest({ owner: 'acme', repo: 'specs' }, 7);
      },
    });
    expect(started.status).toBe(200);

    // Let the rejection settle and be broadcast.
    await new Promise((ok) => setTimeout(ok, 0));
    await new Promise((ok) => setTimeout(ok, 0));
    r.dispose();

    const stream = frames.join('');
    // The job really did fail, and the frame really does carry `gh`'s words — so the
    // absence below is scrubbing, not silence.
    expect(stream).toContain('"type":"job-error"');
    expect(stream).toContain('[redacted]');
    expect(leaks('sse', stream).join('\n')).toBe('');
  });
});
