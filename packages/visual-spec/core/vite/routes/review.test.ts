/**
 * review.test.ts — the review session hub and its route surface.
 *
 * The assertions are written against the EARS statements directly: R-3.5 (live frames to
 * subscribers), R-3.6 (a `sync` snapshot first), R-8.1 (the five endpoints under
 * `/__vs/review`), R-8.2 (both hosts register them), R-8.6 (the apply stream-json reader,
 * not a second one).
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { buildReviewPrompt, PROPOSAL_SCHEMA, type Proposal } from '../../editing/review-prompt';
import { createApplyHub } from './apply';
import type { CommentDocStore } from './comments';
import {
  createLocalSessionOps,
  createReviewHub,
  DEFAULT_IDLE_TIMEOUT_MS,
  defaultSpawnReviewSession,
  handleReviewRequest,
  replayedUserText,
  REVIEW_CLI_ARGS,
  type ReviewChild,
  type ReviewDeps,
  type ReviewEvent,
  type ReviewSessionOps,
  type ReviewSync,
  userTurnFrame,
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

/**
 * A child whose in-channel breaks *after* the session is under way — the dead-pipe half
 * of the R-7.7 race. The opening turn goes through, so the failure lands where the
 * requirement puts it: on a follow-up, against a session the hub still believes in.
 */
function brokenPipeChild(): ReviewChild {
  const base = liveChild();
  let turns = 0;
  return {
    ...base,
    stdin: new Writable({
      write(_chunk, _enc, cb) {
        turns += 1;
        if (turns > 1) throw new Error('write EPIPE');
        cb();
      },
    }),
  } as unknown as ReviewChild;
}

/**
 * A hand-cranked scheduler. R-7.6's bound is fifteen minutes, so the tests drive the
 * timer rather than waiting for it — the same reason `deps.now` exists.
 */
function fakeTimers() {
  let pending: Array<{ id: number; fn: () => void; ms: number }> = [];
  let seq = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      pending.push({ id: seq, fn, ms });
      return seq;
    },
    clearTimer: (handle: unknown) => {
      pending = pending.filter((p) => p.id !== handle);
    },
    /** How many reap timers are armed right now (0 or 1 — the hub keeps at most one). */
    armed: () => pending.length,
    /** The delay of the armed timer, so the default bound is asserted, not assumed. */
    delay: () => pending[0]?.ms,
    /** The identity of the armed timer, so "re-armed" is distinguishable from "left alone". */
    id: () => pending[0]?.id,
    fire: () => {
      const next = pending.shift();
      next?.fn();
    },
  };
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
    /** The dropped tab: what Node emits when the client goes away (R-7.6). */
    close: () => { res.writableEnded = true; ee.emit('close'); },
  };
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  return { cwd: '/tmp', comments: memoryStore([rec('c-1')]), readTargetFile: async () => 'hello\n', now: () => 1000, ...over };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Ticks until a condition holds — for hubs whose `begin` awaits real filesystem reads. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i += 1) await tick();
  expect(cond()).toBe(true);
}

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

/* ================================================================== *
 * B1.3 — the transport (R-3.3, R-3.7, R-4.7, R-8.3, R-8.7)
 * ================================================================== */
describe('the review session transport (R-3.3, R-8.3)', () => {
  it('runs a persistent stream-json session in plan mode with user replay', () => {
    // Spelled out flag by flag: this list *is* the requirement. `--print` + stream-json
    // in and out is R-3.3, `--replay-user-messages` is R-8.7, and `--permission-mode
    // plan` is R-3.7's permission-layer edit gate.
    expect(REVIEW_CLI_ARGS).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      '--permission-mode',
      'plan',
      '--verbose',
    ]);
  });

  it('pipes stdin, unlike the apply spawn which ignores it (R-8.3)', () => {
    // The real spawn, but nothing is written to it and it is killed immediately: the
    // point is `stdio[0]`, observable as a non-null `stdin` on the child. `apply.ts`
    // passes 'ignore' there and so has no channel to write a follow-up turn down.
    const child = defaultSpawnReviewSession(
      { id: 'c-1', comment: 'x', workflow: 'visual-spec', path: 'a.md' },
      tmpdir(),
    );
    child.on('error', () => {}); // claude may not be on PATH — irrelevant to this assertion
    expect(child.stdin).toBeTruthy();
    expect(child.stdout).toBeTruthy();
    child.kill?.('SIGKILL');

    expect(readFileSync(resolve(pkgRoot, 'core/vite/routes/apply.ts'), 'utf8')).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(readFileSync(resolve(pkgRoot, 'core/vite/routes/review.ts'), 'utf8')).toContain("stdio: ['pipe', 'pipe', 'pipe']");
  });

  it('writes an opening turn down the in-channel when a session starts', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    expect(child.written).toHaveLength(1);
    const frame = JSON.parse(child.written[0]) as { type: string; message: { role: string; content: Array<{ type: string; text: string }> } };
    expect(frame.type).toBe('user');
    expect(frame.message.role).toBe('user');
    expect(frame.message.content[0].type).toBe('text');
    expect(frame.message.content[0].text).toContain('make it clearer');
    expect(frame.message.content[0].text).toContain('a.md');
  });

  it('sends follow-up turns in the frame shape the CLI accepts on stdin', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    hub.message('shorter please');
    // Newline-delimited: the CLI reads one JSON frame per line.
    expect(child.written.at(-1)).toBe(userTurnFrame('shorter please'));
    expect(JSON.parse(child.written.at(-1) as string)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'shorter please' }] },
    });
  });

  it('reports a spawn that throws rather than wedging the slot', async () => {
    const lock = createRunLock();
    const sub = fakeRes();
    const hub = createReviewHub(() => deps({ spawnSession: () => { throw new Error('spawn EACCES'); } }), lock);
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();
    await tick();
    expect(sub.frames()).toContainEqual({ type: 'error', message: 'Could not start claude: spawn EACCES' });
    expect(lock.heldBy()).toBe(null);
  });
});

describe('follow-up turns appear in the transcript (R-8.7)', () => {
  it('surfaces a replayed user message as a `user-turn` frame in stream order', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();
    hub.message('shorter please');

    // What `--replay-user-messages` puts back on stdout, followed by the answer to it.
    child.emit(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'shorter please' }] } }));
    child.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok, shorter' }] } }));
    await tick();

    const frames = sub.frames();
    const turn = frames.findIndex((f) => f.type === 'user-turn');
    const answer = frames.findIndex((f) => f.type === 'log' && (f as { text?: string }).text === 'ok, shorter');
    expect(frames[turn]).toEqual({ type: 'user-turn', text: 'shorter please' });
    // One ordered log (R-8.7): the user's words sit before the reply to them.
    expect(turn).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(turn);
  });

  it('does not mistake a tool_result user frame for a typed turn', () => {
    expect(replayedUserText(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }))).toBe(null);
    expect(replayedUserText(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBe(null);
    expect(replayedUserText('not json')).toBe(null);
    // A plain-string content body resolves too — both shapes appear on the wire.
    expect(replayedUserText(JSON.stringify({ type: 'user', message: { content: 'hello' } }))).toBe('hello');
  });

  it('keeps `agent-done` attribution working alongside the echo', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();
    child.emit(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } }));
    await tick();
    expect(sub.frames()).toContainEqual({ type: 'agent-done', agentId: 'toolu_1' });
    expect(sub.frames().some((f) => f.type === 'user-turn')).toBe(false);
  });
});

describe('a re-init frame is a new turn, not a new session (spike 0.1)', () => {
  it('keeps the phase, comment and start time across a second system/init', async () => {
    // Spike 0.1: the CLI emits `system/init` at the start of EVERY turn while keeping the
    // same session id. Treating the second one as a fresh session — or as an error —
    // would reset the hub mid-refine and drop the transcript.
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    child.emit(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }));
    child.emit(JSON.stringify({ type: 'result', result: 'first proposal', session_id: 's-1' }));
    await tick();
    hub.message('again please');
    child.emit(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }));
    await tick();

    expect(hub.snapshot()).toEqual({ running: true, phase: 'proposing', commentId: 'c-1', startedAt: 1000 });
  });
});

describe('propose writes nothing to the workspace (R-4.7, R-3.7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-review-nowrite-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves the target file byte-identical across start, a follow-up turn and cancel', async () => {
    // NOTE (spike 0.1): plan mode is workspace-scoped, not a process-wide no-write — the
    // CLI writes its own plan files under ~/.claude/plans/ regardless. The invariant that
    // matters, and the one asserted here, is that the *target* is untouched.
    const target = join(dir, 'a.md');
    writeFileSync(target, '# heading\n\nbody\n');
    const before = readFileSync(target);
    const store = memoryStore([rec('c-1')]);

    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: dir, comments: store, spawnSession: () => child, now: () => 1000 }),
      createRunLock(),
    );
    hub.start('c-1');
    await tick();
    child.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I would rewrite the heading' }] } }));
    await tick();
    hub.message('shorter please');
    child.emit(JSON.stringify({ type: 'result', result: 'proposal v2' }));
    await tick();
    hub.cancel();
    await tick();

    expect(readFileSync(target)).toEqual(before);
    // …and the comment is still open: propose changes no state at all (R-3.2).
    expect((await store.read()).comments[0].status).toBe('open');
  });
});

/* ================================================================== *
 * B2.1 — the proposal envelope (R-4.1…R-4.6)
 * ================================================================== */

/** What a turn's result frame really looks like: an envelope on `structured_output`. */
const ENVELOPE: Proposal = {
  interpretation: 'The reviewer wants the heading to name the audience.',
  strategy: 'Rewrite the heading.',
  reasoning: 'A heading that names the audience orients the reader immediately.',
  assumptions: [],
  ambiguities: [],
  alternatives: [],
  patch: 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-# heading\n+# heading for reviewers\n',
  impact: 'One line; nothing else in the file refers to it.',
};

const resultFrame = (proposal: Proposal) => JSON.stringify({ type: 'result', subtype: 'success', structured_output: proposal });

describe('the proposal envelope reaches subscribers (R-4.1–R-4.6)', () => {
  it('spawns with `--json-schema` carrying the pinned envelope', () => {
    const child = defaultSpawnReviewSession({ id: 'c-1', comment: 'x', workflow: 'visual-spec', path: 'a.md' }, tmpdir());
    child.on('error', () => {}); // claude may not be on PATH — irrelevant to this assertion
    const args = (child as unknown as { spawnargs: string[] }).spawnargs;
    child.kill?.('SIGKILL');

    // Populated deterministically by the CLI rather than parsed out of prose: the schema
    // *is* the contract, so it is asserted here rather than described.
    const at = args.indexOf('--json-schema');
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(args[at + 1] as string)).toEqual(PROPOSAL_SCHEMA);
    // …alongside, not instead of, the transport flags.
    for (const flag of REVIEW_CLI_ARGS) expect(args).toContain(flag);
  });

  it('surfaces a result frame carrying an envelope as a `proposal` event', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();

    child.emit(resultFrame(ENVELOPE));
    await tick();
    expect(sub.frames()).toContainEqual({ type: 'proposal', proposal: ENVELOPE });
  });

  it('emits one proposal per turn, so a refinement replaces rather than appends to it (R-5.2)', async () => {
    // Verified against the real CLI (spike 2.1): `--json-schema` pins EVERY turn's result
    // frame on a persistent stream-json session, not only the final one — so the refine
    // phase gets a whole updated envelope, patch included, on each turn.
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();

    child.emit(resultFrame(ENVELOPE));
    await tick();
    hub.message('shorter please');
    const refined: Proposal = { ...ENVELOPE, patch: `${ENVELOPE.patch}\n`, strategy: 'Shorten the heading instead.' };
    child.emit(resultFrame(refined));
    await tick();

    const proposals = sub.frames().filter((f) => f.type === 'proposal') as Array<{ proposal: Proposal }>;
    expect(proposals).toHaveLength(2);
    expect(proposals[1].proposal.patch).not.toBe(proposals[0].proposal.patch);
  });

  it('a turn with no envelope produces no proposal — nothing is invented from prose', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();

    // A plain prose result, which is what a session without the schema would produce.
    child.emit(JSON.stringify({ type: 'result', result: 'I would rewrite the heading to name the audience.' }));
    await tick();
    expect(sub.frames().some((f) => f.type === 'proposal')).toBe(false);
    // …and it still shows up as ordinary activity, so nothing is silently swallowed.
    expect(sub.frames()).toContainEqual({ type: 'log', kind: 'result', text: 'I would rewrite the heading to name the audience.' });
  });

  it('refuses an approval with no proposal, and does not re-derive once there is one', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    expect(hub.approve()).toMatchObject({ status: 409, json: { code: 'no-proposal' } });

    child.emit(resultFrame(ENVELOPE));
    await tick();
    // The write is B4.1. What must not happen in the meantime is a write that re-derives
    // the change and presents it as the approved diff (R-6.2, R-6.8).
    expect(hub.approve()).toMatchObject({ status: 501, json: { code: 'not-implemented' } });
  });
});

/* ================================================================== *
 * B2.2 — start propose (R-3.1, R-3.2, R-3.8)
 * ================================================================== */
describe('POST /review/start begins propose (R-3.1, R-3.2, R-3.8)', () => {
  it('opens the session with the real review prompt, not a placeholder', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();

    const frame = JSON.parse(child.written[0] as string) as { message: { content: Array<{ text: string }> } };
    expect(frame.message.content[0].text).toBe(
      buildReviewPrompt(
        { id: 'c-1', comment: 'make it clearer', workflow: 'visual-spec', path: 'a.md', kind: 'file' },
        { mode: 'local' },
      ),
    );
  });

  it('carries the whole anchor into the prompt, not just the start line', async () => {
    const anchored: CommentRecord = {
      id: 'c-9',
      workflow: 'visual-spec',
      comment: 'name the audience',
      status: 'open',
      ts: '',
      target: { path: 'a.md', kind: 'range', startLine: 3, endLine: 5, snippet: 'first', endSnippet: 'last', heading: 'Intro' },
    };
    const child = liveChild();
    const hub = createReviewHub(() => deps({ comments: memoryStore([anchored]), spawnSession: () => child }), createRunLock());
    hub.start('c-9');
    await tick();

    const text = (JSON.parse(child.written[0] as string) as { message: { content: Array<{ text: string }> } }).message.content[0].text;
    expect(text).toContain('Where: Intro · lines 3–5');
    expect(text).toContain('From: "first"');
    expect(text).toContain('Through: "last"');
  });

  it('takes the prompt arm from the session ops, never from the request body (R-3.8)', async () => {
    // The origin picks the implementation; the implementation carries the arm. A route
    // body that could name a mode would be a fifth `if (mode === 'collab')` site.
    const child = liveChild();
    const collabOps = (get: () => ReviewDeps): ReviewSessionOps => ({
      ...createLocalSessionOps(get),
      promptMode: { mode: 'collab', documentPath: 'docs/x.json' },
    });
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock(), collabOps);
    hub.start('c-1');
    await tick();

    const text = (JSON.parse(child.written[0] as string) as { message: { content: Array<{ text: string }> } }).message.content[0].text;
    expect(text).toContain('docs/x.json');
    expect(handleReviewRequest(hub, { method: 'POST', pathname: '/start', body: {}, sse: fakeRes().res })).toMatchObject({ status: 400 });
  });

  it('the local arm reports itself as local', () => {
    expect(createLocalSessionOps(() => deps()).promptMode).toEqual({ mode: 'local' });
  });

  it('writes nothing to the workspace and leaves the comment open while proposing', async () => {
    // R-3.1 / R-3.2. The propose-phase no-write invariant is asserted against the *target*
    // file (spike 0.1: plan mode is workspace-scoped, and the CLI writes its own plan files
    // under ~/.claude/plans regardless), across a proposal actually arriving.
    const dir = mkdtempSync(join(tmpdir(), 'vs-review-start-'));
    try {
      const target = join(dir, 'a.md');
      writeFileSync(target, '# heading\n');
      const before = readFileSync(target);
      const store = memoryStore([rec('c-1')]);
      const child = liveChild();
      const hub = createReviewHub(() => ({ cwd: dir, comments: store, spawnSession: () => child, now: () => 1000 }), createRunLock());

      expect(hub.start('c-1')).toEqual({ status: 200, json: { ok: true } });
      await tick();
      child.emit(resultFrame(ENVELOPE));
      await tick();

      expect(readFileSync(target)).toEqual(before);
      expect((await store.read()).comments[0].status).toBe('open');
      expect((await store.read()).comments[0].result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * B1.4 — GET /__vs/review status (R-8.9)
 * ================================================================== */
describe('GET /__vs/review (R-8.9)', () => {
  const get = (hub: ReturnType<typeof createReviewHub>, pathname = '') =>
    handleReviewRequest(hub, { method: 'GET', pathname, body: {}, sse: fakeRes().res });

  it('reports no session before anything starts', () => {
    const hub = createReviewHub(() => deps(), createRunLock());
    expect(get(hub)).toEqual({ status: 200, json: { running: false, startedAt: null, commentId: null } });
  });

  it('reports the in-flight session so a reloaded tab can find it before subscribing', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    expect(get(hub)).toEqual({ status: 200, json: { running: true, startedAt: 1000, commentId: 'c-1' } });
  });

  it('stays a 200 snapshot once the session ends rather than a conflict (R-7.5)', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    hub.cancel();
    await tick();
    expect(get(hub)).toMatchObject({ status: 200, json: { running: false, commentId: 'c-1' } });
  });

  it('answers the same on the bare path and the trailing-slash path the two hosts produce', () => {
    // `md-plugin` mounts the middleware and connect hands the handler '/', `server.ts`
    // slices the prefix and hands it ''. Both must reach the same snapshot (R-8.2).
    const hub = createReviewHub(() => deps(), createRunLock());
    expect(get(hub, '/')).toEqual(get(hub, ''));
  });

  it('does not swallow the event stream or a POST on the bare path', () => {
    const hub = createReviewHub(() => deps(), createRunLock());
    expect(get(hub, '/events')).toEqual({ streamed: true });
    expect(handleReviewRequest(hub, { method: 'POST', pathname: '', body: {}, sse: fakeRes().res })).toMatchObject({ status: 404 });
  });
});

/* ================================================================== *
 * B3.1 — iterative refinement (R-5.1…R-5.4)
 * ================================================================== */
/** A distinct patch per turn, so "the proposal changed" is visible rather than asserted. */
const patchN = (n: number) => `diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-# heading\n+# heading v${n}\n`;

describe('follow-up turns refine the proposal (R-5.1, R-5.2, R-5.3)', () => {
  it('carries several turns inside one session, each answered by a whole new envelope', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();

    child.emit(resultFrame({ ...ENVELOPE, patch: patchN(1) }));
    await tick();
    expect(hub.message('shorter please')).toEqual({ status: 200, json: { ok: true } });
    child.emit(resultFrame({ ...ENVELOPE, patch: patchN(2) }));
    await tick();
    expect(hub.message('actually, name the audience')).toEqual({ status: 200, json: { ok: true } });
    child.emit(resultFrame({ ...ENVELOPE, patch: patchN(3) }));
    await tick();

    // R-5.1: every turn went down the in-channel — the opening prompt plus the two
    // follow-ups, in order, on the one live child.
    expect(child.written).toHaveLength(3);
    expect(child.written[1]).toBe(userTurnFrame('shorter please'));
    expect(child.written[2]).toBe(userTurnFrame('actually, name the audience'));
    // R-5.2 / R-5.3: and each one came back as a full envelope, not an amendment.
    const patches = (sub.frames().filter((f) => f.type === 'proposal') as Array<{ proposal: Proposal }>).map((f) => f.proposal.patch);
    expect(patches).toEqual([patchN(1), patchN(2), patchN(3)]);
    // The session is still alive after three turns — it is not consumed by its first answer.
    expect(hub.snapshot()).toMatchObject({ running: true, commentId: 'c-1' });
  });

  it('supersedes the previous proposal rather than accumulating them (R-6.2)', async () => {
    // Which envelope is "the latest" is settled here, because approval applies exactly one.
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const hist = fakeRes();
    hub.subscribe(hist.res);
    hub.start('c-1');
    await tick();
    child.emit(resultFrame({ ...ENVELOPE, patch: patchN(1) }));
    await tick();
    hub.message('shorter please');
    child.emit(resultFrame({ ...ENVELOPE, patch: patchN(2) }));
    await tick();

    // A tab joining now replays both, and the *last* one is what approval means (R-6.2).
    const late = fakeRes();
    hub.subscribe(late.res);
    const replayed = ((late.frames()[0] as ReviewSync).events.filter((e) => e.type === 'proposal') as Array<{ proposal: Proposal }>);
    expect(replayed.map((p) => p.proposal.patch)).toEqual([patchN(1), patchN(2)]);
  });

  it('keeps the latest proposal when a later turn produces no envelope', async () => {
    // A question ("why that approach?") answers in prose and pins nothing. It must not
    // erase the proposal already on the table — approval would then have nothing to apply
    // even though the user is looking at a patch.
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    child.emit(resultFrame(ENVELOPE));
    await tick();
    hub.message('why that approach?');
    child.emit(JSON.stringify({ type: 'result', result: 'Because the heading is the first thing read.' }));
    await tick();

    // Still an approvable proposal — `no-proposal` here would mean the prose turn cleared it.
    expect(hub.approve()).toMatchObject({ status: 501, json: { code: 'not-implemented' } });
  });
});

describe('the session says when it is waiting (R-5.4)', () => {
  it('enters awaiting-input at the end of a turn and returns to proposing on the next one', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();
    expect(hub.snapshot().phase).toBe('proposing');

    child.emit(resultFrame(ENVELOPE));
    await tick();
    expect(hub.snapshot().phase).toBe('awaiting-input');
    // Said out loud on the stream, not left as the absence of activity…
    expect(sub.frames()).toContainEqual({ type: 'awaiting-input' });
    // …and after the turn's own frames, so the proposal is on screen before the wait.
    const frames = sub.frames();
    expect(frames.findIndex((f) => f.type === 'awaiting-input')).toBeGreaterThan(frames.findIndex((f) => f.type === 'proposal'));

    hub.message('shorter please');
    expect(hub.snapshot().phase).toBe('proposing');
    child.emit(resultFrame({ ...ENVELOPE, strategy: 'Shorter.' }));
    await tick();
    expect(hub.snapshot().phase).toBe('awaiting-input');
    expect(sub.frames().filter((f) => f.type === 'awaiting-input')).toHaveLength(2);
  });

  it('emits one awaiting-input per turn, not one per prose result line', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();
    child.emit(resultFrame(ENVELOPE));
    child.emit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'anything else?' }] } }));
    await tick();
    expect(sub.frames().filter((f) => f.type === 'awaiting-input')).toHaveLength(1);
  });

  it('applies nothing across a whole refine loop (R-5.4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-review-refine-'));
    try {
      const target = join(dir, 'a.md');
      writeFileSync(target, '# heading\n\nbody\n');
      const before = readFileSync(target);
      const store = memoryStore([rec('c-1')]);
      const child = liveChild();
      const hub = createReviewHub(() => ({ cwd: dir, comments: store, spawnSession: () => child, now: () => 1000 }), createRunLock());

      hub.start('c-1');
      // This hub locates its target on the real filesystem, so the opening turn — and with
      // it the piped stdout — lands some ticks after `start` returns.
      await until(() => child.written.length === 1);
      for (const n of [1, 2, 3]) {
        child.emit(resultFrame({ ...ENVELOPE, patch: patchN(n) }));
        await until(() => hub.snapshot().phase === 'awaiting-input');
        // …the patch is *described*, never run: the file is checked while the session waits.
        expect(readFileSync(target)).toEqual(before);
        hub.message(`turn ${n}`);
      }
      expect(readFileSync(target)).toEqual(before);
      expect((await store.read()).comments[0]).toMatchObject({ status: 'open' });
      expect((await store.read()).comments[0].result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== *
 * B5.1 — abandonment, the dead-child race, ephemerality (R-7.3, R-7.5…R-7.8)
 * ================================================================== */
describe('an abandoned session releases the slot (R-7.6, R-7.8)', () => {
  it('arms the bound when a session runs with nobody watching, at the 15-minute default', () => {
    const timers = fakeTimers();
    const hub = createReviewHub(() => deps({ spawnSession: () => liveChild(), ...timers }), createRunLock());
    expect(timers.armed()).toBe(0); // nothing to reap before a session exists
    hub.start('c-1');
    expect(timers.armed()).toBe(1);
    expect(timers.delay()).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it('terminates the child and frees the slot when the bound elapses', async () => {
    const timers = fakeTimers();
    const lock = createRunLock();
    const child = liveChild();
    let killed: string | undefined;
    const watched = { ...child, kill: (sig?: string) => { killed = sig; } } as unknown as ReviewChild;
    const hub = createReviewHub(() => deps({ spawnSession: () => watched, idleTimeoutMs: 1000, ...timers }), lock);
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();
    sub.close(); // the only tab goes away

    expect(timers.delay()).toBe(1000);
    timers.fire();

    expect(killed).toBe('SIGKILL');
    expect(lock.heldBy()).toBe(null);
    expect(hub.snapshot()).toMatchObject({ running: false, phase: 'ended' });
    // Reported as its own reason: nobody cancelled and nothing crashed. The dropped tab
    // is gone by then, so the frame is read where a returning one would find it.
    const rejoined = fakeRes();
    hub.subscribe(rejoined.res);
    expect((rejoined.frames()[0] as ReviewSync).events.at(-1)).toEqual({ type: 'ended', ok: false, reason: 'idle' });
  });

  it('does not reap a session someone is watching, and re-arms when the last tab drops', async () => {
    const timers = fakeTimers();
    const hub = createReviewHub(() => deps({ spawnSession: () => liveChild(), ...timers }), createRunLock());
    const a = fakeRes();
    const b = fakeRes();
    hub.subscribe(a.res);
    hub.start('c-1');
    await tick();
    expect(timers.armed()).toBe(0); // a client is watching

    hub.subscribe(b.res);
    a.close();
    expect(timers.armed()).toBe(0); // the second tab still holds it open
    b.close();
    expect(timers.armed()).toBe(1); // …and now nobody does
    hub.subscribe(a.res);
    expect(timers.armed()).toBe(0); // a reconnecting tab cancels the reap
  });

  it('input restarts the bound rather than letting a stale one fire', async () => {
    const timers = fakeTimers();
    const hub = createReviewHub(() => deps({ spawnSession: () => liveChild(), ...timers }), createRunLock());
    hub.start('c-1');
    await tick();
    const first = timers.id();
    hub.message('still here');
    expect(timers.armed()).toBe(1);
    expect(timers.id()).not.toBe(first);
  });

  it('clears the bound on a normal exit, so no timer outlives the session', async () => {
    const timers = fakeTimers();
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child, ...timers }), createRunLock());
    hub.start('c-1');
    await tick();
    expect(timers.armed()).toBe(1);
    hub.cancel();
    await tick();
    expect(timers.armed()).toBe(0);
  });
});

describe('the dead-child race (R-7.7)', () => {
  it('answers a follow-up turn on a broken in-channel as an ended session, not a crash', async () => {
    const lock = createRunLock();
    const hub = createReviewHub(() => deps({ spawnSession: () => brokenPipeChild() }), lock);
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start('c-1');
    await tick();

    expect(hub.message('shorter please')).toEqual({
      status: 409,
      json: { error: 'the review session has ended', code: 'session-ended' },
    });
    // …and the slot went back rather than being wedged by the broken pipe (R-7.8).
    expect(lock.heldBy()).toBe(null);
    expect(sub.frames()).toContainEqual({ type: 'error', message: 'could not deliver the turn: write EPIPE' });
  });

  it('distinguishes a dead session from no session on both message and approve', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    child.emit(resultFrame(ENVELOPE));
    await tick();
    child.kill?.('SIGKILL');
    await tick();
    await tick();

    // Same 409 either way, but a code the UI can act on: "your session died" ≠ "there
    // was never one" — and approve does not fall through to the 501 write path.
    for (const call of [() => hub.message('x'), () => hub.approve()]) {
      expect(call()).toEqual({ status: 409, json: { error: 'the review session has ended', code: 'session-ended' } });
    }
    expect(createReviewHub(() => deps(), createRunLock()).message('x')).toMatchObject({ json: { code: 'no-session' } });
  });
});

describe('with no session, only message/approve/cancel conflict (R-7.5)', () => {
  const call = (hub: ReturnType<typeof createReviewHub>, method: string, pathname: string, body: Record<string, unknown> = {}) =>
    handleReviewRequest(hub, { method, pathname, body, sse: fakeRes().res });

  it('leaves start, the status endpoint and the event stream callable', () => {
    const hub = createReviewHub(() => deps({ spawnSession: () => liveChild() }), createRunLock());
    expect(call(hub, 'GET', '')).toEqual({ status: 200, json: { running: false, startedAt: null, commentId: null } });
    expect(call(hub, 'GET', '/events')).toEqual({ streamed: true });
    expect(call(hub, 'POST', '/start', { commentId: 'c-1' })).toEqual({ status: 200, json: { ok: true } });
  });

  it('still refuses the three that need one after a session has ended', async () => {
    const child = liveChild();
    const hub = createReviewHub(() => deps({ spawnSession: () => child }), createRunLock());
    hub.start('c-1');
    await tick();
    hub.cancel();
    for (const path of ['/message', '/approve', '/cancel']) {
      expect(call(hub, 'POST', path, { text: 'x' })).toMatchObject({ status: 409, json: { code: 'session-ended' } });
    }
    // …while the status endpoint keeps answering with a snapshot (R-7.5, second sentence).
    expect(call(hub, 'GET', '')).toMatchObject({ status: 200 });
  });
});

describe('session state is memory-only (R-7.3)', () => {
  it('does not survive a restart — a hub rebuilt over the same store starts blank', async () => {
    const store = memoryStore([rec('c-1')]);
    const lock = createRunLock();
    const child = liveChild();
    const hub = createReviewHub(() => deps({ comments: store, spawnSession: () => child }), lock);
    hub.start('c-1');
    await tick();
    child.emit(resultFrame(ENVELOPE));
    await tick();
    expect(hub.approve()).toMatchObject({ status: 501 }); // there *is* a proposal in flight

    // The process goes away mid-review: the child dies, and a new server builds new hubs.
    child.kill?.('SIGKILL');
    await tick();
    await tick();
    const restarted = createReviewHub(() => deps({ comments: store, spawnSession: () => liveChild() }), lock);

    expect(restarted.snapshot()).toEqual({ running: false, phase: 'idle', commentId: null, startedAt: null });
    // No proposal survived — the follow-on hub has nothing to approve, and says so as
    // "no session" rather than "no proposal yet", because the session itself is gone.
    expect(restarted.approve()).toMatchObject({ json: { code: 'no-session' } });
    const sub = fakeRes();
    restarted.subscribe(sub.res);
    expect((sub.frames()[0] as ReviewSync).events).toEqual([]);
    // …and nothing about the in-flight proposal was ever written to the sidecar (R-6.7).
    expect((await store.read()).comments).toEqual([rec('c-1')]);
  });
});
