import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseCommentBody } from './comment-projection';
import type { CollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import { resolveNodeIn } from './document-store';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor, GhResult } from './github-executor';
import { type JobEvent, createJobHubRegistry } from './job-hub';
import {
  DEFAULT_SYNC_INTERVAL_MS,
  type IntervalScheduler,
  type Lifecycle,
  type SyncResult,
  type SyncTrigger,
  branchNameFor,
  buildPullRequestBody,
  createLifecycle,
  openCommandFor,
  documentContentSha,
  readGitHubBinding,
} from './lifecycle';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf8');

const repo = { owner: 'acme', repo: 'docs', baseBranch: 'main' };

type Call = { args: string[]; input?: string };

/** Recorded-response executor, same shape as `github-adapter.test.ts` (R-4.8 / R-12.3). */
function recorder(responses: Array<Partial<GhResult>>): { exec: GhExecutor; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const r = responses[i++] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 'exitCode' in r ? (r.exitCode as number | null) : 0 };
  };
  return { exec, calls };
}

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;

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

/** In-memory `DocumentStore`. Writes are recorded so "what sync writes" is observable. */
function memoryStore(seed?: CollaborationDocument) {
  const docs = new Map<string, CollaborationDocument>();
  if (seed) docs.set(seed.documentId, seed);
  const writes: CollaborationDocument[] = [];
  const store: DocumentStore = {
    async read(id) {
      return docs.get(id) ?? null;
    },
    async write(doc) {
      writes.push(JSON.parse(JSON.stringify(doc)) as CollaborationDocument);
      docs.set(doc.documentId, doc);
    },
    async list() {
      return [...docs.keys()].sort();
    },
    async resolveNode(id, nodeId) {
      const doc = docs.get(id);
      return doc ? resolveNodeIn(doc, nodeId) : { found: false };
    },
  };
  return { store, writes };
}

/** A hand-driven interval scheduler — no real timer is created anywhere in this file. */
function fakeScheduler() {
  const ticks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule: IntervalScheduler = (fn, ms) => {
    const entry = { fn, ms, cancelled: false };
    ticks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const fire = () => {
    for (const t of ticks) if (!t.cancelled) t.fn();
  };
  return { schedule, ticks, fire };
}

type Harness = {
  lifecycle: Lifecycle;
  calls: Call[];
  writes: CollaborationDocument[];
  store: DocumentStore;
  events: JobEvent[];
  syncs: SyncResult[];
  fire: () => void;
  ticks: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
};

function harness(responses: Array<Partial<GhResult>>, seed?: CollaborationDocument | null): Harness {
  const { exec, calls } = recorder(responses);
  const { store, writes } = memoryStore(seed === null ? undefined : (seed ?? makeDoc()));
  const hubs = createJobHubRegistry({ now: () => 1_700_000_000_000 });
  const events: JobEvent[] = [];
  hubs.hub('doc-1').subscribe({
    writeHead: () => undefined,
    write: (chunk: string) => {
      // The first frame every subscriber gets is the `sync` snapshot; keep only events.
      const frame = JSON.parse(chunk.replace(/^data: /, '')) as { type: string };
      if (frame.type !== 'sync') events.push(frame as JobEvent);
    },
    on: () => undefined,
  });
  const syncs: SyncResult[] = [];
  const { schedule, ticks, fire } = fakeScheduler();
  const lifecycle = createLifecycle({
    adapter: createGitHubAdapter(exec),
    repo,
    store,
    hubs,
    onSync: (r) => {
      syncs.push(r);
    },
    scheduler: schedule,
  });
  return { lifecycle, calls, writes, store, events, syncs, fire, ticks };
}

/** Wait for the in-flight job body — the hub starts bodies synchronously and settles async. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const CREATE_OK: Array<Partial<GhResult>> = [
  { stdout: fixture('git-ref.json') }, // getBranch(main)
  { stdout: fixture('create-ref.json') }, // createBranch
  { stdout: fixture('contents-put.json') }, // commitFile
  { stdout: fixture('pull-create.json') }, // createPullRequest
];

const LIST_COMMENTS: Partial<GhResult> = { stdout: fixture('projection-comments.json') };

// ---------------------------------------------------------------------------
// R-8.5 — start creates branch, commits JSON, opens the PR
// ---------------------------------------------------------------------------

describe('createLifecycle.start (R-8.5)', () => {
  it('creates the branch, commits the canonical JSON and opens the pull request, in order', async () => {
    const h = harness(CREATE_OK);
    expect(h.lifecycle.start({ documentId: 'doc-1' })).toEqual({
      status: 200,
      json: { ok: true, jobId: 'doc-1-1', kind: 'create' },
    });
    await settled();

    expect(h.calls.map((c) => endpointOf(c.args))).toEqual([
      '/repos/acme/docs/git/ref/heads/main',
      '/repos/acme/docs/git/refs',
      '/repos/acme/docs/contents/documents/doc-1.json',
      '/repos/acme/docs/pulls',
    ]);
    // Contents API, never a git subprocess.
    expect(h.calls[2]?.args).toContain('PUT');
    expect(JSON.parse(h.calls[1]?.input ?? '{}')).toEqual({
      ref: 'refs/heads/visual-spec/doc-1',
      sha: '5f2a1c9b8d4e6f0a1b2c3d4e5f60718293a4b5c6',
    });
  });

  it('makes pullNumber and headSha available to the caller through the document store', async () => {
    const h = harness(CREATE_OK);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();

    expect(await readGitHubBinding(h.store, 'doc-1')).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: 'visual-spec/doc-1',
      pullNumber: 42,
      headSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      resolved: false,
      // R-11.6 — create commits the document it just wrote, so local and branch agree here.
      contentSha: documentContentSha((await h.store.read('doc-1')) as CollaborationDocument),
    });
  });

  it('transitions Draft -> PROpen and reports the PR on the event stream', async () => {
    const h = harness(CREATE_OK);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();

    expect(h.events.filter((e) => e.type === 'state')).toEqual([
      { type: 'state', jobId: 'doc-1-1', state: 'pr-open', at: 1_700_000_000_000 },
    ]);
    expect(h.events.some((e) => e.type === 'log' && e.text.includes('pull request #42'))).toBe(true);
    const done = h.events.find((e) => e.type === 'job-done');
    expect(done).toMatchObject({ ok: true, state: 'pr-open', kind: 'create' });
  });

  it('commits the serialized envelope byte-for-byte, not a re-derived form', async () => {
    const doc = makeDoc();
    const h = harness(CREATE_OK, doc);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();

    const body = JSON.parse(h.calls[2]?.input ?? '{}') as { content: string; branch: string; message: string };
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    expect(body.branch).toBe('visual-spec/doc-1');
  });

  it('carries the idempotency key to the hub for task 8.4 (R-8.23)', async () => {
    const h = harness(CREATE_OK);
    h.lifecycle.start({ documentId: 'doc-1', idempotencyKey: 'k-1' });
    await settled();
    expect(h.events[0]).toMatchObject({ type: 'job-start', idempotencyKey: 'k-1' });
  });

  it('fails the job when the document does not exist', async () => {
    const h = harness(CREATE_OK, null);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();
    expect(h.events.find((e) => e.type === 'job-error')).toMatchObject({
      message: 'no collaboration document: doc-1',
    });
    expect(h.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Partial create failure — what is left behind for task 8.4 (R-8.18)
// ---------------------------------------------------------------------------

describe('createLifecycle.start — partial failure (leaves 8.4 a tractable orphan)', () => {
  it('leaves a binding naming the branch with no pullNumber when PR creation fails', async () => {
    const h = harness([
      { stdout: fixture('git-ref.json') },
      { stdout: fixture('create-ref.json') },
      { stdout: fixture('contents-put.json') },
      { stdout: '{"message":"Validation Failed"}', stderr: 'gh: Validation Failed (HTTP 422)', exitCode: 1 },
    ]);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();

    const binding = await readGitHubBinding(h.store, 'doc-1');
    expect(binding).toEqual({ owner: 'acme', repo: 'docs', branch: 'visual-spec/doc-1', resolved: false });
    expect(binding?.pullNumber).toBeUndefined();
    expect(h.events.find((e) => e.type === 'job-error')).toBeDefined();
    expect(h.events.find((e) => e.type === 'job-done')).toMatchObject({ ok: false, state: 'failed' });
    // The name is deterministic too, so cleanup does not depend on the write landing.
    expect(branchNameFor('doc-1')).toBe('visual-spec/doc-1');
  });

  it('writes no binding at all when branch creation itself fails', async () => {
    const h = harness([
      { stdout: fixture('git-ref.json') },
      { stdout: fixture('error-ref-exists.json'), stderr: 'gh: Reference already exists (HTTP 422)', exitCode: 1 },
    ]);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();

    expect(await readGitHubBinding(h.store, 'doc-1')).toBeNull();
    expect(h.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R-11.1 — the PR body
// ---------------------------------------------------------------------------

describe('buildPullRequestBody (R-11.1)', () => {
  const body = buildPullRequestBody({
    repo: { owner: 'acme', repo: 'docs' },
    branch: 'visual-spec/doc-1',
    documentId: 'doc-1',
    documentPath: 'documents/doc-1.json',
    title: 'Onboarding guide',
  });

  it('identifies the repository, the branch and the document for a human reader', () => {
    expect(body).toContain('`acme/docs`');
    expect(body).toContain('`visual-spec/doc-1`');
    expect(body).toContain('`documents/doc-1.json` (id `doc-1`)');
    expect(body).toContain('**Onboarding guide**');
  });

  it('carries the command a reviewer runs to open it in their own instance', () => {
    expect(body).toContain(openCommandFor({ owner: 'acme', repo: 'docs' }, 'visual-spec/doc-1', 'doc-1'));
    expect(body).toContain(
      'npx @metuur/visual-spec collab open --repo acme/docs --branch visual-spec/doc-1 --document doc-1',
    );
  });

  it('is machine-parseable by the shared trailer parser, so 11.1 needs no second format', () => {
    const parsed = parseCommentBody(body);
    expect(parsed.trailer).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: 'visual-spec/doc-1',
      documentId: 'doc-1',
      documentPath: 'documents/doc-1.json',
    });
    // The prose survives the split, so a human on github.com still reads the body.
    expect(parsed.text).toContain('Open it in your own visual-spec instance:');
  });

  it('is the body actually sent to GitHub when the PR is opened', async () => {
    const h = harness(CREATE_OK);
    h.lifecycle.start({ documentId: 'doc-1' });
    await settled();
    const sent = JSON.parse(h.calls[3]?.input ?? '{}') as { body: string; head: string; base: string; title: string };
    expect(sent).toMatchObject({ head: 'visual-spec/doc-1', base: 'main', title: 'Onboarding guide' });
    expect(parseCommentBody(sent.body).trailer?.documentId).toBe('doc-1');
  });
});

// ---------------------------------------------------------------------------
// R-8.6 / R-8.7 / R-8.8 — sync
// ---------------------------------------------------------------------------

const bound = () =>
  makeDoc({
    github: { owner: 'acme', repo: 'docs', branch: 'visual-spec/doc-1', pullNumber: 42, headSha: 'abc', resolved: false },
  });

describe('createLifecycle.sync (R-8.6)', () => {
  it('reads the PR issue comments through the 5.1 projection and reports them', async () => {
    const h = harness([LIST_COMMENTS], bound());
    expect(h.lifecycle.sync('doc-1', 'user').status).toBe(200);
    await settled();

    expect(endpointOf(h.calls[0]?.args ?? [])).toBe('/repos/acme/docs/issues/42/comments?per_page=100&page=1');
    expect(h.syncs).toHaveLength(1);
    expect(h.syncs[0]).toMatchObject({ documentId: 'doc-1', pullNumber: 42, trigger: 'user' });
    // Projected, not raw: ids and trailers come from comment-projection.
    expect(h.syncs[0]?.comments.map((c) => c.id)).toEqual(['c-000aae61', 'c-000aae62', 'c-000aae63', 'c-000aae64']);
    expect(h.syncs[0]?.comments[0]?.collab).toEqual({ documentId: 'doc-1', nodeId: 'n-7' });
  });

  it('writes nothing to the document store — it cannot clobber state it did not fetch', async () => {
    const h = harness([LIST_COMMENTS], bound());
    h.lifecycle.sync('doc-1', 'user');
    await settled();

    expect(h.writes).toEqual([]);
    const after = await h.store.read('doc-1');
    expect(after).toEqual(bound());
  });

  it('fails when the document has no open pull request', async () => {
    const h = harness([LIST_COMMENTS]); // seeded document, no binding
    h.lifecycle.sync('doc-1', 'user');
    await settled();
    expect(h.events.find((e) => e.type === 'job-error')).toMatchObject({ message: 'no open pull request for doc-1' });
    expect(h.calls).toHaveLength(0);
  });

  it('runs as a hub job, so a late subscriber recovers the result (R-8.2 / R-8.4)', async () => {
    const h = harness([LIST_COMMENTS], bound());
    h.lifecycle.sync('doc-1', 'poll');
    await settled();
    expect(h.events.some((e) => e.type === 'log' && e.text.includes('4 comment(s) on #42'))).toBe(true);
  });
});

describe('sync routing — one entrypoint for every trigger (R-8.7)', () => {
  it('the interval poller and the user-initiated action call the SAME function', async () => {
    const h = harness([LIST_COMMENTS, LIST_COMMENTS], bound());
    // Spy on the public entrypoint. The poller dereferences it at tick time, so if it
    // held a private copy of the sync path this spy would see only the user call.
    const spy = vi.spyOn(h.lifecycle, 'sync');

    h.lifecycle.sync('doc-1', 'user'); // what POST /__vs/collab/:id/sync does
    await settled();
    h.lifecycle.startPolling('doc-1');
    h.fire(); // what the interval does
    await settled();

    expect(spy.mock.calls).toEqual([
      ['doc-1', 'user'],
      ['doc-1', 'poll'],
    ]);
    // Both landed on the same implementation: same endpoint, same projected result.
    expect(h.calls.map((c) => endpointOf(c.args))).toEqual([
      '/repos/acme/docs/issues/42/comments?per_page=100&page=1',
      '/repos/acme/docs/issues/42/comments?per_page=100&page=1',
    ]);
    expect(h.syncs.map((s) => s.trigger)).toEqual(['user', 'poll']);
    const [first, second] = h.syncs;
    expect(second?.comments).toEqual(first?.comments);
  });

  it('accepts a webhook trigger through the same entrypoint, unchanged (R-8.7)', async () => {
    const h = harness([LIST_COMMENTS], bound());
    const trigger: SyncTrigger = 'webhook';
    h.lifecycle.sync('doc-1', trigger);
    await settled();
    expect(h.syncs[0]?.trigger).toBe('webhook');
  });
});

describe('interval polling (R-8.6 / R-8.8)', () => {
  it('is in-process on an injected timer — no webhook receiver or endpoint is involved', () => {
    const h = harness([], bound());
    h.lifecycle.startPolling('doc-1');
    expect(h.ticks).toHaveLength(1);
    expect(h.ticks[0]?.ms).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(h.lifecycle.pollingDocumentIds()).toEqual(['doc-1']);
  });

  it('is idempotent per document and stops on request', () => {
    const h = harness([], bound());
    h.lifecycle.startPolling('doc-1');
    h.lifecycle.startPolling('doc-1');
    expect(h.ticks).toHaveLength(1);

    h.lifecycle.stopPolling('doc-1');
    expect(h.ticks[0]?.cancelled).toBe(true);
    expect(h.lifecycle.pollingDocumentIds()).toEqual([]);

    h.lifecycle.startPolling('doc-1');
    h.lifecycle.stopAllPolling();
    expect(h.lifecycle.pollingDocumentIds()).toEqual([]);
  });

  it('does not pile up when a poll outlives the interval — the hub refuses the overlap', async () => {
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    const exec: GhExecutor = async () => {
      listCalls += 1;
      await slow;
      return { stdout: fixture('projection-comments.json'), stderr: '', exitCode: 0 };
    };
    const { store } = memoryStore(bound());
    const hubs = createJobHubRegistry();
    const { schedule, fire } = fakeScheduler();
    const syncs: SyncResult[] = [];
    const lifecycle = createLifecycle({
      adapter: createGitHubAdapter(exec),
      repo,
      store,
      hubs,
      onSync: (r) => {
        syncs.push(r);
      },
      scheduler: schedule,
      syncIntervalMs: 5,
    });

    lifecycle.startPolling('doc-1');
    fire();
    await settled();
    fire(); // second tick while the first poll is still in flight
    fire();
    await settled();
    expect(listCalls).toBe(1);
    expect(hubs.hub('doc-1').snapshot().running).toBe(true);

    release?.();
    await settled();
    expect(syncs).toHaveLength(1);
    expect(hubs.hub('doc-1').snapshot().running).toBe(false);

    // Once it finishes, the next tick runs normally — the overlap was dropped, not queued.
    fire();
    await settled();
    expect(listCalls).toBe(2);
    lifecycle.stopAllPolling();
  });
});
