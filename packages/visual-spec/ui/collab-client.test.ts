/**
 * collab-client.test.ts — the browser's half of the `/__vs/collab` contract (R-7.1).
 *
 * `fetch` is injected, so nothing here touches a server. The assertions are on the
 * request each call sends (method, path, body) and on the *shape* it hands back — the
 * point of the module being that expected failures arrive as values, not exceptions.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyJobFrame, createCollabClient } from './collab-client';
import type { JobSnapshot } from '../core/collaboration/job-hub';

type Call = { url: string; method: string; body?: unknown };

/** A `fetch` that answers everything with one canned response and records the request. */
function stubFetch(response: { ok?: boolean; status?: number; json?: unknown; reject?: Error }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
    });
    if (response.reject) throw response.reject;
    const status = response.status ?? 200;
    return { ok: response.ok ?? status < 400, status, json: async () => response.json } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const AVAILABLE = { available: true, login: 'reviewer-rita', repo: { owner: 'acme', repo: 'docs' }, scopes: ['repo'] };
const ACCEPTED = { ok: true, jobId: 'doc-1-1', kind: 'sync' };

describe('every wired route, on its success path', () => {
  it('GET /__vs/collab returns the availability snapshot', async () => {
    const { impl, calls } = stubFetch({ json: AVAILABLE });
    const result = await createCollabClient(impl).availability();
    expect(calls).toEqual([{ url: '/__vs/collab', method: 'GET' }]);
    expect(result).toEqual({ ok: true, value: AVAILABLE });
  });

  it('POST /start sends the create payload', async () => {
    const { impl, calls } = stubFetch({ json: { ...ACCEPTED, kind: 'create' } });
    const result = await createCollabClient(impl).start({ documentId: 'doc-1', documentPath: 'docs/spec.md', title: 'Spec' });
    expect(calls[0]).toEqual({
      url: '/__vs/collab/start',
      method: 'POST',
      body: { documentId: 'doc-1', documentPath: 'docs/spec.md', title: 'Spec' },
    });
    expect(result.ok && result.value.kind).toBe('create');
  });

  it('POST /open sends documentId + pullNumber', async () => {
    const { impl, calls } = stubFetch({ json: ACCEPTED });
    await createCollabClient(impl).open({ documentId: 'doc-1', pullNumber: 42 });
    expect(calls[0]).toEqual({ url: '/__vs/collab/open', method: 'POST', body: { documentId: 'doc-1', pullNumber: 42 } });
  });

  it('GET /:id returns the R-8.4 snapshot with the document summary attached', async () => {
    const status = {
      documentId: 'doc-1',
      state: 'draft',
      running: false,
      job: null,
      events: [],
      droppedEvents: 0,
      document: { documentId: 'doc-1', documentPath: 'docs/spec.md', title: 'Spec', github: null },
    };
    const { impl, calls } = stubFetch({ json: status });
    const result = await createCollabClient(impl).status('doc-1');
    expect(calls[0]).toEqual({ url: '/__vs/collab/doc-1', method: 'GET' });
    expect(result.ok && result.value.document?.documentPath).toBe('docs/spec.md');
  });

  it('GET /:id/document returns the whole document, not the summary (R-7.3 / R-7.4)', async () => {
    const doc = {
      documentId: 'doc-1',
      documentPath: 'docs/spec.md',
      title: 'Spec',
      frontmatter: { status: 'draft' },
      nodes: [{ id: 'n-1', type: 'paragraph', version: 3, content: 'a claim' }],
      doc: { root: {} },
      github: { owner: 'acme', repo: 'docs', branch: 'vs/doc-1', pullNumber: 7, resolved: false },
    };
    const { impl, calls } = stubFetch({ json: doc });
    const result = await createCollabClient(impl).document('doc-1');
    expect(calls).toEqual([{ url: '/__vs/collab/doc-1/document', method: 'GET' }]);
    expect(result).toEqual({ ok: true, value: doc });
    // The three fields `status()` cannot give the caller.
    expect(result.ok && [result.value.doc, result.value.nodes.length, result.value.frontmatter]).toEqual([
      { root: {} },
      1,
      { status: 'draft' },
    ]);
  });

  it('GET /:id/comments returns the records as an array (R-5.7)', async () => {
    const records = [
      { id: 'c-00000001', workflow: 'visual-spec', target: { path: 'docs/spec.md', kind: 'file' }, comment: 'tighten', status: 'open', ts: 'T0', collab: { nodeId: 'n-7' } },
      { id: 'c-00000002', workflow: 'visual-spec', target: { path: 'docs/spec.md', kind: 'file' }, comment: 'overall', status: 'open', ts: 'T1' },
    ];
    const { impl, calls } = stubFetch({ json: records });
    const result = await createCollabClient(impl).comments('doc-1');
    expect(calls).toEqual([{ url: '/__vs/collab/doc-1/comments', method: 'GET' }]);
    expect(result.ok && result.value).toEqual(records);
  });

  it('POST /:id/sync carries the idempotency key when one is given (R-8.23)', async () => {
    const { impl, calls } = stubFetch({ json: ACCEPTED });
    await createCollabClient(impl).sync('doc-1', { idempotencyKey: 'k-1' });
    expect(calls[0]).toEqual({ url: '/__vs/collab/doc-1/sync', method: 'POST', body: { idempotencyKey: 'k-1' } });
  });

  it('POST /:id/sync still sends a body when no key is given — the route reads `body.*`', async () => {
    const { impl, calls } = stubFetch({ json: ACCEPTED });
    await createCollabClient(impl).sync('doc-1');
    expect(calls[0]?.body).toEqual({});
  });

  it('POST /:id/publish sends both json and markdown, which R-8.9 validates first', async () => {
    const { impl, calls } = stubFetch({ json: { ...ACCEPTED, kind: 'publish' } });
    const json = { root: { children: [] } } as never;
    await createCollabClient(impl).publish('doc-1', { json, markdown: '# Spec\n' });
    expect(calls[0]).toEqual({
      url: '/__vs/collab/doc-1/publish',
      method: 'POST',
      body: { json: { root: { children: [] } }, markdown: '# Spec\n' },
    });
  });

  it('POST /:id/comments anchors on path + line (R-0.3 / R-7.5)', async () => {
    const saved = { ok: true, id: 'c-000dbba1', comment: { id: 'c-000dbba1' } };
    const { impl, calls } = stubFetch({ json: saved });
    const result = await createCollabClient(impl).addComment('doc-1', {
      comment: 'tighten this',
      path: 'docs/spec.md',
      startLine: 12,
      endLine: 15,
      selectedText: 'The reviewer reads this block.',
    });
    expect(calls[0]).toEqual({
      url: '/__vs/collab/doc-1/comments',
      method: 'POST',
      body: {
        comment: 'tighten this',
        path: 'docs/spec.md',
        startLine: 12,
        endLine: 15,
        selectedText: 'The reviewer reads this block.',
      },
    });
    expect(result.ok && result.value.id).toBe('c-000dbba1');
  });

  /*
   * R-7.13 — the server degrades to a file-level comment when the line is not in the
   * diff, and says so. The disclosure has to reach the caller intact: a client that
   * dropped it would show a comment anchored to a line it is not actually on.
   */
  it('passes the degraded disclosure through untouched (R-7.13)', async () => {
    const saved = {
      ok: true,
      id: 'c-000dbba1',
      comment: { id: 'c-000dbba1' },
      degraded: { to: 'file', reason: 'Validation Failed' },
    };
    const { impl } = stubFetch({ json: saved });
    const result = await createCollabClient(impl).addComment('doc-1', { comment: 'x', startLine: 12 });
    expect(result.ok && result.value.degraded).toEqual({ to: 'file', reason: 'Validation Failed' });
  });

  it('carries the idempotency key so a retry after a timeout cannot duplicate (R-5.11)', async () => {
    const { impl, calls } = stubFetch({ json: { ok: true, id: 'c-000dbba1', comment: {} } });
    await createCollabClient(impl).addComment('doc-1', { comment: 'x', startLine: 12, idempotencyKey: 'k-1' });
    expect(calls[0]?.body).toEqual({ comment: 'x', startLine: 12, idempotencyKey: 'k-1' });
  });

  it('POST /:id/comments/:commentId/reply posts to the reply path', async () => {
    const { impl, calls } = stubFetch({ json: { ok: true, id: 'c-99', comment: {} } });
    await createCollabClient(impl).replyToComment('doc-1', 'c-a1b2c3d4', { comment: 'agreed' });
    expect(calls[0]).toEqual({
      url: '/__vs/collab/doc-1/comments/c-a1b2c3d4/reply',
      method: 'POST',
      body: { comment: 'agreed' },
    });
  });

  it('PATCH /:id/comments/:commentId sends the patch as-is', async () => {
    const { impl, calls } = stubFetch({ json: { ok: true, comment: { id: 'c-a1b2c3d4', status: 'applied' } } });
    const result = await createCollabClient(impl).patchComment('doc-1', 'c-a1b2c3d4', { status: 'applied' });
    expect(calls[0]).toEqual({
      url: '/__vs/collab/doc-1/comments/c-a1b2c3d4',
      method: 'PATCH',
      body: { status: 'applied' },
    });
    expect(result.ok && result.value.comment.status).toBe('applied');
  });

  it('names the SSE URL without opening it', () => {
    const { impl, calls } = stubFetch({ json: null });
    expect(createCollabClient(impl).eventsUrl('doc-1')).toBe('/__vs/collab/doc-1/events');
    expect(calls).toEqual([]);
  });
});

describe('the failures that are ordinary states of a working system', () => {
  it('409 is a conflict the caller can act on, not an exception (R-8.1)', async () => {
    const { impl } = stubFetch({ status: 409, json: { error: 'a sync is already running for doc-1' } });
    const result = await createCollabClient(impl).sync('doc-1');
    expect(result).toEqual({ ok: false, kind: 'conflict', status: 409, message: 'a sync is already running for doc-1' });
  });

  it('409 on a comment route carries the server’s own "no pull request yet" wording', async () => {
    const message = 'document doc-1 has no pull request yet — run start or open first';
    const { impl } = stubFetch({ status: 409, json: { error: message } });
    const result = await createCollabClient(impl).addComment('doc-1', { comment: 'hi' });
    expect(result).toEqual({ ok: false, kind: 'conflict', status: 409, message });
  });

  it('503 hands back the whole availability snapshot, not a flattened message (R-7.8)', async () => {
    const off = { available: false, reason: 'not_configured', message: 'collaboration is not configured' };
    const { impl } = stubFetch({ status: 503, json: off });
    const result = await createCollabClient(impl).publish('doc-1', { json: {} as never, markdown: '' });
    expect(result).toEqual({
      ok: false,
      kind: 'unavailable',
      status: 503,
      availability: off,
      message: 'collaboration is not configured',
    });
  });

  it('403 from the authorizer is a forbidden result carrying the verdict text', async () => {
    const { impl } = stubFetch({ status: 403, json: { error: 'reviewer-rita may not publish doc-1' } });
    const result = await createCollabClient(impl).publish('doc-1', { json: {} as never, markdown: '# x' });
    expect(result).toEqual({ ok: false, kind: 'forbidden', status: 403, message: 'reviewer-rita may not publish doc-1' });
  });

  it('404 on an unknown document is distinguishable from every other failure', async () => {
    const { impl } = stubFetch({ status: 404, json: { error: 'unknown document: doc-9' } });
    const result = await createCollabClient(impl).addComment('doc-9', { comment: 'hi' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('not-found');
  });

  it('400 from the route layer’s own validation is a bad request', async () => {
    const { impl } = stubFetch({ status: 400, json: { error: 'missing markdown' } });
    const result = await createCollabClient(impl).publish('doc-1', { json: {} as never, markdown: '' });
    expect(!result.ok && result.kind).toBe('bad-request');
  });

  it('501 and anything else unmapped stays a server failure with its status intact', async () => {
    const { impl } = stubFetch({ status: 501, json: { error: 'comment store does not support collaborative comments' } });
    const result = await createCollabClient(impl).addComment('doc-1', { comment: 'hi' });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind === 'network') throw new Error('expected a server failure');
    expect(result.kind).toBe('server');
    expect(result.status).toBe(501);
  });

  it('the read routes fail as values too — 404 on document(), 409 on comments()', async () => {
    const missing = stubFetch({ status: 404, json: { error: 'unknown document: doc-9' } });
    const notFound = await createCollabClient(missing.impl).document('doc-9');
    expect(notFound).toEqual({ ok: false, kind: 'not-found', status: 404, message: 'unknown document: doc-9' });

    const message = 'document doc-1 has no pull request yet — run start or open first';
    const noPr = stubFetch({ status: 409, json: { error: message } });
    expect(await createCollabClient(noPr.impl).comments('doc-1')).toEqual({
      ok: false,
      kind: 'conflict',
      status: 409,
      message,
    });
  });

  it('a rejected fetch never reached the route layer, so it has no server message', async () => {
    const { impl } = stubFetch({ reject: new Error('Failed to fetch') });
    const result = await createCollabClient(impl).availability();
    expect(result).toEqual({ ok: false, kind: 'network', message: 'Failed to fetch' });
  });

  it('a non-JSON body is a network failure, not a silent success', async () => {
    const impl = vi.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') })) as unknown as typeof fetch;
    const result = await createCollabClient(impl).availability();
    expect(!result.ok && result.kind).toBe('network');
  });
});

const SNAPSHOT: JobSnapshot = {
  documentId: 'doc-1',
  state: 'draft',
  running: false,
  job: null,
  events: [],
  droppedEvents: 0,
};

describe('applying the frames the hub streams (R-8.2 / R-8.4)', () => {
  it('a sync frame replaces the snapshot outright — it is what a late subscriber recovers from', () => {
    const recovered = applyJobFrame(null, {
      type: 'sync',
      ...SNAPSHOT,
      state: 'pr-open',
      running: true,
      droppedEvents: 3,
    });
    expect(recovered).toEqual({ ...SNAPSHOT, state: 'pr-open', running: true, droppedEvents: 3 });
    expect(recovered && 'type' in recovered).toBe(false);
  });

  it('job-start marks the document running and records the job', () => {
    const next = applyJobFrame(SNAPSHOT, { type: 'job-start', jobId: 'doc-1-1', kind: 'sync', startedAt: 10 });
    expect(next?.running).toBe(true);
    expect(next?.job).toEqual({ jobId: 'doc-1-1', kind: 'sync', startedAt: 10, finishedAt: null, ok: null });
  });

  it('log and state frames accumulate without ending the job', () => {
    const started = applyJobFrame(SNAPSHOT, { type: 'job-start', jobId: 'doc-1-1', kind: 'sync', startedAt: 10 })!;
    const logged = applyJobFrame(started, { type: 'log', jobId: 'doc-1-1', kind: 'progress', text: 'fetching comments' })!;
    const stated = applyJobFrame(logged, { type: 'state', jobId: 'doc-1-1', state: 'pr-open', at: 11 })!;
    expect(stated.state).toBe('pr-open');
    expect(stated.running).toBe(true);
    expect(stated.events).toHaveLength(3);
  });

  it('job-done clears running and closes out the job record', () => {
    const started = applyJobFrame(SNAPSHOT, { type: 'job-start', jobId: 'doc-1-1', kind: 'sync', startedAt: 10 })!;
    const done = applyJobFrame(started, {
      type: 'job-done',
      jobId: 'doc-1-1',
      kind: 'sync',
      ok: true,
      state: 'ready',
      finishedAt: 20,
    })!;
    expect(done.running).toBe(false);
    expect(done.state).toBe('ready');
    expect(done.job).toEqual({ jobId: 'doc-1-1', kind: 'sync', startedAt: 10, finishedAt: 20, ok: true });
  });

  it('job-error only logs — the job-done that follows it carries the terminal state', () => {
    const started = applyJobFrame(SNAPSHOT, { type: 'job-start', jobId: 'doc-1-1', kind: 'sync', startedAt: 10 })!;
    const errored = applyJobFrame(started, { type: 'job-error', jobId: 'doc-1-1', kind: 'sync', message: 'rate limited', at: 15 })!;
    expect(errored.running).toBe(true);
    expect(errored.events).toHaveLength(2);
  });

  it('a frame arriving before any snapshot is dropped rather than inventing one', () => {
    expect(applyJobFrame(null, { type: 'log', jobId: 'doc-1-1', kind: 'system', text: 'hi' })).toBeNull();
  });
});
