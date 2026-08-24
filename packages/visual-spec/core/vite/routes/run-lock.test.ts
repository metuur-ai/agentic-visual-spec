import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { type ClaudeChild, createApplyHub } from './apply';
import type { CommentDocStore } from './comments';
import { conflictFor, createRunLock } from './run-lock';

function rec(id: string): CommentRecord {
  return { id, workflow: 'visual-spec', target: { path: 'a.md', kind: 'file' }, comment: 'x', status: 'open', ts: '' };
}

function memoryStore(initial: CommentRecord[]): CommentDocStore {
  let doc: CommentDoc = { version: 1, comments: initial };
  return { async read() { return doc; }, async write(d) { doc = d; } };
}

/** A child that never ends on its own, so a run stays in flight for the assertions. */
function hungChild(): ClaudeChild {
  const ee = new EventEmitter();
  return {
    stdout: new Readable({ read() {} }),
    stderr: null,
    on: (event: string, cb: (arg: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
    kill: () => setImmediate(() => ee.emit('close', 143)),
  } as ClaudeChild;
}

/* ================================================================== *
 * R-8.5 — one shared lock, so review and apply are actually exclusive
 * ================================================================== */
describe('RunLock', () => {
  it('grants the first holder and refuses the second', () => {
    const lock = createRunLock();
    expect(lock.acquire('apply')).toBe(true);
    expect(lock.acquire('review')).toBe(false);
    expect(lock.heldBy()).toBe('apply');
  });

  it('releases only for the holder that took it', () => {
    const lock = createRunLock();
    lock.acquire('review');
    lock.release('apply'); // not the holder — must be a no-op
    expect(lock.heldBy()).toBe('review');
    lock.release('review');
    expect(lock.heldBy()).toBe(null);
  });

  it('is re-acquirable after release', () => {
    const lock = createRunLock();
    lock.acquire('apply');
    lock.release('apply');
    expect(lock.acquire('review')).toBe(true);
  });

  it('names the holder in the conflict body so the UI can message correctly', () => {
    expect(conflictFor('apply')).toEqual({ status: 409, json: { error: 'an apply is already running', holder: 'apply' } });
    expect(conflictFor('review')).toEqual({ status: 409, json: { error: 'a review session is already running', holder: 'review' } });
  });
});

/* ================================================================== *
 * R-3.4 / R-8.4 / R-8.5 — ApplyHub consults the shared lock
 * ================================================================== */
describe('createApplyHub + shared RunLock', () => {
  it('409s naming the review holder when a review session holds the lock', () => {
    const lock = createRunLock();
    lock.acquire('review');
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: memoryStore([rec('c-1')]) }), lock);

    const r = hub.start();
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'a review session is already running', holder: 'review' });
  });

  it('proceeds once the review releases the lock', async () => {
    const lock = createRunLock();
    lock.acquire('review');
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: memoryStore([rec('c-1')]), spawnClaude: () => hungChild() }), lock);

    expect(hub.start().status).toBe(409);
    lock.release('review');
    expect(hub.start().status).toBe(200);
    expect(lock.heldBy()).toBe('apply');

    hub.cancel();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('holds the lock for the duration of a run and releases it on completion', async () => {
    const lock = createRunLock();
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: memoryStore([rec('c-1')]), spawnClaude: () => hungChild() }), lock);

    expect(hub.start().status).toBe(200);
    expect(lock.heldBy()).toBe('apply');
    // A second apply is refused by the same lock, naming apply as the holder.
    expect(hub.start()).toEqual({ status: 409, json: { error: 'an apply is already running', holder: 'apply' } });

    hub.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(lock.heldBy()).toBe(null);
  });

  it('releases the lock when a run ends with no open comments (the no-op path)', async () => {
    const lock = createRunLock();
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: memoryStore([]) }), lock);

    expect(hub.start().status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(lock.heldBy()).toBe(null);
  });

  it('defaults to the process-wide shared lock when none is injected', () => {
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: memoryStore([rec('c-1')]) }));
    expect(hub.start().status).toBe(200);
  });
});
