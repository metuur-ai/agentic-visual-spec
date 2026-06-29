import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { type ApplyEvent, type ClaudeChild, runApply, summarize } from './apply';
import type { CommentDocStore } from './comments';

function rec(id: string, status: 'open' | 'applied' = 'open'): CommentRecord {
  return { id, workflow: 'visual-spec', target: { path: 'a.md', kind: 'file' }, comment: 'x', status, ts: '' };
}

/** A store whose document can be swapped mid-run to mimic the skill flipping statuses. */
function memoryStore(initial: CommentRecord[]): { store: CommentDocStore; set: (c: CommentRecord[]) => void } {
  let doc: CommentDoc = { version: 1, comments: initial };
  return {
    store: { async read() { return doc; }, async write(d) { doc = d; } },
    set: (c) => { doc = { version: 1, comments: c }; },
  };
}

/** A fake claude child: emits the given stream-json lines, then closes with `code`. */
function fakeChild(lines: string[], code: number, onClose: () => void): ClaudeChild {
  const stdout = Readable.from([lines.map((l) => `${l}\n`).join('')]);
  const ee = new EventEmitter();
  stdout.on('end', () => {
    onClose();
    setImmediate(() => ee.emit('close', code));
  });
  return {
    stdout,
    stderr: null,
    on: (event: string, cb: (arg: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
  } as ClaudeChild;
}

describe('summarize', () => {
  it('maps tool_use blocks to a friendly line', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.md' } }] } });
    expect(summarize(line)).toEqual({ type: 'log', level: 'assistant', text: '→ Edit a.md' });
  });
  it('ignores non-JSON / unrelated lines', () => {
    expect(summarize('not json')).toBeNull();
    expect(summarize(JSON.stringify({ type: 'user' }))).toBeNull();
  });
});

describe('runApply', () => {
  it('no open comments → no-op done', async () => {
    const { store } = memoryStore([rec('c-1', 'applied')]);
    const events: ApplyEvent[] = [];
    await runApply({ cwd: '/tmp', comments: store, spawnClaude: () => { throw new Error('should not spawn'); } }, (e) => events.push(e));
    expect(events).toEqual([{ type: 'done', ok: true, applied: 0, exitCode: 0 }]);
  });

  it('spawns claude, streams logs, then counts what flipped to applied', async () => {
    const mem = memoryStore([rec('c-1'), rec('c-2')]);
    const events: ApplyEvent[] = [];
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.md' } }] } }),
      JSON.stringify({ type: 'result', result: 'Applied 1 comment.' }),
    ];
    await runApply(
      {
        cwd: '/tmp',
        comments: mem.store,
        // When claude "runs", it flips c-1 to applied (c-2 stays open).
        spawnClaude: () => fakeChild(lines, 0, () => mem.set([rec('c-1', 'applied'), rec('c-2')])),
      },
      (e) => events.push(e),
    );

    expect(events[0]).toEqual({ type: 'start', openCount: 2 });
    expect(events.some((e) => e.type === 'log' && e.text === '→ Edit a.md')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', ok: true, applied: 1, exitCode: 0 });
  });

  it('SIGKILLs and reports when claude exceeds the timeout', async () => {
    const mem = memoryStore([rec('c-1')]);
    const events: ApplyEvent[] = [];
    // A child that never closes on its own; only kill() ends it.
    const hung = (): ClaudeChild => {
      const ee = new EventEmitter();
      return {
        stdout: new Readable({ read() {} }), // stays open
        stderr: null,
        on: (event: string, cb: (a: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
        kill: () => setImmediate(() => ee.emit('close', null)),
      } as ClaudeChild;
    };
    await runApply({ cwd: '/tmp', comments: mem.store, spawnClaude: hung, timeoutMs: 20 }, (e) => events.push(e));
    expect(events.some((e) => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
  });

  it('reports a non-zero exit as not-ok', async () => {
    const mem = memoryStore([rec('c-1')]);
    const events: ApplyEvent[] = [];
    await runApply(
      { cwd: '/tmp', comments: mem.store, spawnClaude: () => fakeChild([], 1, () => {}) },
      (e) => events.push(e),
    );
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, applied: 0, exitCode: 1 });
  });
});
