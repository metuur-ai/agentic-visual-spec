/**
 * review.test.ts — the review session hub and its route surface.
 *
 * The assertions are written against the EARS statements directly: R-3.5 (live frames to
 * subscribers), R-3.6 (a `sync` snapshot first), R-8.1 (the five endpoints under
 * `/__vs/review`), R-8.2 (both hosts register them), R-8.6 (the apply stream-json reader,
 * not a second one).
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { createApplyHub } from './apply';
import type { CommentDocStore } from './comments';
import {
  createLocalSessionOps,
  createReviewHub,
  handleReviewRequest,
  type ReviewChild,
  type ReviewDeps,
  type ReviewEvent,
  type ReviewSync,
} from './review';
import { createRunLock } from './run-lock';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function rec(id: string, path = 'a.md'): CommentRecord {
  return { id, workflow: 'visual-spec', target: { path, kind: 'file' }, comment: 'make it clearer', status: 'open', ts: '' };
}

function memoryStore(initial: CommentRecord[]): CommentDocStore {
  let doc: CommentDoc = { version: 1, comments: initial };
  return { async read() { return doc; }, async write(d) { doc = d; } };
}

/** A child that stays alive until killed, capturing whatever is written to stdin. */
function liveChild(): ReviewChild & { written: string[]; emit: (line: string) => void } {
  const ee = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const written: string[] = [];
  return {
    stdout,
    stderr: null,
    stdin: new Writable({ write(chunk, _enc, cb) { written.push(String(chunk)); cb(); } }),
    on: (event: string, cb: (a: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
    kill: () => setImmediate(() => ee.emit('close', 143)),
    written,
    emit: (line: string) => stdout.push(`${line}\n`),
  } as unknown as ReviewChild & { written: string[]; emit: (line: string) => void };
}

/** Collects everything written to an SSE response. */
function fakeRes() {
  const ee = new EventEmitter();
  const chunks: string[] = [];
  let head: Record<string, string> = {};
  const res = {
    writableEnded: false,
    writeHead: (_s: number, h: Record<string, string>) => { head = h; },
    write: (c: string) => { chunks.push(c); return true; },
    on: (event: string, cb: () => void) => ee.on(event, cb),
  };
  return {
    res: res as unknown as import('node:http').ServerResponse,
    frames: () => chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as ReviewEvent | ReviewSync),
    head: () => head,
  };
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  return { cwd: '/tmp', comments: memoryStore([rec('c-1')]), readTargetFile: async () => 'hello\n', now: () => 1000, ...over };
}

const tick = () => new Promise((r) => setImmediate(r));

/* ================================================================== *
 * R-3.6 / R-3.5 — the event stream
 * ================================================================== */
describe('GET /__vs/review/events (R-3.5, R-3.6)', () => {
  it('sends a `sync` snapshot as the first frame, before any live frame', () => {
    const hub = createReviewHub(() => deps(), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);

    const first = sub.frames()[0] as ReviewSync;
    expect(first.type).toBe('sync');
    expect(first).toMatchObject({ running: false, phase: 'idle', commentId: null, startedAt: null, events: [] });
  });

  it('writes the SSE headers the apply stream uses', () => {
    const hub = createReviewHub(() => deps(), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    expect(sub.head()['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(sub.head()['cache-control']).toBe('no-cache, no-transform');
  });

  it('replays the session so far to a tab that joins mid-session, then streams live', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();

    const late = fakeRes();
    hub.subscribe(late.res);
    const snapshot = late.frames()[0] as ReviewSync;
    expect(snapshot.type).toBe('sync');
    expect(snapshot).toMatchObject({ running: true, phase: 'proposing', commentId: 'c-1', startedAt: 1000 });
    expect(snapshot.events[0]).toEqual({ type: 'review-start', commentId: 'c-1', startedAt: 1000 });

    // R-3.5: subsequent activity arrives live on the same stream.
    child.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }));
    await tick();
    expect(late.frames().at(-1)).toEqual({ type: 'log', kind: 'assistant', text: 'thinking' });
  });
});

/* ================================================================== *
 * R-8.6 — the apply stream-json reader, not a second one
 * ================================================================== */
describe('session output parsing (R-8.6)', () => {
  it('parses the child stream with the reader `apply.ts` exports', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();

    child.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.md' } }] } }));
    await tick();
    expect(sub.frames()).toContainEqual({ type: 'log', kind: 'tool', tool: 'Read', target: 'a.md' });
  });

  it('imports `summarize` from the apply module rather than reimplementing it', () => {
    const source = readFileSync(resolve(pkgRoot, 'core/vite/routes/review.ts'), 'utf8');
    expect(source).toMatch(/import \{[^}]*summarize[^}]*\} from '\.\/apply'/);
    expect(source).not.toContain('JSON.parse(line)');
  });
});

/* ================================================================== *
 * R-3.4 / R-8.5 — the shared lock, in both directions
 * ================================================================== */
describe('the shared RunLock (R-3.4, R-8.5)', () => {
  it('a running review refuses a bulk apply, naming `review` as the holder', () => {
    const lock = createRunLock();
    const child = liveChild();
    const review = createReviewHub(() => deps({ spawnSession: () => child }), lock);
    const apply = createApplyHub(() => ({ cwd: '/tmp', comments: memoryStore([rec('c-1')]) }), lock);

    expect(review.start('c-1').status).toBe(200);
    expect(lock.heldBy()).toBe('review');
    expect(apply.start()).toEqual({ status: 409, json: { error: 'a review session is already running', holder: 'review' } });
  });

  it('a running apply refuses a review start, naming `apply` as the holder', () => {
    const lock = createRunLock();
    lock.acquire('apply');
    const review = createReviewHub(() => deps(), lock);
    expect(review.start('c-1')).toEqual({ status: 409, json: { error: 'an apply is already running', holder: 'apply' } });
  });

  it('a second review start is refused while the first holds the slot', () => {
    const lock = createRunLock();
    const hub = createReviewHub(() => deps({ spawnSession: () => liveChild() }), lock);
    expect(hub.start('c-1').status).toBe(200);
    expect(hub.start('c-2')).toEqual({ status: 409, json: { error: 'a review session is already running', holder: 'review' } });
  });

  it('releases the slot on cancel, on child exit, and on a failed start', async () => {
    const lock = createRunLock();
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), lock);

    hub.start('c-1');
    expect(hub.cancel().status).toBe(200);
    expect(lock.heldBy()).toBe(null);

    const c2 = liveChild();
    const hub2 = createReviewHub(() => deps({ spawnSession: () => c2 }), lock);
    hub2.start('c-1');
    await tick();
    c2.kill?.('SIGKILL');
    await tick();
    await tick();
    expect(lock.heldBy()).toBe(null);

    // No comment with that id → the session never begins, and must not wedge the slot.
    const hub3 = createReviewHub(() => deps(), lock);
    hub3.start('nope');
    await tick();
    await tick();
    expect(lock.heldBy()).toBe(null);
  });
});

/* ================================================================== *
 * R-8.1 / R-7.5 — the route surface
 * ================================================================== */
describe('the /__vs/review route surface (R-8.1)', () => {
  const call = (hub: ReturnType<typeof createReviewHub>, method: string, pathname: string, body: Record<string, unknown> = {}) =>
    handleReviewRequest(hub, { method, pathname, body, sse: fakeRes().res });

  it('routes subscribe, start, message, approve and cancel', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());

    expect(call(hub, 'GET', '/events')).toEqual({ streamed: true });
    expect(call(hub, 'POST', '/start', { commentId: 'c-1' })).toEqual({ status: 200, json: { ok: true } });
    await tick();
    expect(call(hub, 'POST', '/message', { text: 'shorter please' })).toEqual({ status: 200, json: { ok: true } });
    expect(child.written.join('')).toContain('shorter please');
    expect((call(hub, 'POST', '/approve') as { status: number }).status).toBe(409);
    expect(call(hub, 'POST', '/cancel')).toEqual({ status: 200, json: { ok: true } });
  });

  it('404s an unknown subpath and 400s a start with no commentId', () => {
    const hub = createReviewHub(() => deps(), createRunLock());
    expect(call(hub, 'GET', '/nope')).toMatchObject({ status: 404 });
    expect(call(hub, 'POST', '/start', {})).toMatchObject({ status: 400 });
  });

  it('message/approve/cancel with no session conflict rather than starting work (R-7.5)', () => {
    const hub = createReviewHub(() => deps(), createRunLock());
    for (const path of ['/message', '/approve', '/cancel']) {
      expect(call(hub, 'POST', path, { text: 'x' })).toEqual({
        status: 409,
        json: { error: 'no active review session', code: 'no-session' },
      });
    }
  });

  it('distinguishes an ended session from no session at all (R-7.7)', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    child.kill?.('SIGKILL');
    await tick();
    await tick();
    expect(call(hub, 'POST', '/message', { text: 'x' })).toMatchObject({ status: 409, json: { code: 'session-ended' } });
  });
});

/* ================================================================== *
 * R-8.2 — registered in BOTH hosts
 * ================================================================== */
describe('both hosts register the review routes (R-8.2)', () => {
  const HOSTS = ['src/server.ts', 'core/vite/md-plugin.ts'];
  const code = (host: string) => readFileSync(resolve(pkgRoot, host), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

  it.each(HOSTS)('%s builds the hub and dispatches /__vs/review into the shared handler', (host) => {
    const text = code(host);
    expect(text).toMatch(/import \{[^}]*createReviewHub[^}]*\} from '[^']*routes\/review'/);
    expect(text).toMatch(/import \{[^}]*handleReviewRequest[^}]*\} from '[^']*routes\/review'/);
    expect(text).toContain('createReviewHub(');
    expect(text).toContain('handleReviewRequest(reviewHub,');
    expect(text).toContain("'/__vs/review'");
  });
});

/* ================================================================== *
 * The local session implementation (LLD decision (b))
 * ================================================================== */
describe('createLocalSessionOps', () => {
  it('resolves the comment from the sidecar and locates its file', async () => {
    const ops = createLocalSessionOps(() => deps());
    const c = await ops.resolve('c-1');
    expect(c).toMatchObject({ id: 'c-1', comment: 'make it clearer', path: 'a.md' });
    const located = await ops.locate(c!);
    expect(located).toMatchObject({ path: 'a.md' });
    expect(located?.pin).toBeTruthy();
  });

  it('returns null for an unknown comment and for a missing file', async () => {
    const ops = createLocalSessionOps(() => deps({ readTargetFile: async () => null }));
    expect(await ops.resolve('nope')).toBe(null);
    expect(await ops.locate({ id: 'c-1', comment: 'x', workflow: 'w', path: 'gone.md' })).toBe(null);
  });

  it('reports drift when the pinned target changes, and no drift when it does not', async () => {
    let content = 'hello\n';
    const ops = createLocalSessionOps(() => deps({ readTargetFile: async () => content }));
    const located = (await ops.locate((await ops.resolve('c-1'))!))!;
    expect(await ops.checkDrift(located)).toEqual({ drifted: false });
    content = 'hello there\n';
    expect(await ops.checkDrift(located)).toEqual({ drifted: true, reason: 'a.md changed since the proposal' });
  });

  it('finishes by flipping only the target comment to applied with a result', async () => {
    const store = memoryStore([rec('c-1'), rec('c-2')]);
    const ops = createLocalSessionOps(() => deps({ comments: store }));
    await ops.finish((await ops.resolve('c-1'))!, { result: 'Rewrote the paragraph.' });
    const doc = await store.read();
    expect(doc.comments.find((c) => c.id === 'c-1')).toMatchObject({ status: 'applied', result: 'Rewrote the paragraph.' });
    expect(doc.comments.find((c) => c.id === 'c-2')).toMatchObject({ status: 'open' });
  });

  it('exposes the scoped-apply fallback as available in local mode', () => {
    expect(createLocalSessionOps(() => deps()).fallbackAvailable).toBe(true);
  });
});
