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
import type { CollaborationDocument } from '../../collaboration/document-protocol';
import type { DocumentStore } from '../../collaboration/document-store';
import type { GhExecutor, GhResult } from '../../collaboration/github-executor';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import type { JobEvent, JobSync, SseSink } from '../../collaboration/job-hub';
import type { IntervalScheduler, SyncResult } from '../../collaboration/lifecycle';
import { readGitHubBinding } from '../../collaboration/lifecycle';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabRouteResult, createCollabRoutes } from './collab';
import { createCollabWiring } from './collab-wiring';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../collaboration/fixtures');
const fixture = (name: string): string => readFileSync(resolve(fixturesDir, name), 'utf8');

const REPO = { owner: 'acme', repo: 'docs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO } };
const DISABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: null };

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

function makeDoc(overrides: Partial<CollaborationDocument> = {}): CollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'documents/doc-1.json',
    title: 'Onboarding guide',
    frontmatter: {},
    nodes: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }],
    doc: { root: { children: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }] } },
    ...overrides,
  };
}

function memoryDocuments(seed: CollaborationDocument[]): DocumentStore {
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
    async resolveNode() {
      return { found: false };
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
  const s: SseSink = {
    writeHead() {},
    write(chunk: string) {
      frames.push(JSON.parse(chunk.replace(/^data: /, '').trim()));
    },
    on() {},
    end() {},
    writableEnded: false,
  };
  return Object.assign(s, { frames });
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
  });
  const call = (method: string, pathname: string, body: Record<string, unknown> = {}, sse?: SseSink): Promise<CollabRouteResult> =>
    router.handle({ method, pathname, query: {}, body, ...(sse ? { sse } : {}) });
  return { wiring, router, call, calls, endpoints, documents, syncs, fire };
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
 * The poller is host-owned and stops on shutdown
 * ================================================================== */
describe('interval polling is wired by the host (R-8.6)', () => {
  it('starts once the document is PR-open, syncs through the same body, and stops on shutdown', async () => {
    const h = host({ responses: [...CREATE_OK, LIST_COMMENTS] });
    expect(h.wiring.pollingDocumentIds()).toEqual([]);

    await h.call('POST', '/start', { documentId: 'doc-1', documentPath: 'documents/doc-1.json' });
    await settled();
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
});

/* ================================================================== *
 * What is still stubbed — 8.3 (publish) and 11.x (open)
 * ================================================================== */
describe('the bodies 8.2 does not own stay honestly stubbed', () => {
  for (const [what, method, path, body] of [
    ['publish (task 8.3)', 'POST', '/doc-1/publish', { json: { root: {} }, markdown: '# x' }],
    ['open (task 11.x)', 'POST', '/open', { documentId: 'doc-1', pullNumber: 42 }],
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

    const router = createCollabRoutes({ jobs, config: () => DISABLED, documents: () => documents, bodies: wiring.bodies });
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
describe('both hosts decorate the document store with withNodeIdentity (task 2.2 seam)', () => {
  const hostSource = (rel: string): string => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, rel), 'utf8');
  };

  for (const [label, rel] of [
    ['src/server.ts', '../../../src/server.ts'],
    ['core/vite/md-plugin.ts', '../md-plugin.ts'],
  ] as const) {
    it(`${label} wraps fsDocumentStore in withNodeIdentity`, () => {
      const src = hostSource(rel);
      expect(src).toContain('withNodeIdentity');
      // Every store handed to the collab layer must be decorated — a bare
      // fsDocumentStore(...) reaching `documents:` is the regression.
      expect(src).not.toMatch(/documents:\s*\(\)\s*=>\s*fsDocumentStore\(/);
      expect(src).toMatch(/documents:\s*\(\)\s*=>\s*withNodeIdentity\(fsDocumentStore\(/);
    });
  }
});
