/**
 * collab-wiring.test.ts — THE INTEGRATION TEST FOR THE 7.2 ↔ 8.2 SEAM.
 *
 * 7.2 (`createCollabRoutes`) and 8.2 (`createLifecycle`) each pass their own suite in
 * isolation while being unable to reach each other: the routes ran 7.2's failing stubs
 * and 8.2's GitHub work had no HTTP entrypoint. Neither suite could notice, because
 * neither one drives both layers. This file does: it builds the bodies exactly the way
 * the hosts build them (`createCollabWiring`), hands them to the real router, drives
 * HTTP-shaped requests through it, and asserts on the `gh api` endpoints that come out
 * the far end. If the seam ever comes apart again, these endpoint lists go empty.
 *
 * No real network, no real `gh`, no real timer: the executor and the interval scheduler
 * are both injected.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { CollaborationRecord } from '../../collaboration/document-record';
import type { CollaborationStore } from '../../collaboration/record-store';
import type { GhExecutor, GhResult } from '../../collaboration/github-executor';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { JobEvent, JobSync, SseSink } from '../../collaboration/job-hub';
import type { IntervalScheduler, SyncResult } from '../../collaboration/lifecycle';
import { readGitHubBinding } from '../../collaboration/lifecycle';
import { gitBlobSha } from '../../collaboration/publish';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabRouteResult, createCollabRoutes } from './collab';
import { createCollabWiring } from './collab-wiring';

/** Test double. This suite is about body wiring, not gating; the router requires one. */
const TEST_ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../collaboration/fixtures');
const fixture = (name: string): string => readFileSync(resolve(fixturesDir, name), 'utf8');

const REPO = { owner: 'acme', repo: 'docs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO }, git: { allowCheckout: false } };
const DISABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: null, git: { allowCheckout: false } };

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

/** The `gh api` endpoint an argv carries — the same reader `github-adapter.test.ts` uses. */
const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;

function recorder(responses: Array<Partial<GhResult>>) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let i = 0;
  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const r = responses[i++] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, calls, endpoints: () => calls.map((c) => endpointOf(c.args)) };
}

function makeDoc(overrides: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    documentId: 'doc-1',
    documentPath: 'documents/doc-1.json',
    title: 'Onboarding guide',
    markdown: '# Onboarding guide\n\nhello\n',
    ...overrides,
  };
}

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

function fakeScheduler() {
  const ticks: Array<{ fn: () => void; cancelled: boolean }> = [];
  const schedule: IntervalScheduler = (fn) => {
    const entry = { fn, cancelled: false };
    ticks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { schedule, ticks, fire: () => ticks.forEach((t) => !t.cancelled && t.fn()) };
}

function sink() {
  const frames: (JobEvent | JobSync)[] = [];
  // `close` callbacks are captured rather than dropped, so a test can detach a
  // subscriber the way the transport does and observe what that costs the poller (R-8.6).
  const closers: Array<() => void> = [];
  const s: SseSink = {
    writeHead() {},
    write(chunk: string) {
      frames.push(JSON.parse(chunk.replace(/^data: /, '').trim()));
    },
    on(_event: 'close', cb: () => void) {
      closers.push(cb);
    },
    end() {},
    writableEnded: false,
  };
  return Object.assign(s, {
    frames,
    close: () => {
      for (const cb of closers) cb();
    },
  });
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

const CREATE_OK: Array<Partial<GhResult>> = [
  { stdout: fixture('git-ref.json') }, // getBranch(main)
  { stdout: fixture('create-ref.json') }, // createBranch
  { stdout: fixture('contents-put.json') }, // commitFile
  { stdout: fixture('pull-create.json') }, // createPullRequest
];
const LIST_COMMENTS: Partial<GhResult> = { stdout: fixture('projection-comments.json') };

/**
 * The host, assembled exactly as `src/server.ts` and `core/vite/md-plugin.ts` assemble
 * it — `createCollabWiring` then `createCollabRoutes({ bodies: wiring.bodies })`.
 */
function host(options: { config?: ResolvedVisualSpecConfig; responses?: Array<Partial<GhResult>> } = {}) {
  const config = options.config ?? ENABLED;
  const { exec, calls, endpoints } = recorder(options.responses ?? []);
  const documents = memoryDocuments([makeDoc()]);
  const jobs = createJobHubRegistry();
  const syncs: SyncResult[] = [];
  const { schedule, fire } = fakeScheduler();
  const wiring = createCollabWiring({
    config: () => config,
    documents: () => documents,
    jobs,
    onSync: (r) => {
      syncs.push(r);
    },
    exec,
    scheduler: schedule,
  });
  const router = createCollabRoutes({
    jobs,
    config: () => config,
    documents: () => documents,
    preflight: async () => OK_PREFLIGHT,
    bodies: wiring.bodies,
    authorize: TEST_ALLOW_ALL,
  });
  const call = (method: string, pathname: string, body: Record<string, unknown> = {}, sse?: SseSink): Promise<CollabRouteResult> =>
    router.handle({ method, pathname, query: {}, body, ...(sse ? { sse } : {}) });
  return { wiring, router, call, calls, endpoints, documents, syncs, fire, jobs };
}

/* ================================================================== *
 * The gap itself: an HTTP-shaped request reaches real `gh api` calls
 * ================================================================== */
describe('7.2 routes run 8.2 job bodies (integration)', () => {
  it('POST /start drives the real create sequence all the way to GitHub', async () => {
    const h = host({ responses: CREATE_OK });
    const res = await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'create' });
    await settled();

    // The endpoints are the assertion: before this wiring the route ran a throwing stub
    // and this list was empty.
    expect(h.endpoints()).toEqual([
      '/repos/acme/docs/git/ref/heads/main',
      '/repos/acme/docs/git/refs',
      '/repos/acme/docs/contents/documents/doc-1.json',
      '/repos/acme/docs/pulls',
    ]);
    expect(JSON.parse(h.calls[1]?.input ?? '{}')).toMatchObject({ ref: 'refs/heads/visual-spec/doc-1' });
    // …and the binding 8.2 persists is readable through the store the route handed it.
    expect(await readGitHubBinding(h.documents, 'doc-1')).toMatchObject({
      owner: 'acme',
      repo: 'docs',
      branch: 'visual-spec/doc-1',
      pullNumber: 42,
    });
  });

  it('POST /:id/sync reads the PR issue comments through the 5.1 projection', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();
    h.calls.length = 0;

    expect((await h.call('POST', '/doc-1/sync')).status).toBe(200);
    await settled();

    expect(h.endpoints()).toEqual(['/repos/acme/docs/issues/42/comments?per_page=100&page=1']);
    expect(h.syncs).toHaveLength(1);
    expect(h.syncs[0]).toMatchObject({ documentId: 'doc-1', pullNumber: 42, trigger: 'user' });
    // Projected, not raw — the ids and trailers come from comment-projection.
    expect(h.syncs[0]?.comments[0]?.collab).toEqual({ documentId: 'doc-1', nodeId: 'n-7' });
  });

  it('reports the create job as pr-open over SSE, not as a stub failure', async () => {
    const h = host({ responses: CREATE_OK });
    const s = sink();
    await h.call('GET', '/doc-1/events', {}, s);
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    expect(s.frames.map((f) => f.type)).not.toContain('job-error');
    expect(s.frames.find((f) => f.type === 'job-done')).toMatchObject({ ok: true, state: 'pr-open' });
    expect(s.frames.some((f) => f.type === 'log' && f.text.includes('pull request #42'))).toBe(true);
  });
});

/* ================================================================== *
 * The poller is host-owned, follows SSE subscribers, and stops on shutdown
 *
 * R-8.6 — polling exists to feed `sync` frames to attached subscribers, so it runs
 * exactly while a document has at least one. These are the guards on that rule: nobody
 * watching means nobody is paying GitHub's rate limit for the privilege.
 * ================================================================== */
describe('interval polling is wired by the host (R-8.6)', () => {
  it('does not poll a document nobody is watching, even a freshly created one', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    expect(h.wiring.pollingDocumentIds()).toEqual([]);

    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    // Create no longer starts the poller by itself. The document is PR-open, but no
    // browser is attached to it, so there is nothing for a sync frame to reach.
    expect(h.wiring.pollingDocumentIds()).toEqual([]);
    h.calls.length = 0;
    h.fire();
    await settled();
    expect(h.calls).toHaveLength(0);
  });

  it('starts on the first subscriber, syncs through the same body, and stops on shutdown', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    await h.call('GET', '/doc-1/events', {}, sink());
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);
    h.calls.length = 0;

    h.fire();
    await settled();
    expect(h.endpoints()).toEqual(['/repos/acme/docs/issues/42/comments?per_page=100&page=1']);
    expect(h.syncs.map((s) => s.trigger)).toEqual(['poll']);

    h.wiring.stopAllPolling();
    expect(h.wiring.pollingDocumentIds()).toEqual([]);
    h.calls.length = 0;
    h.fire();
    await settled();
    expect(h.calls).toHaveLength(0);
  });

  it('keeps polling while any subscriber remains, and stops only when the last one detaches', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    const first = sink();
    const second = sink();
    await h.call('GET', '/doc-1/events', {}, first);
    await h.call('GET', '/doc-1/events', {}, second);
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);

    // One of two tabs closes: someone is still watching, so the poller must survive.
    first.close();
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);

    second.close();
    expect(h.wiring.pollingDocumentIds()).toEqual([]);

    // …and the stop is real, not just bookkeeping: the interval no longer reaches GitHub.
    h.calls.length = 0;
    h.fire();
    await settled();
    expect(h.calls).toHaveLength(0);
  });

  it('resumes polling when a reviewer reopens a closed tab', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    const before = sink();
    await h.call('GET', '/doc-1/events', {}, before);
    before.close();
    expect(h.wiring.pollingDocumentIds()).toEqual([]);

    // Reattaching is the same call the reopened tab makes. Polling has to come back, and
    // it has to come back *working* — so the tick is fired and the GitHub read asserted,
    // not merely the id in `pollingDocumentIds`.
    await h.call('GET', '/doc-1/events', {}, sink());
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);

    h.calls.length = 0;
    h.fire();
    await settled();
    expect(h.endpoints()).toEqual(['/repos/acme/docs/issues/42/comments?per_page=100&page=1']);
    expect(h.syncs.map((s) => s.trigger)).toEqual(['poll']);
  });

  it('ignores a repeated close for a sink already gone, so a live subscriber keeps its poller', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    const leaver = sink();
    await h.call('GET', '/doc-1/events', {}, leaver);
    await h.call('GET', '/doc-1/events', {}, sink());

    leaver.close();
    leaver.close();

    // The second `close` must not be mistaken for the *other* subscriber leaving.
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);
  });

  it('leaves no poller behind when the document is disposed', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();

    await h.call('GET', '/doc-1/events', {}, sink());
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1']);

    // `dispose` ends every sink itself; their transport `close` handlers never run, so
    // the drop to zero has to be announced by the hub or the poller outlives the document.
    h.jobs.dispose('doc-1');
    expect(h.wiring.pollingDocumentIds()).toEqual([]);
    h.calls.length = 0;
    h.fire();
    await settled();
    expect(h.calls).toHaveLength(0);
  });

  it('keys polling per document, so one document detaching does not stop another', async () => {
    // Attaching is the whole trigger, so this needs no create and touches no GitHub —
    // which is the point: the two pollers are keyed on `documentId` and nothing else.
    const h = host({ responses: [] });
    const one = sink();
    await h.call('GET', '/doc-1/events', {}, one);
    await h.call('GET', '/doc-2/events', {}, sink());
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-1', 'doc-2']);

    one.close();
    expect(h.wiring.pollingDocumentIds()).toEqual(['doc-2']);
  });
});

/* ================================================================== *
 * A body that cannot do its work fails loudly — it never reports success.
 *
 * This described the stubs while 8.3 (publish) and 11.1 (open) were unbuilt. Both are
 * wired now, so what is left is the same property for a *real* body handed a document
 * it cannot act on: `publish` on a document with no PR branch. `open` moved to
 * `collab-open.test.ts`, where its failures are asserted by cause (R-11.4).
 * ================================================================== */
describe('a body that cannot do its work fails loudly', () => {
  for (const [what, method, path, body] of [
    ['publish (task 8.3)', 'POST', '/doc-1/publish', { markdown: '# x' }],
  ] as const) {
    it(`${what} fails loudly and touches no GitHub endpoint`, async () => {
      const h = host({ responses: CREATE_OK });
      const s = sink();
      await h.call('GET', '/doc-1/events', {}, s);
      expect((await h.call(method, path, body)).status).toBe(200);
      await settled();

      expect(s.frames.map((f) => f.type)).toContain('job-error');
      expect(s.frames.find((f) => f.type === 'job-done')).toMatchObject({ ok: false });
      expect(h.calls).toHaveLength(0);
    });
  }
});

/* ================================================================== *
 * R-9.19 — no configuration, nothing GitHub-touching is constructed
 * ================================================================== */
describe('R-9.19 — collaboration unconfigured builds no adapter at all', () => {
  it('yields no bodies, no poller and never reaches the executor', async () => {
    const exec = vi.fn<GhExecutor>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const documents = memoryDocuments([makeDoc()]);
    const jobs = createJobHubRegistry();
    const wiring = createCollabWiring({ config: () => DISABLED, documents: () => documents, jobs, exec });

    // No `create` / `sync` factory exists, so nothing could have built an adapter to
    // close over — 7.2's stubs are what the router ends up with.
    expect(Object.keys(wiring.bodies)).toEqual([]);
    expect(wiring.pollingDocumentIds()).toEqual([]);

    const router = createCollabRoutes({ jobs, config: () => DISABLED, documents: () => documents, bodies: wiring.bodies, authorize: TEST_ALLOW_ALL });
    expect((await router.handle({ method: 'GET', pathname: '', query: {}, body: {} })).json).toMatchObject({
      available: false,
      reason: 'not-configured',
    });
    const res = await router.handle({
      method: 'POST',
      pathname: '/start',
      query: {},
      body: { documentId: 'doc-1', documentPath: 'documents/doc-1.json' },
    });
    expect(res.status).toBe(503);
    await settled();
    expect(exec).not.toHaveBeenCalled();
    wiring.stopAllPolling(); // a no-op, and safe to call on shutdown regardless
  });
});

/**
 * Seam guard (task 2.2): `withNodeIdentity` is a decorator, and 2.2 landed it
 * opt-in with no caller — so backfill and version bumping silently did not run.
 * Both hosts must decorate the store they hand to the collaboration routes.
 */
describe('both hosts hand the collab layer the same undecorated store', () => {
  const hostSource = (rel: string): string => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, rel), 'utf8');
  };

  for (const [label, rel] of [
    ['src/server.ts', '../../../src/server.ts'],
    ['core/vite/md-plugin.ts', '../md-plugin.ts'],
  ] as const) {
    it(`${label} hands the collab layer the store undecorated`, () => {
      const src = hostSource(rel);
      // The decorator this used to require was `withNodeIdentity`, which backfilled and
      // versioned `nodeId`s on every read. Identity is retired with the JSON format
      // (Unit 2), so a decorator here would be a layer with nothing to do — and the one
      // thing it must not become is a place where a second representation of the document
      // grows back. Both hosts therefore pass `fsCollaborationStore` straight through.
      expect(src).not.toContain('withNodeIdentity');
      expect(src).toMatch(/documents:\s*\(\)\s*=>\s*fsCollaborationStore\(/);
    });
  }
});

/* ================================================================== *
 * Task 8.3 — `publish` is wired, so the route no longer runs a stub
 * ================================================================== */
describe('7.2 routes run the 8.3 publish body (integration)', () => {
  /**
   * A stateful replay of the two Contents API endpoints publish uses, so the read-back
   * verification sees the bytes the write actually stored. The positional `recorder`
   * above cannot do that — verification compares against content it does not know yet.
   */
  function contentsReplay(seed: Record<string, string> = {}) {
    const files = new Map(Object.entries(seed));
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec: GhExecutor = async (args, input) => {
      calls.push(input === undefined ? { args } : { args, input });
      const endpoint = endpointOf(args);
      const method = args[args.indexOf('--method') + 1];
      const hit = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+?)(?:\?ref=.+)?$/.exec(endpoint);
      const ok = (json: unknown): GhResult => ({ stdout: JSON.stringify(json), stderr: '', exitCode: 0 });
      if (!hit) return { stdout: JSON.stringify({ message: 'Not Found', status: '404' }), stderr: '', exitCode: 1 };
      const path = hit[1] as string;
      if (method === 'PUT') {
        const written = Buffer.from((JSON.parse(input ?? '{}') as { content: string }).content, 'base64').toString('utf8');
        files.set(path, written);
        return ok({ content: { path, sha: gitBlobSha(written) }, commit: { sha: 'c0ffee' } });
      }
      const stored = files.get(path);
      if (stored === undefined) return { stdout: JSON.stringify({ message: 'Not Found', status: '404' }), stderr: '', exitCode: 1 };
      return ok({ path, sha: gitBlobSha(stored), content: Buffer.from(stored, 'utf8').toString('base64') });
    };
    return { exec, calls, files };
  }

  it('POST /:id/publish commits the payload to the branch and verifies it, with no merge', async () => {
    const doc: CollaborationRecord & { github: Record<string, unknown> } = {
      // Markdown is the document (LLD §2): publish writes the document's own path.
      ...makeDoc({ documentPath: 'documents/doc-1.md' }),
      github: { owner: 'acme', repo: 'docs', branch: 'visual-spec/doc-1', pullNumber: 42, resolved: false },
    };
    const documents = memoryDocuments([doc]);
    const jobs = createJobHubRegistry();
    const gh = contentsReplay({ 'documents/doc-1.md': '# stale\n' });
    const wiring = createCollabWiring({ config: () => ENABLED, documents: () => documents, jobs, exec: gh.exec });

    // The wiring supplies it now — before task 8.3 this key was absent and 7.2's
    // throwing `notImplemented` stub served the route. `merge` stays absent by
    // design: SC-1 ends at "published to the branch"; merging happens on github.com.
    expect(Object.keys(wiring.bodies).sort()).toEqual(['create', 'markReady', 'open', 'publish', 'reconcile', 'sync']);

    const router = createCollabRoutes({
      jobs,
      config: () => ENABLED,
      documents: () => documents,
      preflight: async () => OK_PREFLIGHT,
      bodies: wiring.bodies,
      authorize: TEST_ALLOW_ALL,
    });
    const s = sink();
    jobs.hub('doc-1').subscribe(s);
    const res = await router.handle({
      method: 'POST',
      pathname: '/doc-1/publish',
      query: {},
      body: { markdown: '# Onboarding guide\n' },
    });
    expect(res.status).toBe(200);
    await settled();

    // One artifact (LLD §7): read-before-write, commit, read-back to verify.
    expect(gh.calls.map((c) => endpointOf(c.args))).toEqual([
      '/repos/acme/docs/contents/documents/doc-1.md?ref=visual-spec/doc-1',
      '/repos/acme/docs/contents/documents/doc-1.md',
      '/repos/acme/docs/contents/documents/doc-1.md?ref=visual-spec/doc-1',
    ]);
    expect(gh.files.get('documents/doc-1.md')).toBe('# Onboarding guide\n');
    expect(jobs.hub('doc-1').snapshot().state).toBe('published');
    // R-8.10 — publish stops at `published`; merge happens on github.com.
    expect(gh.calls.some((c) => endpointOf(c.args).includes('/merge'))).toBe(false);
    expect(s.frames.find((f) => f.type === 'job-done')).toMatchObject({ ok: true, state: 'published' });
  });
});
