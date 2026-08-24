/**
 * apply-invariants.test.ts — GUARD TESTS (story B7.1). DO NOT RELAX.
 *
 * WHAT THIS PINS
 * --------------
 * Two invariants of the SHIPPED product that the interactive-review work is
 * uniquely well placed to break by accident, because review is built next to
 * both of them and shares a lock and a comment model with them.
 *
 *   R-3.9 — the interactive review session is offered for SINGLE comments only.
 *           Bulk apply stays one-shot: no proposal, no approval, no gate between
 *           pressing the button and the run starting. The shared `RunLock` is the
 *           only thing the review path is allowed to touch on this flow.
 *
 *   R-6.7 — `CommentStatus` stays the two-value union `open | applied`. No
 *           intermediate value ("proposed", "reviewing", …) may reach either
 *           store: the local sidecar `visual-spec-comments.json`, or a GitHub
 *           comment body via `formatCommentBody` / `parseCommentBody` /
 *           `CommentTrailer`. In-flight review state lives in the hub, not on
 *           the record.
 *
 * These are CHARACTERIZATION guards: if a change makes one fail, the change is
 * wrong, not the test. See docs/ears/inline-indicators-interactive-apply.md.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type CommentDoc,
  type CommentRecord,
  type CommentStatus,
  parseDoc,
  serializeDoc,
} from '../../editing/comment-doc';
import { createGitHubAdapter } from '../../collaboration/github-adapter';
import type { GhExecutor, GhResult } from '../../collaboration/github-executor';
import {
  type ProjectedCommentRecord,
  formatCommentBody,
  githubCommentStore,
  parseCommentBody,
  projectIssueComment,
} from '../../collaboration/comment-projection';
import { type ApplyEvent, type ClaudeChild, createApplyHub, runApply } from './apply';
import { type CommentDocStore, handleCommentsRequest } from './comments';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function rec(id: string, status: CommentStatus = 'open'): CommentRecord {
  return { id, workflow: 'visual-spec', target: { path: 'a.md', kind: 'file' }, comment: 'x', status, ts: '' };
}

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

/* ================================================================== *
 * R-3.9 — bulk apply is one-shot; only the RunLock couples it to review
 * ================================================================== */
describe('R-3.9 — bulk apply has no proposal or approval step', () => {
  const applySrc = src('./apply.ts');

  it('the ApplyHub surface is exactly subscribe/start/cancel/status', () => {
    const mem = memoryStore([]);
    const hub = createApplyHub(() => ({ cwd: '/tmp', comments: mem.store }));
    // A proposal/approval flow could not exist without a method to carry it.
    expect(Object.keys(hub).sort()).toEqual(['cancel', 'start', 'status', 'subscribe']);
  });

  it('one start call drives the whole run — the child spawns with no intervening approval', async () => {
    const mem = memoryStore([rec('c-1')]);
    let spawned = 0;
    const hub = createApplyHub(() => ({
      cwd: '/tmp',
      comments: mem.store,
      spawnClaude: () => {
        spawned++;
        return fakeChild([], 0, () => mem.set([rec('c-1', 'applied')]));
      },
    }));

    expect(hub.start().status).toBe(200);
    // Nothing else is called. If the flow ever grew a gate, the run would stall here.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(spawned).toBe(1);
    expect((hub.status().json as { running: boolean }).running).toBe(false);
    expect((await mem.store.read()).comments[0]!.status).toBe('applied');
  });

  it('a run emits only the shipped frame types — no proposal/approval frames', async () => {
    const mem = memoryStore([rec('c-1')]);
    const events: ApplyEvent[] = [];
    await runApply(
      {
        cwd: '/tmp',
        comments: mem.store,
        now: () => 1000,
        spawnClaude: () => fakeChild([JSON.stringify({ type: 'system', subtype: 'init' })], 0, () => mem.set([rec('c-1', 'applied')])),
      },
      (e) => events.push(e),
    );

    const shipped = ['start', 'log', 'agent-start', 'agent-done', 'done', 'error'];
    expect([...new Set(events.map((e) => e.type))].every((t) => shipped.includes(t))).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('apply.ts carries no proposal/approval vocabulary at all', () => {
    expect(applySrc).not.toMatch(/propose|proposal|approve|approval|awaiting-input|drift/i);
  });

  it('the RunLock is the only coupling between apply.ts and the review path', () => {
    // `run-lock.ts` — and nothing else from the review side — may be imported here.
    const imports = [...applySrc.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      'node:child_process',
      'node:http',
      '../../editing/comment-doc',
      '../../editing/apply-prompt',
      './comments',
      './run-lock',
    ]);
    expect(applySrc).not.toContain("from './review'");
    expect(applySrc).not.toMatch(/review-prompt|ReviewHub|ReviewSessionOps/);
  });
});

/* ================================================================== *
 * R-6.7 — CommentStatus stays `open | applied` in BOTH stores
 * ================================================================== */
describe('R-6.7 — no third status value reaches either store', () => {
  const THIRD = 'proposed'; // the value a proposal step would want to persist

  it('the union itself is two values', () => {
    expect(src('../../editing/comment-doc.ts')).toContain("export type CommentStatus = 'open' | 'applied';");
  });

  /* ---- store 1: the local sidecar, visual-spec-comments.json ---- */

  it('the sidecar route refuses a third status — nothing is written and it never round-trips', async () => {
    const mem = memoryStore([rec('c-aabbccdd')]);
    const before = serializeDoc(await mem.store.read());

    const res = await handleCommentsRequest(mem.store, 'PATCH', '/c-aabbccdd', {}, { status: THIRD });

    expect(res.status).toBe(400);
    // Byte-identical: no partial write, no third value on disk.
    expect(serializeDoc(await mem.store.read())).toBe(before);
    expect(parseDoc(serializeDoc(await mem.store.read())).comments[0]!.status).toBe('open');
  });

  it('the sidecar route still accepts exactly the two real values', async () => {
    const mem = memoryStore([rec('c-aabbccdd')]);
    expect((await handleCommentsRequest(mem.store, 'PATCH', '/c-aabbccdd', {}, { status: 'applied' })).status).toBe(200);
    expect((await mem.store.read()).comments[0]!.status).toBe('applied');
    expect((await handleCommentsRequest(mem.store, 'PATCH', '/c-aabbccdd', {}, { status: 'open' })).status).toBe(200);
    expect((await mem.store.read()).comments[0]!.status).toBe('open');
  });

  it('a bulk run only ever stamps `applied` — it cannot introduce an in-progress status', async () => {
    const mem = memoryStore([rec('c-1')]);
    await runApply(
      { cwd: '/tmp', comments: mem.store, spawnClaude: () => fakeChild([], 0, () => mem.set([rec('c-1', 'applied')])) },
      () => {},
    );
    for (const c of (await mem.store.read()).comments) expect(['open', 'applied']).toContain(c.status);
  });

  /* ---- store 2: the GitHub comment body (trailer channel) ---- */

  it('a trailer carrying a third status cannot inject it — the projection is always `open`', () => {
    const body = formatCommentBody('Tighten this.', { documentId: 'doc-1', nodeId: 'n-7', status: THIRD });
    // The trailer round-trips as data (R-5.6: unknown keys survive)…
    expect(parseCommentBody(body).trailer?.status).toBe(THIRD);
    // …but it is never read as the record's status.
    const projected = projectIssueComment(
      { id: 700001, body, user: 'rita', htmlUrl: 'https://example.invalid/1', createdAt: 'T', updatedAt: 'T' },
      'docs/spec.md',
    );
    expect(projected.status).toBe('open');
    expect(['open', 'applied']).toContain(projected.status);
  });

  it('patching a third status through the GitHub store writes nothing to GitHub', async () => {
    const listed = JSON.stringify([
      {
        id: 700001,
        body: 'Tighten this paragraph.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->',
        user: { login: 'reviewer-rita' },
        created_at: 'T',
        updated_at: 'T',
        html_url: 'https://example.invalid/1',
      },
    ]);
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec: GhExecutor = async (args, input) => {
      calls.push(input === undefined ? { args } : { args, input });
      return { stdout: listed, stderr: '', exitCode: 0 } as GhResult;
    };
    const store = githubCommentStore({
      adapter: createGitHubAdapter(exec),
      repo: { owner: 'acme', repo: 'docs' },
      pullNumber: 42,
      documentId: 'doc-1',
      documentPath: 'docs/spec.md',
    });

    const id = (await store.read()).comments[0]!.id;
    const patched = (await store.updateComment!(id, { status: THIRD as CommentStatus })) as ProjectedCommentRecord;

    expect(patched.status).toBe('open');
    // Only reads. Nothing carried a request body, so no comment body was ever written.
    expect(calls.every((c) => c.input === undefined)).toBe(true);
    // And the trailer — the only durable channel on a GitHub comment — holds no status.
    expect(patched.collab.status).toBeUndefined();
  });
});
