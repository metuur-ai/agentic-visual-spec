/**
 * review-session-collab.test.ts — EARS Unit 9, the collaborative review session.
 *
 * Written against the EARS statements: R-8.8 / R-9.1 (the record arrives on the request
 * and the sidecar is never touched), R-9.2 / R-9.3 (node lookup, no ladder; no node id is
 * document-level), R-9.4 (writes confined to the canonical document), R-9.7 (the branch
 * head pin), R-9.5 / R-9.6 (no status on disk, `ready-to-publish`, no publish), R-9.10 /
 * R-9.11 (the reply on the conversation, and the projection staying `open`), R-9.9 (a
 * cancelled session leaves the document alone).
 *
 * NOTHING HERE EXECS `gh`, `git` OR `claude`. The adapter is a fake, the child is a fake,
 * and the one `git apply` that runs writes into a scratch repository this file builds.
 */
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultExecGit } from '../git-context';
import type { Proposal } from '../editing/review-prompt';
import { createReviewHub, type ReviewChild, type ReviewDeps, type ReviewEvent, type ReviewSync } from '../vite/routes/review';
import { createRunLock } from '../vite/routes/run-lock';
import type { CommentDocStore } from '../vite/routes/comments';
import type { GitHubAdapter } from './github-adapter';
import type { CollaborationRecord } from './document-record';
import type { CollaborationStore } from './record-store';
import { projectReviewThread, type ReviewThread } from './review-comments';
import {
  admitPatchFor,
  createCollabSessionOps,
  createReviewSessionOpsSelector,
  documentHasNode,
  parseCollabStart,
  patchPaths,
} from './review-session-collab';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const DOC_PATH = 'specs/onboarding.md';

function record(over: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    documentId: 'doc-1',
    documentPath: DOC_PATH,
    title: 'Onboarding',
    markdown: '# Onboarding\n\nThe first screen asks for an email.\n',
    github: { owner: 'acme', repo: 'specs', branch: 'vs/doc-1', pullNumber: 7, headSha: 'sha-1', resolved: true },
    ...over,
  };
}

function docStore(initial: CollaborationRecord | null = record()) {
  let current = initial;
  const store: CollaborationStore & { set: (r: CollaborationRecord | null) => void; reads: number } = {
    reads: 0,
    async read() {
      store.reads += 1;
      return current;
    },
    async write(r) {
      current = r;
    },
    async list() {
      return current ? [current.documentId] : [];
    },
    set: (r) => {
      current = r;
    },
  };
  return store;
}

/**
 * R-9.1, made unmissable. Every collaborative test hands the hub this as its comment
 * store: if any part of a collaborative session reads or writes the sidecar, the session
 * throws rather than quietly succeeding on a cache it is forbidden to trust.
 */
function forbiddenSidecar(): CommentDocStore {
  return {
    async read() {
      throw new Error('R-9.1 violated: a collaborative session read visual-spec-comments.json');
    },
    async write() {
      throw new Error('R-9.1 violated: a collaborative session wrote visual-spec-comments.json');
    },
  };
}

type AdapterCall = { kind: 'reply' | 'issue'; id: number; body: string };

function fakeAdapter(over: Partial<GitHubAdapter> = {}) {
  const calls: AdapterCall[] = [];
  let head = 'sha-1';
  const adapter = {
    async getPullRequest() {
      return { number: 7, headSha: head, htmlUrl: '', state: 'open' };
    },
    async replyToReviewComment(_repo: unknown, _pull: number, commentId: number, body: string) {
      calls.push({ kind: 'reply', id: commentId, body });
      return {};
    },
    async createIssueComment(_repo: unknown, _pull: number, body: string) {
      calls.push({ kind: 'issue', id: 0, body });
      return {};
    },
    ...over,
  } as unknown as GitHubAdapter;
  return {
    adapter: () => adapter,
    calls,
    moveHead: (sha: string) => {
      head = sha;
    },
  };
}

const startBody = (over: Record<string, unknown> = {}) => ({
  commentId: 'c-000001a4',
  documentId: 'doc-1',
  documentPath: DOC_PATH,
  comment: { id: 'c-000001a4', text: 'Say which email — work or personal?', workflow: 'visual-spec', reviewCommentId: 420 },
  ...over,
});

/** A child that stays alive until killed, capturing whatever is written to stdin. */
function liveChild(): ReviewChild & { written: string[]; emit: (line: string) => void } {
  const ee = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const written: string[] = [];
  return {
    stdout,
    stderr: null,
    stdin: new Writable({
      write(chunk, _enc, cb) {
        written.push(String(chunk));
        cb();
      },
    }),
    on: (event: string, cb: (a: never) => void) => ee.on(event, cb as (...a: unknown[]) => void),
    kill: () => setImmediate(() => ee.emit('close', 143)),
    written,
    emit: (line: string) => stdout.push(`${line}\n`),
  } as unknown as ReviewChild & { written: string[]; emit: (line: string) => void };
}

function fakeRes() {
  const ee = new EventEmitter();
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    writeHead: () => {},
    write: (c: string) => {
      chunks.push(c);
      return true;
    },
    on: (event: string, cb: () => void) => ee.on(event, cb),
  };
  return {
    res: res as unknown as import('node:http').ServerResponse,
    frames: () => chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as ReviewEvent | ReviewSync),
    types: () => chunks.map((c) => (JSON.parse(c.replace(/^data: /, '').trim()) as { type: string }).type),
  };
}

const proposal = (patch: string): Proposal => ({
  interpretation: 'The reviewer wants the email kind named.',
  strategy: 'Say "work email" on the first screen.',
  reasoning: 'It is the only ambiguity in the sentence.',
  assumptions: [],
  ambiguities: [],
  alternatives: [],
  patch,
  impact: 'One sentence in one file.',
});

const resultFrame = (p: Proposal) => JSON.stringify({ type: 'result', structured_output: p });

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 60 && !cond(); i += 1) await tick();
  expect(cond()).toBe(true);
}

/** The `git` a test may reach when it must not write: one that refuses every patch. */
const refusingGit = async () => ({ stdout: '', exitCode: 1 });

/* ================================================================== *
 * C1.1 — R-8.8, R-9.1: the start contract
 * ================================================================== */
describe('C1.1 — the start request carries the projected record (R-8.8, R-9.1)', () => {
  it('reads the document path and the record off the request', () => {
    const start = parseCollabStart(startBody() as never);
    expect(start).toMatchObject({
      documentId: 'doc-1',
      documentPath: DOC_PATH,
      comment: { id: 'c-000001a4', text: 'Say which email — work or personal?', workflow: 'visual-spec', reviewCommentId: 420 },
    });
  });

  it('carries the node id when the record has one, and omits it when it does not (R-9.3)', () => {
    expect(parseCollabStart(startBody({ comment: { id: 'c-1', text: 't', nodeId: 'n-7' } }) as never)?.comment.nodeId).toBe('n-7');
    expect(parseCollabStart(startBody() as never)?.comment.nodeId).toBeUndefined();
  });

  it('answers null for a local start, so a local body can never be mistaken for this one', () => {
    expect(parseCollabStart({ commentId: 'c-1' })).toBe(null);
    // A document path with no record is not enough: the record is the whole point.
    expect(parseCollabStart({ commentId: 'c-1', documentId: 'doc-1', documentPath: DOC_PATH })).toBe(null);
  });

  it('the selector routes a collaborative body to the collaborative arm and everything else to the local one', () => {
    const selector = createReviewSessionOpsSelector({ documents: () => docStore() });
    const local = selector(() => ({ cwd: '/tmp', comments: forbiddenSidecar() }), { commentId: 'c-1' });
    const collab = selector(() => ({ cwd: '/tmp', comments: forbiddenSidecar() }), startBody() as never);
    expect(local.promptMode).toEqual({ mode: 'local' });
    expect(collab.promptMode).toEqual({ mode: 'collab', documentPath: DOC_PATH });
    // R-9.5's other half — there is no re-deriving pass on this path to fall back to.
    expect(collab.fallbackAvailable).toBe(false);
  });

  it('R-9.1 — a whole session runs with the sidecar unreadable', async () => {
    const docs = docStore();
    const gh = fakeAdapter();
    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: '/tmp', comments: forbiddenSidecar(), spawnSession: () => child, execGit: refusingGit }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docs, adapter: gh.adapter }),
    );
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    // The opening turn went out, which means resolve+locate both completed. Had either
    // touched the sidecar, `forbiddenSidecar` would have thrown into the error frame.
    expect(sub.types()).not.toContain('error');
    expect(child.written[0]).toContain(DOC_PATH);
  });
});

/* ================================================================== *
 * C1.2 — R-9.2, R-9.3: target resolution
 * ================================================================== */
describe('C1.2 — locate by node id, exactly (R-9.2, R-9.3)', () => {
  const ops = (over: Record<string, unknown> = {}, docs = docStore()) =>
    createCollabSessionOps({ documents: () => docs, adapter: fakeAdapter().adapter }, parseCollabStart(startBody(over) as never)!);

  it('a record with no node id is document-level and locates to the document (R-9.3)', async () => {
    const o = ops();
    const located = await o.locate((await o.resolve({ commentId: 'c-000001a4' }))!);
    expect(located).toMatchObject({ path: DOC_PATH });
  });

  it('a node-anchored record locates only when the node is really there (R-9.2)', async () => {
    const docs = docStore(record({ markdown: '# Onboarding\n\n<!-- vs-node: n-7 -->\nThe first screen.\n' }));
    const o = ops({ comment: { id: 'c-1', text: 't', nodeId: 'n-7' } }, docs);
    expect(await o.locate((await o.resolve({ commentId: 'c-1' }))!)).toMatchObject({ path: DOC_PATH });
  });

  it('a node id that is not in the document does NOT fall back to a snippet or a line', async () => {
    const o = ops({ comment: { id: 'c-1', text: 'The first screen asks for an email.', nodeId: 'n-missing' } });
    // The document contains that exact sentence, so a snippet ladder would have found
    // something. R-9.2 says there is no ladder: the answer is "not located".
    expect(await o.locate((await o.resolve({ commentId: 'c-1' }))!)).toBe(null);
  });

  it('a missing document locates to nothing rather than throwing', async () => {
    const o = ops({}, docStore(null));
    expect(await o.locate((await o.resolve({ commentId: 'c-1' }))!)).toBe(null);
  });

  it('the node scan is exact — a prefix of a real id is not that id', () => {
    const md = '<!-- vs-node: n-70 -->';
    expect(documentHasNode(md, 'n-70')).toBe(true);
    expect(documentHasNode(md, 'n-7')).toBe(false);
    expect(documentHasNode(md, '')).toBe(false);
  });
});

/* ================================================================== *
 * C1.3 — R-9.4: write confinement
 * ================================================================== */
describe('C1.3 — every write is confined to the canonical document (R-9.4)', () => {
  const patchFor = (path: string) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-a', '+b', ''].join('\n');

  it('reads every path a patch claims, from all three header forms', () => {
    expect(patchPaths(patchFor(DOC_PATH))).toEqual([DOC_PATH]);
    expect(patchPaths('--- /dev/null\n+++ b/new.md\n')).toEqual(['new.md']);
  });

  it('admits a patch that touches only the document', () => {
    expect(admitPatchFor(DOC_PATH, patchFor(DOC_PATH))).toEqual({ ok: true });
  });

  it('refuses a patch that reaches the generated output or anything else', () => {
    const refused = admitPatchFor(DOC_PATH, `${patchFor(DOC_PATH)}${patchFor('specs/onboarding.generated.md')}`);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('specs/onboarding.generated.md');
  });

  it('the hub refuses such a patch BEFORE it writes anything', async () => {
    const docs = docStore();
    const gh = fakeAdapter();
    const child = liveChild();
    let gitRuns = 0;
    const hub = createReviewHub(
      () => ({
        cwd: '/tmp',
        comments: forbiddenSidecar(),
        spawnSession: () => child,
        execGit: async () => {
          gitRuns += 1;
          return { stdout: '', exitCode: 0 };
        },
      }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docs, adapter: gh.adapter }),
    );
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    child.emit(resultFrame(proposal(patchFor('somewhere/else.md'))));
    await until(() => sub.types().includes('proposal'));

    const res = await hub.approve();
    expect(res).toMatchObject({ status: 409, json: { code: 'patch-refused' } });
    // The point of the check: `git` never ran, so there is nothing to undo.
    expect(gitRuns).toBe(0);
  });
});

/* ================================================================== *
 * C1.4 — R-9.7: drift is the branch head
 * ================================================================== */
describe('C1.4 — the branch head is pinned at propose time (R-9.7)', () => {
  const build = () => {
    const docs = docStore();
    const gh = fakeAdapter();
    const o = createCollabSessionOps({ documents: () => docs, adapter: gh.adapter }, parseCollabStart(startBody() as never)!);
    return { docs, gh, ops: o };
  };

  it('pins the head, and reports no drift while it holds', async () => {
    const { ops: o } = build();
    const located = (await o.locate((await o.resolve({ commentId: 'c-1' }))!))!;
    expect(located.pin).toBe('sha-1');
    expect(await o.checkDrift(located)).toEqual({ drifted: false });
  });

  it('a moved head is drift', async () => {
    const { ops: o, gh } = build();
    const located = (await o.locate((await o.resolve({ commentId: 'c-1' }))!))!;
    gh.moveHead('sha-2');
    const d = await o.checkDrift(located);
    expect(d.drifted).toBe(true);
    expect(d.drifted === true && d.reason).toContain('branch moved');
  });

  it('a node that is gone at approval time is drift too', async () => {
    const docs = docStore(record({ markdown: '# Onboarding\n\n<!-- vs-node: n-7 -->\nText.\n' }));
    const gh = fakeAdapter();
    const o = createCollabSessionOps(
      { documents: () => docs, adapter: gh.adapter },
      parseCollabStart(startBody({ comment: { id: 'c-1', text: 't', nodeId: 'n-7' } }) as never)!,
    );
    const located = (await o.locate((await o.resolve({ commentId: 'c-1' }))!))!;
    docs.set(record({ markdown: '# Onboarding\n\nText.\n' }));
    const d = await o.checkDrift(located);
    expect(d.drifted).toBe(true);
    expect(d.drifted === true && d.reason).toContain('no longer in the document');
  });

  it('a GitHub read failure is not drift — the last head we provably saw stands', async () => {
    const docs = docStore();
    const failing = fakeAdapter({
      getPullRequest: async () => {
        throw new Error('rate limited');
      },
    });
    const o = createCollabSessionOps({ documents: () => docs, adapter: failing.adapter }, parseCollabStart(startBody() as never)!);
    const located = (await o.locate((await o.resolve({ commentId: 'c-1' }))!))!;
    expect(located.pin).toBe('sha-1');
    expect(await o.checkDrift(located)).toEqual({ drifted: false });
  });

  it('a drifted approval writes nothing and asks for re-approval', async () => {
    const docs = docStore();
    const gh = fakeAdapter();
    const child = liveChild();
    let gitRuns = 0;
    const hub = createReviewHub(
      () => ({
        cwd: '/tmp',
        comments: forbiddenSidecar(),
        spawnSession: () => child,
        execGit: async () => {
          gitRuns += 1;
          return { stdout: '', exitCode: 0 };
        },
      }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docs, adapter: gh.adapter }),
    );
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    child.emit(resultFrame(proposal(`diff --git a/${DOC_PATH} b/${DOC_PATH}\n--- a/${DOC_PATH}\n+++ b/${DOC_PATH}\n@@ -1 +1 @@\n-a\n+b\n`)));
    await until(() => sub.types().includes('proposal'));

    gh.moveHead('sha-2');
    const res = await hub.approve();
    expect(res).toMatchObject({ status: 409, json: { code: 'drift' } });
    expect(gitRuns).toBe(0);
    expect(sub.types()).toContain('drift');
    // R-6.3/R-9.7 ask for RE-approval, so the session is still alive.
    expect(hub.snapshot().running).toBe(true);
  });
});

/* ================================================================== *
 * C1.5 / C1.6 — R-9.5, R-9.6, R-9.10, R-9.11
 * ================================================================== */
describe('C1.5/C1.6 — approval records on the conversation, not on disk', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vs-collab-review-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** A scratch git repo holding the canonical document, so the one write is a real one. */
  function repo(): string {
    const dir = mkdtempSync(join(tmp, 'repo-'));
    mkdirSync(join(dir, 'specs'));
    writeFileSync(join(dir, DOC_PATH), '# Onboarding\n\nThe first screen asks for an email.\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  const realPatch = [
    `diff --git a/${DOC_PATH} b/${DOC_PATH}`,
    `--- a/${DOC_PATH}`,
    `+++ b/${DOC_PATH}`,
    '@@ -1,3 +1,3 @@',
    ' # Onboarding',
    ' ',
    '-The first screen asks for an email.',
    '+The first screen asks for a work email.',
    '',
  ].join('\n');

  async function approveOnce(over: Record<string, unknown> = {}) {
    const dir = repo();
    const docs = docStore();
    const gh = fakeAdapter();
    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: dir, comments: forbiddenSidecar(), spawnSession: () => child, execGit: defaultExecGit }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docs, adapter: gh.adapter }),
    );
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start(startBody(over) as never);
    await until(() => child.written.length > 0);
    child.emit(resultFrame(proposal(realPatch)));
    await until(() => sub.types().includes('proposal'));
    const res = await hub.approve();
    return { dir, docs, gh, sub, res, hub };
  }

  it('applies the approved patch to the canonical document', async () => {
    const { dir, res } = await approveOnce();
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, DOC_PATH), 'utf8')).toContain('a work email');
  });

  it('R-9.5 — no status or result is written to any file', async () => {
    // `forbiddenSidecar` throws on read *and* write, so surviving the approval is the
    // assertion: nothing wrote a status anywhere the session could reach.
    const { res, docs, dir } = await approveOnce();
    expect(res.status).toBe(200);
    // Nor is the collaboration record rewritten — the document's bytes changed on disk
    // through the patch, and the record's own copy is not a place for a status either.
    expect((await docs.read('doc-1'))?.markdown).not.toContain('applied');
    expect(readFileSync(join(dir, DOC_PATH), 'utf8')).not.toContain('status');
  });

  it('R-9.6 — the session emits `ready-to-publish` naming the document, and publishes nothing', async () => {
    const { sub, gh } = await approveOnce();
    const handoff = sub.frames().find((f) => (f as { type: string }).type === 'ready-to-publish');
    expect(handoff).toEqual({ type: 'ready-to-publish', documentPath: DOC_PATH });
    // Nothing that could publish was called: the only adapter traffic is the reply.
    expect(gh.calls.every((c) => c.kind === 'reply' || c.kind === 'issue')).toBe(true);
  });

  it('R-9.10 — a reply recording what was applied lands on the review thread', async () => {
    const { gh } = await approveOnce();
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.kind).toBe('reply');
    expect(gh.calls[0]!.id).toBe(420);
    expect(gh.calls[0]!.body).toContain(DOC_PATH);
    expect(gh.calls[0]!.body).toContain('Say "work email" on the first screen.');
    // It says what it is not, because a reply is easy to read as a resolution.
    expect(gh.calls[0]!.body).toContain('does not resolve the thread');
  });

  it('R-9.10 — a flat issue comment gets a new comment on the same conversation', async () => {
    const { gh } = await approveOnce({ comment: { id: 'c-1', text: 't', workflow: 'visual-spec', issueCommentId: 99 } });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.kind).toBe('issue');
    expect(gh.calls[0]!.body).toContain('In reply to comment 99');
  });

  it('a reply that cannot be posted is reported without pretending the write failed', async () => {
    const dir = repo();
    const docs = docStore();
    const gh = fakeAdapter({
      replyToReviewComment: async () => {
        throw new Error('403 Forbidden');
      },
    });
    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: dir, comments: forbiddenSidecar(), spawnSession: () => child, execGit: defaultExecGit }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docs, adapter: gh.adapter }),
    );
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    child.emit(resultFrame(proposal(realPatch)));
    await until(() => sub.types().includes('proposal'));
    expect((await hub.approve()).status).toBe(200);
    expect(readFileSync(join(dir, DOC_PATH), 'utf8')).toContain('a work email');
    const err = sub.frames().find((f) => (f as { type: string }).type === 'error') as { message: string };
    expect(err.message).toContain('403 Forbidden');
    expect(err.message).toContain('was applied');
  });

  /*
   * R-9.11 — THIS LOOKS EXACTLY LIKE A BUG AND IS THE DESIGN.
   *
   * After an approved collaborative apply the comment still projects `open`, so its inline
   * indicator (R-1.11) stays up and it can be reviewed again. That is intended: `status`
   * records whether the LOCAL apply agent acted, it has no file to live in for a
   * collaborative comment (R-9.5), and `review-comments.ts` (R-5.21) rules out deriving it
   * from GitHub's `isResolved` because that gives the system two resolution models with
   * nothing able to say which is right. The record of the apply is the reply on the thread;
   * the open state is closed by resolving that thread on github.com.
   */
  it('R-9.11 — a collaborative comment still projects `open`, resolved remotely or not', () => {
    const thread = {
      root: {
        id: 420,
        body: 'Say which email',
        path: DOC_PATH,
        line: 3,
        subjectType: 'line',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        htmlUrl: 'https://github.com/acme/specs/pull/7#discussion_r420',
        user: 'reviewer',
      },
      replies: [],
    } as unknown as ReviewThread;
    expect(projectReviewThread(thread).status).toBe('open');
    expect(projectReviewThread(thread, { resolution: { rootCommentId: 420, isResolved: true } as never }).status).toBe('open');
  });
});

/* ================================================================== *
 * C1.7 — R-9.9: cancel and failure leave the document alone
 * ================================================================== */
describe('C1.7 — cancel or failure leaves the canonical document unchanged (R-9.9)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vs-collab-cancel-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function repo(): string {
    const dir = mkdtempSync(join(tmp, 'repo-'));
    mkdirSync(join(dir, 'specs'));
    writeFileSync(join(dir, DOC_PATH), '# Onboarding\n\nThe first screen asks for an email.\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  it('a cancelled session leaves the document byte-identical', async () => {
    const dir = repo();
    const before = readFileSync(join(dir, DOC_PATH));
    const docs = docStore();
    const gh = fakeAdapter();
    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: dir, comments: forbiddenSidecar(), spawnSession: () => child, execGit: defaultExecGit }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docs, adapter: gh.adapter }),
    );
    const sub = fakeRes();
    hub.subscribe(sub.res);
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    child.emit(
      resultFrame(
        proposal(
          [`diff --git a/${DOC_PATH} b/${DOC_PATH}`, `--- a/${DOC_PATH}`, `+++ b/${DOC_PATH}`, '@@ -1 +1 @@', '-# Onboarding', '+# Onboard', ''].join('\n'),
        ),
      ),
    );
    await until(() => sub.types().includes('proposal'));

    expect(hub.cancel().status).toBe(200);
    expect(readFileSync(join(dir, DOC_PATH))).toEqual(before);
    // And nothing was said on the conversation about a change that did not happen.
    expect(gh.calls).toHaveLength(0);
  });

  it('a session that never produced a proposal writes nothing on approval', async () => {
    const dir = repo();
    const before = readFileSync(join(dir, DOC_PATH));
    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: dir, comments: forbiddenSidecar(), spawnSession: () => child, execGit: defaultExecGit }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docStore(), adapter: fakeAdapter().adapter }),
    );
    hub.subscribe(fakeRes().res);
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    expect(await hub.approve()).toMatchObject({ status: 409, json: { code: 'no-proposal' } });
    expect(readFileSync(join(dir, DOC_PATH))).toEqual(before);
  });
});

/* ================================================================== *
 * The prompt the collaborative arm runs
 * ================================================================== */
describe('the collaborative session runs the collaborative prompt arm', () => {
  it('names the document and forbids the sidecar in its opening turn', async () => {
    const child = liveChild();
    const hub = createReviewHub(
      () => ({ cwd: '/tmp', comments: forbiddenSidecar(), spawnSession: () => child, execGit: refusingGit }),
      createRunLock(),
      createReviewSessionOpsSelector({ documents: () => docStore(), adapter: fakeAdapter().adapter }),
    );
    hub.start(startBody() as never);
    await until(() => child.written.length > 0);
    const opening = child.written[0]!;
    expect(opening).toContain(DOC_PATH);
    expect(opening).toContain('do not read it, do not edit it, and do not trust it');
    // R-9.5 — the prompt says it too, even though `admitPatch` and the absence of any
    // status writer are what actually make it true.
    expect(opening).toContain('Do not record status or result anywhere, and do not publish.');
  });
});

/* ------------------------------------------------------------------ *
 * A type-level reminder, not a runtime one: `ReviewDeps` reaches this arm through the
 * selector and the arm ignores it. If that ever stops being true, this import stops
 * being unused and the reason to look is right here.
 * ------------------------------------------------------------------ */
export type _ReviewDepsIsNotUsedByTheCollabArm = ReviewDeps;
