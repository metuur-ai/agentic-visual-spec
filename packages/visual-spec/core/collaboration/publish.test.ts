/**
 * publish.test.ts — R-8.9 … R-8.14, R-12.4, R-12.7.
 *
 * Everything runs against a **replayed Contents API**: `fakeGh` below answers
 * `GET/PUT /repos/:o/:r/contents/:path` out of an in-memory branch and records every
 * argv, so the tests assert on the exact `gh api` calls that come out the far end
 * (R-4.8 / R-12.3). No network, no real `gh`, no timer.
 *
 * The load-bearing negatives are asserted directly, because they are properties of what
 * the code *does not* do and no positive test can imply them:
 *   - no merge endpoint is ever reached (R-8.10, LLD §7);
 *   - no git subprocess is ever spawned — every call is `gh api` (LLD §7 / Constraints);
 *   - the client's Markdown is never touched (R-8.12).
 */
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationDocument } from './document-protocol';
import type { DocumentStore } from './document-store';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor, GhResult } from './github-executor';
import { type JobEvent, type LifecycleState, type SseSink, createJobHubRegistry } from './job-hub';
import type { BoundCollaborationDocument } from './lifecycle';
import { PublishVerificationError, createPublishBody, gitBlobSha, markdownPathFor } from './publish';

const repo = { owner: 'acme', repo: 'docs', baseBranch: 'main' };
const BRANCH = 'visual-spec/doc-1';

const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;
const methodOf = (args: string[]): string => args[args.indexOf('--method') + 1] as string;

type Call = { args: string[]; input?: string };

type FakeOptions = {
  /** Seed the branch. Keyed by repo-relative path. */
  files?: Record<string, string>;
  /** Corrupt what the branch hands back on a *read*, per path. Simulates a bad blob. */
  corruptOnRead?: (path: string, content: string) => string | null;
  /** Override the `contentSha` the PUT response echoes. Proves we do not rely on it. */
  echoContentSha?: string;
};

/**
 * A replayed Contents API over one branch. Only the two endpoints publish uses are
 * implemented; anything else answers 404 and is still recorded, so a stray call (a
 * merge, say) shows up in `calls` rather than silently succeeding.
 */
function fakeGh(options: FakeOptions = {}): { exec: GhExecutor; calls: Call[]; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const calls: Call[] = [];

  const ok = (json: unknown): GhResult => ({ stdout: JSON.stringify(json), stderr: '', exitCode: 0 });
  const notFound = (): GhResult => ({ stdout: JSON.stringify({ message: 'Not Found', status: '404' }), stderr: '', exitCode: 1 });

  const exec: GhExecutor = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const endpoint = endpointOf(args);
    const method = methodOf(args);
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+?)(?:\?ref=(.+))?$/.exec(endpoint);
    if (!contents) return notFound();
    const path = contents[1] as string;

    if (method === 'GET') {
      const stored = files.get(path);
      if (stored === undefined) return notFound();
      const served = options.corruptOnRead ? options.corruptOnRead(path, stored) : stored;
      if (served === null) return notFound();
      return ok({ path, sha: gitBlobSha(served), content: Buffer.from(served, 'utf8').toString('base64') });
    }

    if (method === 'PUT') {
      const body = JSON.parse(input ?? '{}') as { content: string };
      const written = Buffer.from(body.content, 'base64').toString('utf8');
      files.set(path, written);
      return ok({
        content: { path, sha: options.echoContentSha ?? gitBlobSha(written) },
        commit: { sha: 'c0ffee' },
      });
    }

    return notFound();
  };

  return { exec, calls, files };
}

function makeDoc(overrides: Partial<BoundCollaborationDocument> = {}): BoundCollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'documents/doc-1.json',
    title: 'Onboarding guide',
    frontmatter: {},
    nodes: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }],
    doc: { root: { children: [{ id: 'n-7', type: 'paragraph', version: 1, content: 'hello' }] } },
    github: { owner: repo.owner, repo: repo.repo, branch: BRANCH, pullNumber: 42, headSha: 'abc123', resolved: false },
    ...overrides,
  };
}

/** A store that must not be needed when the route already supplied the document. */
function memoryStore(seed?: CollaborationDocument): DocumentStore & { reads: string[] } {
  const docs = new Map<string, CollaborationDocument>();
  if (seed) docs.set(seed.documentId, seed);
  const reads: string[] = [];
  return {
    reads,
    async read(id) {
      reads.push(id);
      return docs.get(id) ?? null;
    },
    async write(doc) {
      docs.set(doc.documentId, doc);
    },
    async list() {
      return [...docs.keys()].sort();
    },
    async resolveNode() {
      return { found: false };
    },
  };
}

/** Run a publish body directly, outside a hub, capturing states and logs. */
async function runBody(
  body: ReturnType<ReturnType<typeof createPublishBody>>,
  overrides: { signal?: AbortSignal } = {},
): Promise<{ states: LifecycleState[]; logs: string[] }> {
  const states: LifecycleState[] = [];
  const logs: string[] = [];
  await body({
    documentId: 'doc-1',
    jobId: 'doc-1-1',
    kind: 'publish',
    signal: overrides.signal ?? new AbortController().signal,
    log: (text) => logs.push(text),
    setState: (s) => states.push(s),
    now: () => 1_700_000_000_000,
  });
  return { states, logs };
}

const MARKDOWN = '# Onboarding guide\n\nhello\n';

/** The default happy-path rig: a document already on the branch, publish ready to run. */
function rig(options: FakeOptions = {}, inputOverrides: Record<string, unknown> = {}) {
  const doc = makeDoc();
  const gh = fakeGh({
    files: { [doc.documentPath]: '{"documentId":"doc-1"}\n', ...(options.files ?? {}) },
    ...options,
  });
  const publish = createPublishBody({ adapter: createGitHubAdapter(gh.exec) });
  const store = memoryStore(doc);
  const body = publish({
    documentId: 'doc-1',
    repo,
    store,
    document: doc,
    json: doc.doc,
    markdown: MARKDOWN,
    ...inputOverrides,
  });
  return { gh, body, doc, store };
}

/* ------------------------------------------------------------------ *
 * R-8.11 — the blob hash, computed server-side from the received bytes
 * ------------------------------------------------------------------ */

describe('R-8.11 — gitBlobSha', () => {
  it('matches git for the empty blob', () => {
    // The single most-quoted git constant: `git hash-object -t blob /dev/null`.
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('matches `printf "hello world\\n" | git hash-object --stdin`', () => {
    expect(gitBlobSha('hello world\n')).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
  });

  it('lengths the header in bytes, not UTF-16 code units', () => {
    // 'héllo\n' is 6 code units but 7 bytes; git agrees on 5fb50d3c….
    expect('héllo\n'.length).toBe(6);
    expect(Buffer.byteLength('héllo\n', 'utf8')).toBe(7);
    expect(gitBlobSha('héllo\n')).toBe('5fb50d3c93474f139362304b663fe44e9d17a26e');
  });

  it('there is no client-supplied hash in the payload to trust', async () => {
    // A client that sends its own `sha` cannot influence the outcome: verification uses
    // `gitBlobSha` over the bytes, and the extra key is not read anywhere.
    const { gh, body } = rig({}, { sha: 'deadbeef', blobSha: 'deadbeef' });
    await expect(runBody(body)).resolves.toBeTruthy();
    expect(gh.calls.some((c) => JSON.stringify(c).includes('deadbeef'))).toBe(false);
  });

  it('verification passes even when GitHub echoes a wrong contentSha on the write', async () => {
    // Correctness depends on the read-back and the locally computed hash, never on the
    // hash the write response carried.
    const { body } = rig({ echoContentSha: 'not-a-real-sha' });
    const { states } = await runBody(body);
    expect(states).toEqual(['publishing', 'verifying', 'published']);
  });
});

/* ------------------------------------------------------------------ *
 * R-8.10 — commit, verify, and do NOT merge
 * ------------------------------------------------------------------ */

describe('R-8.10 — commit then verify', () => {
  it('commits both artifacts to the PR branch and verifies each by reading it back', async () => {
    const { gh, body, doc } = rig();
    await runBody(body);

    // O-2 — after verification, publish also ensures `.gitattributes` on the same
    // branch (see the "O-2" describe block below); that PUT/GET is the third entry.
    const puts = gh.calls.filter((c) => methodOf(c.args) === 'PUT').map((c) => endpointOf(c.args));
    expect(puts).toEqual([
      `/repos/acme/docs/contents/${doc.documentPath}`,
      `/repos/acme/docs/contents/documents/doc-1.md`,
      `/repos/acme/docs/contents/.gitattributes`,
    ]);

    // Every PUT names the PR branch, never the base.
    for (const call of gh.calls.filter((c) => methodOf(c.args) === 'PUT')) {
      expect(JSON.parse(call.input as string).branch).toBe(BRANCH);
    }
    expect(gh.calls.some((c) => endpointOf(c.args).includes(`ref=${repo.baseBranch}`))).toBe(false);

    // Read-before-write for the sha, then read-back to verify: two GETs per artifact,
    // plus the `.gitattributes` read-before-write for O-2.
    const gets = gh.calls.filter((c) => methodOf(c.args) === 'GET').map((c) => endpointOf(c.args));
    expect(gets).toEqual([
      `/repos/acme/docs/contents/documents/doc-1.json?ref=${BRANCH}`,
      `/repos/acme/docs/contents/documents/doc-1.md?ref=${BRANCH}`,
      `/repos/acme/docs/contents/documents/doc-1.json?ref=${BRANCH}`,
      `/repos/acme/docs/contents/documents/doc-1.md?ref=${BRANCH}`,
      `/repos/acme/docs/contents/.gitattributes?ref=${BRANCH}`,
    ]);
  });

  it('MAKES NO MERGE CALL — merge is not part of publish (LLD §7)', async () => {
    const { gh, body } = rig();
    const { states } = await runBody(body);

    // Publish succeeded…
    expect(states).toEqual(['publishing', 'verifying', 'published']);
    // …and nothing went near the merge endpoint, by URL…
    expect(gh.calls.map((c) => endpointOf(c.args)).filter((e) => e.includes('/merge'))).toEqual([]);
    expect(gh.calls.some((c) => /\/pulls\//.test(endpointOf(c.args)))).toBe(false);
    // …and the state machine stopped at `published`, never reaching `merged`.
    expect(states).not.toContain('merged');
  });

  it('never calls adapter.mergePullRequest, even if the adapter offers it', async () => {
    const gh = fakeGh({ files: { 'documents/doc-1.json': '{}\n' } });
    const adapter = createGitHubAdapter(gh.exec);
    const merge = vi.spyOn(adapter, 'mergePullRequest');
    const doc = makeDoc();
    const body = createPublishBody({ adapter })({
      documentId: 'doc-1',
      repo,
      store: memoryStore(doc),
      document: doc,
      json: doc.doc,
      markdown: MARKDOWN,
    });
    await runBody(body);
    expect(merge).not.toHaveBeenCalled();
  });

  it('spawns no git subprocess — every call is `gh api`', async () => {
    const { gh, body } = rig();
    await runBody(body);
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const call of gh.calls) {
      expect(call.args[0]).toBe('api');
      expect(call.args.some((a) => /^(add|commit|push|checkout|clone)$/.test(a))).toBe(false);
    }
  });

  it('reports publishing → verifying → published', async () => {
    const { body } = rig();
    const { states } = await runBody(body);
    expect(states).toEqual(['publishing', 'verifying', 'published']);
  });
});

/* ------------------------------------------------------------------ *
 * R-8.21 — a mismatch fails, and nothing self-heals
 * ------------------------------------------------------------------ */

describe('R-8.21 — verification failure', () => {
  it('throws PublishVerificationError when the branch holds different bytes', async () => {
    const { body, gh } = rig({
      corruptOnRead: (path, content) => (path.endsWith('.md') ? `${content}tampered\n` : content),
    });
    await expect(runBody(body)).rejects.toBeInstanceOf(PublishVerificationError);
    // R-8.21 — nothing is regenerated or overwritten: still exactly two PUTs.
    expect(gh.calls.filter((c) => methodOf(c.args) === 'PUT')).toHaveLength(2);
    // …and still no merge.
    expect(gh.calls.map((c) => endpointOf(c.args)).filter((e) => e.includes('/merge'))).toEqual([]);
  });

  it('names the path, the branch and both hashes, and never reaches `published`', async () => {
    const { body } = rig({ corruptOnRead: (path, content) => (path.endsWith('.md') ? 'other\n' : content) });
    const states: LifecycleState[] = [];
    await expect(
      body({
        documentId: 'doc-1',
        jobId: 'j',
        kind: 'publish',
        signal: new AbortController().signal,
        log: () => {},
        setState: (s) => states.push(s),
        now: () => 0,
      }),
    ).rejects.toMatchObject({
      name: 'PublishVerificationError',
      path: 'documents/doc-1.md',
      branch: BRANCH,
      expectedSha: gitBlobSha(MARKDOWN),
      actualSha: gitBlobSha('other\n'),
    });
    expect(states).toEqual(['publishing', 'verifying']);
  });

  it('fails when the committed path is missing from the branch entirely', async () => {
    const { body } = rig({ corruptOnRead: (path, content) => (path.endsWith('.md') ? null : content) });
    await expect(runBody(body)).rejects.toMatchObject({ name: 'PublishVerificationError', actualSha: null });
  });
});

/* ------------------------------------------------------------------ *
 * R-8.12 / R-12.4 — Markdown is opaque bytes
 * ------------------------------------------------------------------ */

describe('R-8.12 — client Markdown is opaque', () => {
  const MALFORMED = [
    '```ts\nconst unterminated = 1\n', // never-closed fence
    '| a | b\n|---\n| 1 |\n', // ragged table
    '# heading\n<div><span>unclosed\n', // raw HTML, unbalanced
    '- item\n\t\t- ragged indent\r\n  * mixed marker\n', // CRLF + mixed markers
    ' ​   trailing space   \n\n\n', // NUL, zero-width, trailing whitespace
  ];

  for (const [i, markdown] of MALFORMED.entries()) {
    it(`publishes deliberately malformed Markdown unchanged (#${i + 1})`, async () => {
      const { gh, body } = rig({}, { markdown });
      await runBody(body);
      expect(gh.files.get('documents/doc-1.md')).toBe(markdown);
    });
  }

  it('does not normalize CRLF — the Contents API path preserves it exactly', async () => {
    const crlf = '# Title\r\n\r\nbody\r\n';
    const { gh, body } = rig({}, { markdown: crlf });
    await runBody(body);
    expect(gh.files.get('documents/doc-1.md')).toBe(crlf);
    expect(gh.files.get('documents/doc-1.md')).toContain('\r\n');
  });

  it('publishes an empty Markdown body without inventing content', async () => {
    const { gh, body } = rig({}, { markdown: '' });
    await runBody(body);
    expect(gh.files.get('documents/doc-1.md')).toBe('');
  });
});

describe('R-12.4 — byte-identical Markdown for the same input', () => {
  it('reproduces the same bytes and the same blob sha across two publishes', async () => {
    const markdown = '# Onboarding guide\n\nA paragraph with *emphasis* and `code`.\n';
    const first = rig({}, { markdown });
    await runBody(first.body);
    const second = rig({}, { markdown });
    await runBody(second.body);

    const a = first.gh.files.get('documents/doc-1.md') as string;
    const b = second.gh.files.get('documents/doc-1.md') as string;
    expect(a).toBe(markdown);
    expect(b).toBe(a);
    expect(gitBlobSha(b)).toBe(gitBlobSha(a));
    // The bytes that crossed the wire are identical too, not just the decoded strings.
    const putOf = (calls: Call[]) =>
      calls.filter((c) => methodOf(c.args) === 'PUT' && endpointOf(c.args).endsWith('.md')).map((c) => c.input);
    expect(putOf(second.gh.calls)).toEqual(putOf(first.gh.calls));
  });
});

/* ------------------------------------------------------------------ *
 * R-8.13 — the committed Markdown is readable from the branch afterwards
 * ------------------------------------------------------------------ */

describe('R-8.13 — the published Markdown is readable for the summary + changelog', () => {
  it('leaves the Markdown on the branch, readable through the adapter', async () => {
    const { gh, body, doc } = rig();
    await runBody(body);

    const adapter = createGitHubAdapter(gh.exec);
    const readBack = await adapter.getFile({ owner: repo.owner, repo: repo.repo }, markdownPathFor(doc.documentPath), BRANCH);
    expect(readBack?.content).toBe(MARKDOWN);
    expect(readBack?.sha).toBe(gitBlobSha(MARKDOWN));
  });

  it('logs the published Markdown path, so a subscriber knows where to read it', async () => {
    const { body } = rig();
    const { logs } = await runBody(body);
    expect(logs.join('\n')).toContain('documents/doc-1.md');
  });

  it('derives the Markdown path from the document path, with no stored field', () => {
    expect(markdownPathFor('documents/doc-1.json')).toBe('documents/doc-1.md');
    expect(markdownPathFor('a/b/c/spec.json')).toBe('a/b/c/spec.md');
    // A path that is not `.json` still gets a derivable, stable answer.
    expect(markdownPathFor('documents/doc-1')).toBe('documents/doc-1.md');
  });

  it('commits the canonical JSON envelope with the client payload installed as `doc`', async () => {
    const { gh, body } = rig({}, { json: { root: { children: [{ id: 'n-9', type: 'paragraph', version: 1 }] } } });
    await runBody(body);
    const written = JSON.parse(gh.files.get('documents/doc-1.json') as string) as CollaborationDocument;
    expect(written.documentId).toBe('doc-1');
    expect(written.documentPath).toBe('documents/doc-1.json');
    expect(written.doc).toEqual({ root: { children: [{ id: 'n-9', type: 'paragraph', version: 1 }] } });
  });
});

/* ------------------------------------------------------------------ *
 * R-8.9 / R-12.7 — the payload is required
 * ------------------------------------------------------------------ */

describe('R-8.9 — publish requires json AND markdown', () => {
  // The 400 lives in the route and is asserted in `core/vite/routes/collab.test.ts`
  // ("R-8.9 / R-12.7 — publish payload validation"). These cover the body reached
  // directly, so no entrypoint can commit an incomplete payload.
  it('rejects a missing json before any GitHub call', async () => {
    const { gh, body } = rig({}, { json: undefined });
    await expect(runBody(body)).rejects.toThrow(/missing json/);
    expect(gh.calls).toEqual([]);
  });

  it('rejects a null json', async () => {
    const { body } = rig({}, { json: null });
    await expect(runBody(body)).rejects.toThrow(/missing json/);
  });

  it('rejects a non-string markdown before any GitHub call', async () => {
    const { gh, body } = rig({}, { markdown: 42 });
    await expect(runBody(body)).rejects.toThrow(/missing markdown/);
    expect(gh.calls).toEqual([]);
  });

  it('fails when the document has no collaboration branch', async () => {
    const doc = makeDoc({ github: undefined as never });
    const gh = fakeGh();
    const body = createPublishBody({ adapter: createGitHubAdapter(gh.exec) })({
      documentId: 'doc-1',
      repo,
      store: memoryStore(doc),
      document: doc,
      json: doc.doc,
      markdown: MARKDOWN,
    });
    await expect(runBody(body)).rejects.toThrow(/no collaboration branch/);
    expect(gh.calls).toEqual([]);
  });

  it('falls back to the store when the route supplied no document', async () => {
    const doc = makeDoc();
    const gh = fakeGh({ files: { 'documents/doc-1.json': '{}\n' } });
    const store = memoryStore(doc);
    const body = createPublishBody({ adapter: createGitHubAdapter(gh.exec) })({
      documentId: 'doc-1',
      repo,
      store,
      document: null,
      json: doc.doc,
      markdown: MARKDOWN,
    });
    await runBody(body);
    expect(store.reads).toEqual(['doc-1']);
    expect(gh.files.get('documents/doc-1.md')).toBe(MARKDOWN);
  });
});

/* ------------------------------------------------------------------ *
 * R-8.14 — the client disconnecting does not stop the publish
 * ------------------------------------------------------------------ */

describe('R-8.14 — publish completes after the client disconnects', () => {
  /** A `SseSink` whose `close` handler the test fires by hand. */
  function sink(): { sink: SseSink; frames: unknown[]; close: () => void } {
    const frames: unknown[] = [];
    let onClose = () => {};
    return {
      frames,
      close: () => onClose(),
      sink: {
        writeHead: () => {},
        write: (chunk: string) => frames.push(JSON.parse(chunk.replace(/^data: /, ''))),
        on: (_event: 'close', cb: () => void) => {
          onClose = cb;
        },
        end: () => {},
        writableEnded: false,
      },
    };
  }

  it('runs to `published` through the hub after the only subscriber disconnects mid-flight', async () => {
    const gh = fakeGh({ files: { 'documents/doc-1.json': '{}\n' } });
    const doc = makeDoc();
    const hubs = createJobHubRegistry({ now: () => 1 });
    const hub = hubs.hub('doc-1');
    const subscriber = sink();
    hub.subscribe(subscriber.sink);
    expect(hub.subscriberCount()).toBe(1);

    // Hold the first GitHub call open so the disconnect lands mid-job.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = false;
    const slowExec: GhExecutor = async (args, input) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return gh.exec(args, input);
    };

    const body = createPublishBody({ adapter: createGitHubAdapter(slowExec) })({
      documentId: 'doc-1',
      repo,
      store: memoryStore(doc),
      document: doc,
      json: doc.doc,
      markdown: MARKDOWN,
    });
    expect(hub.start({ kind: 'publish', run: body }).status).toBe(200);

    // The browser tab goes away while the commit is in flight.
    subscriber.close();
    expect(hub.subscriberCount()).toBe(0);
    release();

    // Drain the microtask queue the body is suspended on — no real timers.
    for (let i = 0; i < 50 && hub.snapshot().running; i += 1) await Promise.resolve();
    await new Promise<void>((r) => queueMicrotask(r));
    for (let i = 0; i < 50 && hub.snapshot().running; i += 1) await Promise.resolve();

    expect(hub.snapshot().running).toBe(false);
    expect(hub.snapshot().state).toBe<LifecycleState>('published');
    expect(hub.snapshot().job?.ok).toBe(true);
    // The work actually landed, with nobody watching.
    expect(gh.files.get('documents/doc-1.md')).toBe(MARKDOWN);
    // The events are still replayable for a client that reconnects (R-8.4).
    const states = hub
      .snapshot()
      .events.filter((e: JobEvent) => e.type === 'state')
      .map((e) => (e as { state: LifecycleState }).state);
    expect(states).toEqual(['publishing', 'verifying', 'published']);
  });

  it('never consults ctx.signal — an already-aborted signal does not stop the work', async () => {
    // The proof that a disconnect *cannot* cancel publish: even the hub's own abort
    // signal, already tripped, changes nothing. Unlike create/sync, this body has no
    // `throwIfAborted` between steps — see the module header.
    const { gh, body } = rig();
    const aborted = new AbortController();
    aborted.abort();
    const { states } = await runBody(body, { signal: aborted.signal });
    expect(states).toEqual(['publishing', 'verifying', 'published']);
    expect(gh.files.get('documents/doc-1.md')).toBe(MARKDOWN);
  });
});

/* ------------------------------------------------------------------ *
 * O-2 — `.gitattributes` collapses the JSON diff on github.com
 * ------------------------------------------------------------------ */

describe('O-2 — .gitattributes marks the document path linguist-generated', () => {
  it('adds the entry on the PR branch, on top of the two document commits', async () => {
    const { gh, body, doc } = rig();
    await runBody(body);
    expect(gh.files.get('.gitattributes')).toBe(`${doc.documentPath} linguist-generated=true -diff\n`);
  });

  it('publishing the same document twice makes no second `.gitattributes` commit', async () => {
    const doc = makeDoc();
    const gh = fakeGh({ files: { [doc.documentPath]: '{"documentId":"doc-1"}\n' } });
    const adapter = createGitHubAdapter(gh.exec);
    const store = memoryStore(doc);

    const run = () =>
      runBody(
        createPublishBody({ adapter })({ documentId: 'doc-1', repo, store, document: doc, json: doc.doc, markdown: MARKDOWN }),
      );

    await run();
    const attributesPuts = () =>
      gh.calls.filter((c) => methodOf(c.args) === 'PUT' && endpointOf(c.args).includes('.gitattributes'));
    expect(attributesPuts()).toHaveLength(1);

    await run();
    expect(attributesPuts()).toHaveLength(1);
    expect(gh.files.get('.gitattributes')).toBe(`${doc.documentPath} linguist-generated=true -diff\n`);
  });

  it('never fails the publish when the `.gitattributes` write itself fails', async () => {
    const doc = makeDoc();
    const base = fakeGh({ files: { [doc.documentPath]: '{"documentId":"doc-1"}\n' } });
    // Every call goes through the recorded fake except a PUT to `.gitattributes`,
    // which fails as e.g. a permissions error or a concurrent-write conflict would.
    const flaky: GhExecutor = async (args, input) => {
      const endpoint = endpointOf(args);
      if (methodOf(args) === 'PUT' && endpoint.endsWith('/contents/.gitattributes')) {
        return { stdout: JSON.stringify({ message: 'Conflict', status: '409' }), stderr: '', exitCode: 1 };
      }
      return base.exec(args, input);
    };
    const adapter = createGitHubAdapter(flaky);
    const store = memoryStore(doc);
    const publishBody = createPublishBody({ adapter })({
      documentId: 'doc-1',
      repo,
      store,
      document: doc,
      json: doc.doc,
      markdown: MARKDOWN,
    });

    const { states, logs } = await runBody(publishBody);
    // The publish itself still reaches `published` — the document and markdown are
    // committed and verified — even though the presentation nicety failed.
    expect(states).toEqual(['publishing', 'verifying', 'published']);
    expect(base.files.has('.gitattributes')).toBe(false);
    expect(logs.some((l) => l.includes('gitattributes') && l.includes('Conflict'))).toBe(true);
  });
});
