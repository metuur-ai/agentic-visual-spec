/**
 * collab-wiring.reroot.test.ts — R-10.1 at the wiring layer.
 *
 * The shipped re-root tests live one layer up: `collab.reroot-epoch.test.ts` covers the
 * R-10.6 epoch guard and `collab.reroot-reason.test.ts` covers R-10.7's reason. Both
 * build the router directly, so neither could observe that `createCollabWiring` reads
 * `config()` exactly once and that no host ever called it again. `collab-wiring.test.ts`
 * builds from a fixed `ENABLED` / `DISABLED` and never re-roots.
 *
 * That gap is the whole bug this file exists for. Two things were latched at startup:
 *
 *   1. the `NOT_CONFIGURED` early return — a server started outside a GitHub repository
 *      kept empty bodies and a denying authorizer for the rest of its life, while the
 *      availability route (which re-derives per request) reported an authenticated
 *      session for the repository the user had just switched to. The UI said
 *      collaboration was on and every operation failed;
 *   2. `createLifecycle({ repo })` — the poller went on naming the startup repository
 *      after the routes had moved to another one.
 *
 * Both assertions below are about `gh` argv, not about internal state: what the wiring
 * believes is only interesting insofar as it changes which repository GitHub is asked
 * about.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { CollaborationRecord } from '../../collaboration/document-record';
import type { CollaborationStore } from '../../collaboration/record-store';
import type { GhExecutor } from '../../collaboration/github-executor';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { JobEvent, JobSync, SseSink } from '../../collaboration/job-hub';
import type { IntervalScheduler } from '../../collaboration/lifecycle';
import type { ResolvedCollaborationConfig, ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabRouteResult, createCollabRoutes } from './collab';
import { createRebindableCollabWiring } from './collab-wiring';

const TEST_ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const configFor = (collaboration: ResolvedCollaborationConfig | null): ResolvedVisualSpecConfig => ({
  surfacesDir: 'surfaces',
  collaboration,
  git: { allowCheckout: false },
});

const REPO_A = { owner: 'acme', repo: 'docs', baseBranch: 'main' } as const;
const REPO_B = { owner: 'globex', repo: 'handbook', baseBranch: 'main' } as const;

const preflightFor = (repo: ResolvedCollaborationConfig): CollaborationPreflight => ({
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo,
});

const settled = () => new Promise((r) => setTimeout(r, 0));

function memoryDocuments(seed: CollaborationRecord[]): CollaborationStore {
  const map = new Map(seed.map((d) => [d.documentId, d]));
  return {
    async read(id) {
      return map.get(id) ?? null;
    },
    async write(doc) {
      map.set(doc.documentId, doc);
    },
    async list() {
      return [...map.keys()].sort();
    },
  };
}

/** `collab-wiring.test.ts`'s scheduler double — ticks fire only when a test says so. */
function fakeScheduler() {
  const ticks: Array<{ fn: () => void; cancelled: boolean }> = [];
  const schedule: IntervalScheduler = (fn) => {
    const entry = { fn, cancelled: false };
    ticks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { schedule, fire: () => ticks.forEach((t) => !t.cancelled && t.fn()) };
}

/** Enough of an `SseSink` to make a hub report one watcher (R-8.6). */
function sink(): SseSink {
  const frames: (JobEvent | JobSync)[] = [];
  return {
    writeHead() {},
    write(chunk: string) {
      frames.push(JSON.parse(chunk.replace(/^data: /, '').trim()) as JobEvent | JobSync);
    },
    on() {},
    end() {},
    writableEnded: false,
  } as unknown as SseSink;
}

const DOC: CollaborationRecord = {
  documentId: 'doc-1',
  documentPath: 'documents/doc-1.json',
  title: 'Onboarding guide',
  markdown: '# Onboarding guide\n\nhello\n',
};

/**
 * A host wired the way `src/server.ts` and `core/vite/md-plugin.ts` wire one, with the
 * config in a `let` that a re-root reassigns — the shape `setRoot` produces.
 */
function host(initial: ResolvedCollaborationConfig | null, options: { polling?: boolean } = {}) {
  let config = configFor(initial);
  const exec = vi.fn<GhExecutor>(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
  // A sync with no GitHub binding has nothing to read and returns before the adapter, so
  // the polling case needs a document that is actually attached to a pull request.
  const documents = memoryDocuments([
    options.polling
      ? { ...DOC, github: { owner: 'acme', repo: 'docs', branch: 'vs/doc-1', pullNumber: 7, resolved: false } }
      : DOC,
  ]);
  const jobs = createJobHubRegistry();
  const { schedule, fire } = fakeScheduler();
  const wiring = createRebindableCollabWiring({
    config: () => config,
    documents: () => documents,
    jobs,
    exec,
    ...(options.polling ? { scheduler: schedule } : {}),
  });
  const router = createCollabRoutes({
    jobs,
    config: () => config,
    documents: () => documents,
    // Mirrors production, where the preflight answers about whichever repository it is
    // handed rather than a constant (R-W3.3).
    preflight: async (repo) => preflightFor(repo),
    bodies: wiring.bodies,
    authorize: TEST_ALLOW_ALL,
  });
  return {
    exec,
    /** Attach a subscriber, which is what R-8.6 keys polling on. */
    attachWatcher: (documentId: string) => jobs.hub(documentId).subscribe(sink()),
    tick: fire,
    pollingDocumentIds: () => wiring.pollingDocumentIds(),
    /** What `setRoot` does: reassign the config, then rebuild the wiring. */
    reroot(next: ResolvedCollaborationConfig | null) {
      config = configFor(next);
      wiring.rebind();
    },
    call: (method: string, pathname: string, body: Record<string, unknown> = {}): Promise<CollabRouteResult> =>
      router.handle({ method, pathname, query: {}, body }),
  };
}

/** The `owner/repo` slugs any `gh api` argv mentioned, in call order. */
const reposTouched = (exec: ReturnType<typeof vi.fn>): string[] => {
  const seen: string[] = [];
  for (const [args] of exec.mock.calls as Array<[string[]]>) {
    for (const arg of args) {
      // Endpoints are built with a leading slash — `/repos/<owner>/<repo>/…`.
      const m = /^\/?repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(arg);
      if (m?.[1] && !seen.includes(m[1])) seen.push(m[1]);
    }
  }
  return seen;
};

describe('R-10.1 — collaboration wiring follows a re-root', () => {
  it('a server started outside a repository collaborates after being re-rooted into one', async () => {
    const h = host(null);

    // Startup: nothing configured, so the availability gate refuses ahead of every body.
    expect((await h.call('GET', '')).json).toMatchObject({ available: false, reason: 'not-configured' });
    expect((await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' })).status).toBe(503);
    await settled();
    expect(h.exec).not.toHaveBeenCalled();

    h.reroot(REPO_A);

    // The availability route always re-derived; that half was never broken, and it is
    // what made the failure so confusing — the browser was told it was authenticated
    // against the new repository while every operation below it was dead.
    expect((await h.call('GET', '')).json).toMatchObject({ available: true, login: 'octocat' });

    // The half that WAS broken. Before the rebuild this answered from `STUB_BODIES`
    // ("not implemented (task 8.2)") without the executor being reached at all.
    const started = await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    expect(started.status).toBe(200);
    await settled();
    expect(h.exec).toHaveBeenCalled();
    expect(reposTouched(h.exec)).toEqual(['acme/docs']);
  });

  /*
   * The poller is where the captured `repo` actually bit. Route-driven bodies take
   * `input.repo`, which the router resolves per request, so `create` and `publish`
   * followed the move even before this fix; `createLifecycle({ repo })` binds the
   * repository once (`lifecycle.ts:421`) and `sync()` closes over it (`:449`), so the
   * background sync went on reading comments from the startup repository into documents
   * served out of the new directory.
   */
  it('the poller follows the re-root instead of syncing the startup repository', async () => {
    const h = host(REPO_A, { polling: true });

    // R-8.6 — a watcher attaching is what starts the poller.
    h.attachWatcher('doc-1');
    h.tick();
    await settled();
    expect(reposTouched(h.exec)).toEqual(['acme/docs']);

    h.reroot(REPO_B);
    h.exec.mockClear();

    // The subscriber never detached — `rerooted()` does not drop SSE subscribers — so the
    // rebuilt wiring has to carry the polling across on its own.
    expect(h.pollingDocumentIds()).toEqual(['doc-1']);
    h.tick();
    await settled();
    expect(reposTouched(h.exec)).toEqual(['globex/handbook']);
  });

  it('operations move to the new repository, and never name the old one again', async () => {
    const h = host(REPO_A);

    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();
    expect(reposTouched(h.exec)).toEqual(['acme/docs']);

    h.reroot(REPO_B);
    h.exec.mockClear();

    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();
    expect(reposTouched(h.exec)).toEqual(['globex/handbook']);
  });

  it('R-9.19 — a re-root onto a directory with no GitHub origin puts collaboration back off', async () => {
    const h = host(REPO_A);
    h.reroot(null);
    h.exec.mockClear();

    expect((await h.call('GET', '')).json).toMatchObject({ available: false, reason: 'not-configured' });
    expect((await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' })).status).toBe(503);
    await settled();
    expect(h.exec).not.toHaveBeenCalled();
  });
});
