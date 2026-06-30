import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../../editing/comment-doc';
import { type ApplyEvent, type ClaudeChild, createApplyHub, runApply, summarize } from './apply';
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

/** A child that never ends on its own — only kill() closes it. */
function hungChild(): ClaudeChild {
  const ee = new EventEmitter();
  return {
    stdout: new Readable({ read() {} }),
    stderr: null,
    on: (event: string, cb: (a: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
    kill: () => setImmediate(() => ee.emit('close', null)),
  } as ClaudeChild;
}

describe('summarize', () => {
  it('maps a tool_use block to a structured tool row', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.md' } }] } });
    expect(summarize(line)).toEqual([{ type: 'log', kind: 'tool', tool: 'Edit', target: 'a.md' }]);
  });
  it('maps a text block to an assistant row and the result to a result row', () => {
    expect(summarize(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }))).toEqual([
      { type: 'log', kind: 'assistant', text: 'thinking' },
    ]);
    expect(summarize(JSON.stringify({ type: 'result', result: 'done' }))).toEqual([{ type: 'log', kind: 'result', text: 'done' }]);
  });
  it('ignores non-JSON / unrelated lines', () => {
    expect(summarize('not json')).toEqual([]);
    expect(summarize(JSON.stringify({ type: 'user' }))).toEqual([]);
  });

  it('maps a Task tool_use to an agent-start lane (type + task), not a plain tool row', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { subagent_type: 'code-reviewer', description: 'review login' } }] },
    });
    expect(summarize(line)).toEqual([{ type: 'agent-start', agentId: 'toolu_1', agentType: 'code-reviewer', task: 'review login' }]);
  });

  it('tags a sub-agent tool_use with its parent agentId', () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'validate' } }] },
    });
    expect(summarize(line)).toEqual([{ type: 'log', kind: 'tool', tool: 'Grep', target: 'validate', agentId: 'toolu_1' }]);
  });

  it('maps a tool_result (user event) to agent-done', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } });
    expect(summarize(line)).toEqual([{ type: 'agent-done', agentId: 'toolu_1' }]);
  });
});

describe('runApply', () => {
  it('no open comments → no-op done', async () => {
    const { store } = memoryStore([rec('c-1', 'applied')]);
    const events: ApplyEvent[] = [];
    await runApply({ cwd: '/tmp', comments: store, spawnClaude: () => { throw new Error('should not spawn'); } }, (e) => events.push(e));
    expect(events).toEqual([{ type: 'done', ok: true, applied: 0, appliedComments: [], exitCode: 0 }]);
  });

  it('spawns claude, streams structured logs, then counts what flipped to applied', async () => {
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
        now: () => 1000,
        // When claude "runs", it flips c-1 to applied (c-2 stays open).
        spawnClaude: () => fakeChild(lines, 0, () => mem.set([rec('c-1', 'applied'), rec('c-2')])),
      },
      (e) => events.push(e),
    );

    expect(events[0]).toEqual({ type: 'start', openCount: 2, startedAt: 1000 });
    expect(events.some((e) => e.type === 'log' && e.kind === 'tool' && e.tool === 'Edit' && e.target === 'a.md')).toBe(true);
    expect(events.at(-1)).toEqual({
      type: 'done',
      ok: true,
      applied: 1,
      appliedComments: [{ id: 'c-1', path: 'a.md', comment: 'x', workflow: 'visual-spec' }],
      exitCode: 0,
    });
  });

  it('ids scopes the run: only the picked comment is prompted, counted, and applied', async () => {
    // Two open comments; the user picks only c-2. The fake "applies" whatever it was
    // asked to (we flip c-2), and the diff must ignore c-1 entirely.
    const mem = memoryStore([rec('c-1'), rec('c-2')]);
    const events: ApplyEvent[] = [];
    let prompted = '';
    await runApply(
      {
        cwd: '/tmp',
        comments: mem.store,
        now: () => 1000,
        spawnClaude: (prompt) => {
          prompted = prompt;
          return fakeChild([], 0, () => mem.set([rec('c-1'), rec('c-2', 'applied')]));
        },
      },
      (e) => events.push(e),
      undefined,
      ['c-2'],
    );

    expect(prompted).toContain('1 review comment'); // scoped to one, not two
    expect(events[0]).toEqual({ type: 'start', openCount: 1, startedAt: 1000 });
    expect(events.at(-1)).toEqual({
      type: 'done',
      ok: true,
      applied: 1,
      appliedComments: [{ id: 'c-2', path: 'a.md', comment: 'x', workflow: 'visual-spec' }],
      exitCode: 0,
    });
  });

  it('SIGKILLs and reports when claude exceeds the timeout', async () => {
    const mem = memoryStore([rec('c-1')]);
    const events: ApplyEvent[] = [];
    await runApply({ cwd: '/tmp', comments: mem.store, spawnClaude: hungChild, timeoutMs: 20 }, (e) => events.push(e));
    expect(events.some((e) => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
  });

  it('cancels via AbortSignal → done is marked cancelled', async () => {
    const mem = memoryStore([rec('c-1')]);
    const events: ApplyEvent[] = [];
    const ac = new AbortController();
    const p = runApply({ cwd: '/tmp', comments: mem.store, spawnClaude: hungChild }, (e) => events.push(e), ac.signal);
    setImmediate(() => ac.abort());
    await p;
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, cancelled: true });
  });

  it('reports a non-zero exit as not-ok', async () => {
    const mem = memoryStore([rec('c-1')]);
    const events: ApplyEvent[] = [];
    await runApply({ cwd: '/tmp', comments: mem.store, spawnClaude: () => fakeChild([], 1, () => {}) }, (e) => events.push(e));
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, applied: 0, appliedComments: [], exitCode: 1 });
  });
});

describe('createApplyHub', () => {
  it('start → 409 while running → status reflects the run', async () => {
    const mem = memoryStore([rec('c-1')]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = (): ClaudeChild => {
      const ee = new EventEmitter();
      void gate.then(() => ee.emit('close', 0));
      return {
        stdout: new Readable({ read() {} }),
        stderr: null,
        on: (event: string, cb: (a: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
      } as ClaudeChild;
    };
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: mem.store, spawnClaude: slow }));

    expect(hub.start().status).toBe(200);
    // Let the start event flush so `running` is true.
    await new Promise((r) => setImmediate(r));
    expect((hub.status().json as { running: boolean }).running).toBe(true);
    expect(hub.start().status).toBe(409); // already running

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect((hub.status().json as { running: boolean }).running).toBe(false);
  });

  it('cancel with no run in flight → 409', () => {
    const mem = memoryStore([]);
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: mem.store }));
    expect(hub.cancel().status).toBe(409);
  });
});
