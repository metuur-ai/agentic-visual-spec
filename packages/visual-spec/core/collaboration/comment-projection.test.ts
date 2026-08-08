import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../editing/comment-doc';
import { type CommentDocStore, handleCommentsRequest } from '../vite/routes/comments';
import { createGitHubAdapter } from './github-adapter';
import type { GhExecutor, GhResult } from './github-executor';
import {
  type ProjectedCommentRecord,
  commentsByNode,
  documentDiscussion,
  findByIdempotencyKey,
  formatCommentBody,
  hasRoutingDecision,
  formatResolutionReply,
  formatTrailer,
  githubCommentStore,
  isResolutionReply,
  issueCommentIdFor,
  parseCommentBody,
  projectIssueComment,
  recordIdFor,
  resolutionByComment,
  withResolutionState,
} from './comment-projection';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(`${here}fixtures/${name}`, 'utf8');

const repo = { owner: 'acme', repo: 'docs' };
const ACCEPT_FLAG_VALUE = 'Accept: application/vnd.github+json';
const endpointOf = (args: string[]): string => args[args.indexOf(ACCEPT_FLAG_VALUE) + 1] as string;

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

function store(responses: Array<Partial<GhResult>>, cache?: CommentDocStore) {
  const { exec, calls } = recorder(responses);
  const s = githubCommentStore({
    adapter: createGitHubAdapter(exec),
    repo,
    pullNumber: 42,
    documentId: 'doc-1',
    documentPath: 'docs/spec.md',
    ...(cache ? { cache } : {}),
  });
  return { store: s, calls };
}

const LIST = { stdout: fixture('projection-comments.json') };

// ---------------------------------------------------------------------------
// R-5.4 — the trailer format
// ---------------------------------------------------------------------------

describe('trailer format (R-5.4)', () => {
  it('writes the documented shape as the last line, after a blank separator', () => {
    expect(formatCommentBody('Tighten this paragraph.', { documentId: 'doc-1', nodeId: 'n-7' })).toBe(
      'Tighten this paragraph.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->',
    );
  });

  it('omits nodeId for a document-level comment', () => {
    expect(formatTrailer({ documentId: 'doc-1' })).toBe('<!-- visual-spec: documentId=doc-1 -->');
  });

  it('is an HTML comment, so github.com renders only the author text', () => {
    const body = formatCommentBody('Hello', { documentId: 'doc-1', nodeId: 'n-7' });
    expect(body.split('\n').at(-1)).toMatch(/^<!--.*-->$/);
    expect(parseCommentBody(body).text).toBe('Hello');
  });

  it('round-trips text and fields exactly, including awkward values', () => {
    const fields = { documentId: 'doc 1/α', nodeId: 'n=7 --> x' };
    const text = 'Line one\n\nLine two with a fake <!-- visual-spec: nodeId=nope --> inline.';
    const round = parseCommentBody(formatCommentBody(text, fields));
    expect(round.text).toBe(text);
    expect(round.trailer).toEqual(fields);
  });

  it('carries unknown keys through untouched, so 5.2/5.3 can extend it', () => {
    const fields = { documentId: 'doc-1', nodeId: 'n-7', resolved: 'true', replyTo: '900001' };
    expect(parseCommentBody(formatCommentBody('x', fields)).trailer).toEqual(fields);
  });

  it('treats a body with no trailer as pure text (R-5.6)', () => {
    expect(parseCommentBody('Just prose.')).toEqual({ text: 'Just prose.', trailer: null });
  });

  it('maps a GitHub comment id to a route-compatible record id and back', () => {
    expect(recordIdFor(700001)).toBe('c-000aae61');
    expect(issueCommentIdFor('c-000aae61')).toBe(700001);
    expect(issueCommentIdFor('c-nothex')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R-5.1 / R-5.2 / R-5.6 / R-5.7 — projection
// ---------------------------------------------------------------------------

describe('githubCommentStore.read — projection (R-5.1)', () => {
  it('projects every PR issue comment into CommentDoc shape', async () => {
    const { store: s, calls } = store([LIST]);
    const doc = await s.read();

    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/issues/42/comments?per_page=100&page=1');
    expect(doc.version).toBe(1);
    expect(doc.comments).toHaveLength(4);
    expect(doc.comments[0]).toEqual({
      id: 'c-000aae61',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'Tighten this paragraph.',
      status: 'open',
      ts: '2026-08-06T09:00:00Z',
      github: {
        issueCommentId: 700001,
        user: 'reviewer-rita',
        htmlUrl: 'https://github.com/acme/docs/pull/42#issuecomment-700001',
        createdAt: '2026-08-06T09:00:00Z',
        updatedAt: '2026-08-06T09:00:00Z',
      },
      collab: { documentId: 'doc-1', nodeId: 'n-7' },
    });
  });

  it('is a valid CommentDocStore for handleCommentsRequest (R-5.1)', async () => {
    const { store: s } = store([LIST]);
    const res = await handleCommentsRequest(s, 'GET', '/all', {}, {});
    expect(res.status).toBe(200);
    expect((res.json as CommentDoc).comments).toHaveLength(4);
  });

  it('takes GitHub as the system of record — the cache is written, never read (R-5.2 / R-5.3)', async () => {
    let cached: CommentDoc = { version: 1, comments: [{ id: 'c-stale' } as CommentRecord] };
    let reads = 0;
    const cache: CommentDocStore = {
      async read() {
        reads += 1;
        return cached;
      },
      async write(doc) {
        cached = doc;
      },
    };

    const { store: s } = store([LIST], cache);
    const doc = await s.read();

    expect(reads).toBe(0); // the cache is never consulted
    expect(doc.comments.map((c) => c.id)).not.toContain('c-stale');
    expect(cached.comments).toHaveLength(4); // but it is refreshed
  });

  it('a snapshot write updates the cache and never reaches GitHub (R-5.3)', async () => {
    let cached: CommentDoc = { version: 1, comments: [] };
    const cache: CommentDocStore = {
      async read() {
        return cached;
      },
      async write(doc) {
        cached = doc;
      },
    };
    const { store: s, calls } = store([], cache);
    await s.write({ version: 1, comments: [{ id: 'c-1' } as CommentRecord] });

    expect(calls).toHaveLength(0);
    expect(cached.comments).toHaveLength(1);
  });

  /*
   * The projection used to stamp `workflow: DEFAULT_WORKFLOW` on every comment it read,
   * inventing a routing decision for people who never saw the control. It is read back
   * now — and because `CommentRecord` requires the field, the honest signal for "nobody
   * chose" is the trailer's presence, which is what `hasRoutingDecision` reports.
   */
  it('reads the routing tag back off the trailer instead of stamping one', () => {
    const tagged = projectIssueComment(
      {
        id: 900001,
        body: formatCommentBody('Route this elsewhere.', { documentId: 'doc-1', nodeId: 'n-7', workflow: 'research' }),
        user: 'octocat', htmlUrl: 'https://x/1', createdAt: 'T0', updatedAt: 'T0',
      },
      'docs/spec.md',
    );
    expect(tagged.workflow).toBe('research');
    expect(hasRoutingDecision(tagged)).toBe(true);
  });

  it('a comment created before the tag was persisted keeps the default — no migration', () => {
    const legacy = projectIssueComment(
      {
        id: 900002,
        body: formatCommentBody('Tighten this.', { documentId: 'doc-1', nodeId: 'n-7' }),
        user: 'octocat', htmlUrl: 'https://x/2', createdAt: 'T0', updatedAt: 'T0',
      },
      'docs/spec.md',
    );
    expect(legacy.workflow).toBe('visual-spec');
    expect(hasRoutingDecision(legacy)).toBe(true);
  });

  it('a comment typed on github.com made no routing decision at all (R-5.6)', () => {
    const driveBy = projectIssueComment(
      { id: 900003, body: 'Looks good to me 👍', user: 'dana', htmlUrl: 'https://x/3', createdAt: 'T0', updatedAt: 'T0' },
      'docs/spec.md',
    );
    // It is still surfaced — R-5.6 discards nothing — but nobody routed it.
    expect(driveBy.comment).toBe('Looks good to me 👍');
    expect(hasRoutingDecision(driveBy)).toBe(false);
  });

  it('surfaces comments authored on github.com, trailer or not (R-5.6)', async () => {
    const { store: s } = store([LIST]);
    const doc = await s.read();
    const driveBy = doc.comments.find((c) => c.id === recordIdFor(700004)) as ProjectedCommentRecord;

    expect(driveBy.comment).toBe('Typed straight into the PR conversation on github.com.');
    expect(driveBy.collab).toEqual({});
    expect(driveBy.github.user).toBe('drive-by-dana');
  });

  it('keeps nodeId-less comments in a document-level bucket, discarding none (R-5.7)', async () => {
    const { store: s } = store([LIST]);
    const doc = await s.read();

    expect(documentDiscussion(doc).map((c) => c.github.issueCommentId)).toEqual([700003, 700004]);
    expect(Object.keys(commentsByNode(doc))).toEqual(['n-7']);
    expect(commentsByNode(doc)['n-7']).toHaveLength(2);
    // Every comment is reachable from exactly one of the two views.
    expect(documentDiscussion(doc).length + commentsByNode(doc)['n-7']!.length).toBe(doc.comments.length);
  });
});

// ---------------------------------------------------------------------------
// R-5.4 / R-5.5 — mutation through the intent methods
// ---------------------------------------------------------------------------

describe('githubCommentStore intent methods (R-5.4 / R-5.5)', () => {
  it('addComment posts an issue comment with a trailer and RETURNS THE GITHUB ID', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }]);
    const record = {
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' as const },
      comment: 'Tighten this paragraph.',
      status: 'open' as const,
      ts: '2026-08-07T10:00:00Z',
      collab: { nodeId: 'n-7' },
    };

    const saved = (await s.addComment!(record)) as ProjectedCommentRecord;

    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/issues/42/comments');
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({
      body: 'Tighten this paragraph.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->',
    });
    // The verify step for 5.1.
    expect(saved.github.issueCommentId).toBe(900001);
    expect(saved.id).toBe(recordIdFor(900001));
    expect(saved.collab).toEqual({ documentId: 'doc-1', nodeId: 'n-7' });
  });

  it('addComment omits nodeId for a document-level comment (R-5.7)', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }]);
    await s.addComment!({
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'Overall this reads well.',
      status: 'open',
      ts: '2026-08-07T10:00:00Z',
    });
    expect(JSON.parse(calls[0]?.input ?? '{}').body).toBe(
      'Overall this reads well.\n\n<!-- visual-spec: documentId=doc-1 -->',
    );
  });

  /*
   * Issue comments are flat, so the trailer is the only place a reply's parent can live.
   * `addComment` used to build the trailer from documentId + nodeId + the idempotency key
   * alone, so `replyTo` was dropped on the way out: a reply reached GitHub indistinguishable
   * from a new comment, the thread was unrecoverable, and the panel listed it as a fourth
   * top-level comment. Asserted on the emitted body, which is the only artifact that
   * outlives this process.
   */
  it('addComment carries replyTo into the trailer, so a reply keeps its parent (R-5.12)', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }]);

    await s.addComment!({
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'Agreed, rewording now.',
      status: 'open',
      ts: '2026-08-07T10:00:00Z',
      collab: { nodeId: 'n-7', replyTo: '700001' },
    } as Parameters<NonNullable<typeof s.addComment>>[0]);

    expect(JSON.parse(calls[0]?.input ?? '{}').body).toBe(
      'Agreed, rewording now.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 replyTo=700001 -->',
    );
  });

  /*
   * A reply is not a resolution. `markerOf` demands `replyTo` AND `resolved`, so carrying
   * the parent link must not silently mark the thread resolved — that would take a comment
   * off the open list and open the publish gate on nobody's authority.
   */
  it('a reply carrying only replyTo is not read as a resolution marker', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }]);
    await s.addComment!({
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'Agreed.',
      status: 'open',
      ts: '2026-08-07T10:00:00Z',
      collab: { replyTo: '700001' },
    } as Parameters<NonNullable<typeof s.addComment>>[0]);

    const body = JSON.parse(calls[0]?.input ?? '{}').body as string;
    expect(body).toContain('replyTo=700001');
    expect(body).not.toContain('resolved=');
    const asProjected = projectIssueComment(
      { id: 900001, body, user: 'octocat', htmlUrl: 'https://x/1', createdAt: 'T0', updatedAt: 'T0' },
      'docs/spec.md',
    );
    expect(isResolutionReply(asProjected)).toBe(false);
  });

  /*
   * `addComment` used to rebuild the trailer from a fixed list of keys, which made it the
   * gatekeeper of the whole vocabulary: anything the caller computed and this list did not
   * name was dropped, and since issue comments are flat and the trailer is the only durable
   * channel, dropped meant gone. Two requirements were dead because of it — `nodeVersion`
   * never reached GitHub, so nothing could ever read as outdated (R-6.3), and the target
   * text never did either, so an orphan could not say what it was about (R-6.5). This pins
   * the direction: the caller's fields go out, the store only enforces its own.
   */
  it('carries every trailer field the caller set, not a fixed list of them (R-6.3 / R-6.5)', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }]);

    await s.addComment!({
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'Tighten this.',
      status: 'open',
      ts: '2026-08-07T10:00:00Z',
      collab: { nodeId: 'n-7', nodeVersion: '4', text: 'The paragraph as it read', workflow: 'research' },
    } as Parameters<NonNullable<typeof s.addComment>>[0]);

    const body = JSON.parse(calls[0]?.input ?? '{}').body as string;
    const { trailer } = parseCommentBody(body);
    expect(trailer).toEqual({
      documentId: 'doc-1',
      nodeId: 'n-7',
      nodeVersion: '4',
      text: 'The paragraph as it read',
      workflow: 'research',
    });
  });

  it('still imposes its own documentId — a caller cannot address another document', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }]);
    await s.addComment!({
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'x',
      status: 'open',
      ts: '2026-08-07T10:00:00Z',
      collab: { documentId: 'someone-elses-doc', nodeId: 'n-7' },
    } as Parameters<NonNullable<typeof s.addComment>>[0]);

    expect(parseCommentBody(JSON.parse(calls[0]?.input ?? '{}').body as string).trailer).toMatchObject({
      documentId: 'doc-1',
    });
  });

  it('NEVER creates a review comment — no /pulls/:n/comments endpoint is reached (R-5.5)', async () => {
    const { store: s, calls } = store([
      { stdout: fixture('issue-comment-create.json') },
      LIST,
      { stdout: fixture('issue-comment-update.json') },
      LIST,
      {},
    ]);
    await s.addComment!({
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'docs/spec.md', kind: 'file' },
      comment: 'a',
      status: 'open',
      ts: 't',
    });
    await s.updateComment!(recordIdFor(700001), { comment: 'b' });
    await s.deleteComment!(recordIdFor(700001));

    const endpoints = calls.map((c) => endpointOf(c.args));
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint).not.toMatch(/\/pulls\/\d+\/comments/);
      expect(endpoint).toMatch(/\/issues\//);
    }
  });

  it('updateComment rewrites the body and preserves the existing trailer', async () => {
    const { store: s, calls } = store([LIST, { stdout: fixture('issue-comment-update.json') }]);
    const updated = (await s.updateComment!(recordIdFor(700001), {
      comment: 'Tighten this paragraph, and drop the second sentence.',
    })) as ProjectedCommentRecord;

    expect(endpointOf(calls[1]?.args ?? [])).toBe('/repos/acme/docs/issues/comments/700001');
    expect(JSON.parse(calls[1]?.input ?? '{}')).toEqual({
      body: 'Tighten this paragraph, and drop the second sentence.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->',
    });
    expect(updated.github.issueCommentId).toBe(900001);
  });

  it('updateComment resolves null for an id GitHub does not know', async () => {
    const { store: s } = store([LIST]);
    expect(await s.updateComment!('c-deadbeef', { comment: 'x' })).toBeNull();
  });

  it('deleteComment deletes by the id decoded from the record id', async () => {
    const { store: s, calls } = store([{}]);
    await s.deleteComment!(recordIdFor(700002));
    expect(endpointOf(calls[0]?.args ?? [])).toBe('/repos/acme/docs/issues/comments/700002');
    expect(calls[0]?.args).toContain('DELETE');
  });
});

// ---------------------------------------------------------------------------
// The seam: the same route handler drives both store shapes.
// ---------------------------------------------------------------------------

describe('the extended CommentDocStore seam', () => {
  it('handleCommentsRequest routes add/patch/delete through the intent methods', async () => {
    const { store: s, calls } = store([{ stdout: fixture('issue-comment-create.json') }, LIST, {}]);

    const added = await handleCommentsRequest(s, 'POST', '/add', {}, { path: 'docs/spec.md', comment: 'Hi' });
    expect(added.json).toEqual({ ok: true, id: recordIdFor(900001) });

    // Status has no GitHub representation in 5.1 (resolution markers are task 5.2), so
    // the PATCH resolves against GitHub and writes nothing.
    const patched = await handleCommentsRequest(s, 'PATCH', `/${recordIdFor(700001)}`, {}, { status: 'applied' });
    expect(patched.json).toEqual({ ok: true });

    const deleted = await handleCommentsRequest(s, 'DELETE', `/${recordIdFor(700002)}`, {}, {});
    expect(deleted.json).toEqual({ ok: true });
    expect(calls.map((c) => c.args[2])).toEqual(['POST', 'GET', 'DELETE']);
  });

  it('a store with only read/write still satisfies the interface (snapshot fallback)', async () => {
    let doc: CommentDoc = { version: 1, comments: [] };
    const snapshotOnly: CommentDocStore = {
      async read() {
        return doc;
      },
      async write(next) {
        doc = next;
      },
    };
    await handleCommentsRequest(snapshotOnly, 'POST', '/add', {}, { path: 'a.md', comment: 'x', id: 'c-aaaaaaaa' });
    expect(doc.comments).toHaveLength(1);

    await handleCommentsRequest(snapshotOnly, 'PATCH', '/c-aaaaaaaa', {}, { status: 'applied', result: 'done' });
    expect(doc.comments[0]?.status).toBe('applied');
    expect(doc.comments[0]?.result).toBe('done');

    await handleCommentsRequest(snapshotOnly, 'DELETE', '/c-aaaaaaaa', {}, {});
    expect(doc.comments).toHaveLength(0);
  });

  it('a GitHub-backed store is still usable wherever a CommentDocStore is expected', () => {
    const { store: s } = store([]);
    const asPlain: CommentDocStore = s; // must type-check with setResolved added
    expect(typeof asPlain.read).toBe('function');
  });

  it('projectIssueComment leaves the local CommentRecord shape intact (R-1.7 / R-10.3)', () => {
    const projected = projectIssueComment(
      {
        id: 1,
        body: 'x',
        user: 'u',
        createdAt: 't',
        updatedAt: 't',
        htmlUrl: 'https://example.invalid',
      },
      'docs/spec.md',
    );
    const asLocal: CommentRecord = projected; // must type-check unchanged
    expect(asLocal.target).toEqual({ path: 'docs/spec.md', kind: 'file' });
    expect(asLocal.status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// R-5.12 … R-5.15 — resolution as a reply-comment convention (task 5.2)
// ---------------------------------------------------------------------------

/** The four resolution replies of `resolution-replies.json`, in fixture order. */
const REPLIES = JSON.parse(fixture('resolution-replies.json')) as unknown[];
const RESOLVE_700001 = REPLIES[0];
const UNRESOLVE_700001 = REPLIES[1];
const RESOLVED_CREATED = { stdout: fixture('resolution-reply-create.json') };

/** A `listIssueComments` response: the base fixture plus whichever replies a test needs. */
const listWith = (...replies: unknown[]) => ({
  stdout: JSON.stringify([...(JSON.parse(fixture('projection-comments.json')) as unknown[]), ...replies]),
});

const recordOf = (doc: CommentDoc, issueCommentId: number): ProjectedCommentRecord =>
  (doc.comments as ProjectedCommentRecord[]).find((c) => c.github.issueCommentId === issueCommentId) as ProjectedCommentRecord;

describe('resolution reply body (R-5.12 / R-5.15)', () => {
  it('resolve writes a visible sentence plus the hidden marker, and nothing else', async () => {
    const { store: s, calls } = store([LIST, RESOLVED_CREATED]);
    await s.setResolved(recordIdFor(700001), true);

    expect(JSON.parse(calls[1]?.input ?? '{}')).toEqual({
      body:
        'Resolved this comment: https://github.com/acme/docs/pull/42#issuecomment-700001\n\n' +
        '<!-- visual-spec: documentId=doc-1 replyTo=700001 resolved=true -->',
    });
  });

  it('unresolve is a SECOND reply with resolved=false — the first is never edited', async () => {
    const { store: s, calls } = store([LIST, RESOLVED_CREATED]);
    await s.setResolved(recordIdFor(700001), false);

    expect(JSON.parse(calls[1]?.input ?? '{}')).toEqual({
      body:
        'Reopened this comment: https://github.com/acme/docs/pull/42#issuecomment-700001\n\n' +
        '<!-- visual-spec: documentId=doc-1 replyTo=700001 resolved=false -->',
    });
    // POST to the comment collection, not PATCH of the existing marker.
    expect(calls[1]?.args).toContain('POST');
    expect(endpointOf(calls[1]?.args ?? [])).toBe('/repos/acme/docs/issues/42/comments');
  });

  it('reuses the 5.1 trailer — no second encoding (R-5.12)', () => {
    const parent = projectIssueComment(
      { id: 700001, body: 'x', user: 'u', createdAt: 't', updatedAt: 't', htmlUrl: 'https://example.invalid/#c' },
      'docs/spec.md',
    );
    const body = formatResolutionReply({ documentId: 'doc-1', parent, resolved: true });
    expect(parseCommentBody(body).trailer).toEqual({ documentId: 'doc-1', replyTo: '700001', resolved: 'true' });
  });

  it('is legible on github.com: the trailer is hidden, the sentence is not (R-5.15)', () => {
    const parent = projectIssueComment(
      { id: 700001, body: 'x', user: 'u', createdAt: 't', updatedAt: 't', htmlUrl: 'https://example.invalid/#c' },
      'docs/spec.md',
    );
    // What GitHub's renderer leaves behind once the HTML comment is dropped.
    const visible = parseCommentBody(formatResolutionReply({ documentId: 'doc-1', parent, resolved: true })).text;
    expect(visible).toBe('Resolved this comment: https://example.invalid/#c');
    expect(visible).not.toContain('<!--');
    expect(visible).not.toContain('visual-spec');
  });

  it('never writes a participant identity into the body (R-5.13)', async () => {
    const { store: s, calls } = store([LIST, RESOLVED_CREATED]);
    await s.setResolved(recordIdFor(700001), true);
    const body = JSON.parse(calls[1]?.input ?? '{}').body as string;

    // The parent was authored by reviewer-rita; the acting user is whoever the
    // credential belongs to. Neither is encoded — authorship is GitHub's to assign.
    for (const login of ['reviewer-rita', 'author-alice', 'drive-by-dana']) expect(body).not.toContain(login);
    expect(body).not.toContain('@');
    expect(body).not.toMatch(/\buser=|\bauthor=|\bby=/);
  });

  it('resolves null for an id GitHub does not know, posting nothing', async () => {
    const { store: s, calls } = store([LIST]);
    expect(await s.setResolved('c-deadbeef', true)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('deriving resolution state (R-5.14)', () => {
  it('takes the LATEST marker by createdAt, whatever order the replies arrive in', async () => {
    // 800102 (09:20, resolved) has the HIGHER id but the EARLIER timestamp;
    // 800101 (09:30, reopened) is later and therefore wins.
    const { store: s } = store([listWith(RESOLVE_700001, UNRESOLVE_700001)]);
    const doc = await s.read();

    expect(recordOf(doc, 700001).resolved).toBe(false);
    expect(recordOf(doc, 700001).status).toBe('open');
  });

  it('breaks a createdAt tie on the higher GitHub comment id', async () => {
    // 800103 (reopened) and 800104 (resolved) share 09:40 exactly; 800104 wins.
    const { store: s } = store([listWith(...REPLIES)]);
    const doc = await s.read();

    expect(recordOf(doc, 700003).resolved).toBe(true);
    expect(recordOf(doc, 700003).status).toBe('applied');
  });

  it('leaves a comment with no marker untouched — absent, not false', async () => {
    const { store: s } = store([listWith(...REPLIES)]);
    const doc = await s.read();

    expect(recordOf(doc, 700002).resolved).toBeUndefined();
    expect(recordOf(doc, 700002).status).toBe('open');
  });

  it('DOES NOT consult the cache — a cache claiming the opposite changes nothing (R-5.14)', async () => {
    let reads = 0;
    let cached: CommentDoc = {
      version: 1,
      comments: [
        // A stale cache asserting the exact opposite of what GitHub says.
        { id: recordIdFor(700001), status: 'applied', resolved: true } as unknown as CommentRecord,
        { id: recordIdFor(700003), status: 'open', resolved: false } as unknown as CommentRecord,
      ],
    };
    const cache: CommentDocStore = {
      async read() {
        reads += 1;
        return cached;
      },
      async write(doc) {
        cached = doc;
      },
    };

    const { store: s } = store([listWith(...REPLIES)], cache);
    const doc = await s.read();

    expect(reads).toBe(0);
    expect(recordOf(doc, 700001).resolved).toBe(false); // cache said true
    expect(recordOf(doc, 700003).resolved).toBe(true); // cache said false
  });

  it('is a pure derivation over the fetched list', () => {
    const records = (JSON.parse(fixture('resolution-replies.json')) as Array<Record<string, unknown>>).map((raw) =>
      projectIssueComment(
        {
          id: raw.id as number,
          body: raw.body as string,
          user: (raw.user as { login: string }).login,
          createdAt: raw.created_at as string,
          updatedAt: raw.updated_at as string,
          htmlUrl: raw.html_url as string,
        },
        'docs/spec.md',
      ),
    );
    expect([...resolutionByComment(records)]).toEqual([
      [700001, false],
      [700003, true],
    ]);
    // Nothing is stamped: the parents are not in this list.
    expect(withResolutionState(records).every((r) => r.resolved === undefined)).toBe(true);
  });
});

describe('resolve/unresolve round-trip (R-5.12 / R-5.14)', () => {
  it('goes open → resolved → open across three syncs', async () => {
    const before = await store([LIST]).store.read();
    expect(recordOf(before, 700001).resolved).toBeUndefined();

    const resolving = store([LIST, RESOLVED_CREATED]);
    const reply = await resolving.store.setResolved(recordIdFor(700001), true);
    expect(reply?.collab).toEqual({ documentId: 'doc-1', replyTo: '700001', resolved: 'true' });
    expect(reply?.github.issueCommentId).toBe(900102);

    const afterResolve = await store([listWith(RESOLVE_700001)]).store.read();
    expect(recordOf(afterResolve, 700001).resolved).toBe(true);
    expect(recordOf(afterResolve, 700001).status).toBe('applied');

    const afterUnresolve = await store([listWith(RESOLVE_700001, UNRESOLVE_700001)]).store.read();
    expect(recordOf(afterUnresolve, 700001).resolved).toBe(false);
    expect(recordOf(afterUnresolve, 700001).status).toBe('open');
  });

  it('keeps the replies in the document but out of the document-level discussion (R-5.6 / R-5.7)', async () => {
    const { store: s } = store([listWith(...REPLIES)]);
    const doc = await s.read();

    expect(doc.comments).toHaveLength(8); // 4 comments + 4 replies, nothing discarded
    expect((doc.comments as ProjectedCommentRecord[]).filter(isResolutionReply)).toHaveLength(4);
    expect(documentDiscussion(doc).map((c) => c.github.issueCommentId)).toEqual([700003, 700004]);
  });

  it('creates the reply through the issue-comment path only — never a review comment (R-5.5)', async () => {
    const { store: s, calls } = store([LIST, RESOLVED_CREATED]);
    await s.setResolved(recordIdFor(700001), true);

    for (const call of calls) {
      expect(endpointOf(call.args)).toMatch(/\/issues\//);
      expect(endpointOf(call.args)).not.toMatch(/\/pulls\/\d+\/comments/);
    }
  });
});

// ---------------------------------------------------------------------------
// R-5.11 — idempotent comment creation (task 5.3)
// ---------------------------------------------------------------------------

/** GitHub's response to the create that the first attempt never saw. */
const KEYED_CREATED = { stdout: fixture('idempotent-create.json') };
/** The same comment, as it appears in a later `listIssueComments` page. */
const KEYED_EXISTING = JSON.parse(fixture('idempotent-create.json')) as unknown;

const KEY = 'req-abc123';
const keyedRecord = (): CommentRecord =>
  ({
    id: 'local',
    workflow: 'visual-spec',
    target: { path: 'docs/spec.md', kind: 'file' },
    comment: 'Tighten this paragraph.',
    status: 'open',
    ts: '',
    collab: { nodeId: 'n-7', key: KEY },
  }) as unknown as CommentRecord;

describe('idempotent creation (R-5.11)', () => {
  it('carries the key in the trailer of the created comment', async () => {
    // The key is absent from the PR, so this is the FIRST attempt: list, then create.
    const { store: s, calls } = store([LIST, KEYED_CREATED]);
    const created = await s.addComment?.(keyedRecord());

    expect(JSON.parse(calls[1]?.input ?? '{}')).toEqual({
      body: 'Tighten this paragraph.\n\n<!-- visual-spec: documentId=doc-1 key=req-abc123 nodeId=n-7 -->',
    });
    expect((created as ProjectedCommentRecord).collab).toEqual({ documentId: 'doc-1', key: KEY, nodeId: 'n-7' });
  });

  it('a retry after a timeout returns the existing comment and creates NO duplicate', async () => {
    // The first attempt's create landed on GitHub but the client timed out, so the
    // retry's list already contains it. Only one response is queued: a second `gh`
    // call would be the duplicate POST and would come back empty, failing the read.
    const { store: s, calls } = store([listWith(KEYED_EXISTING)]);
    const retried = await s.addComment?.(keyedRecord());

    expect(calls).toHaveLength(1);
    expect(endpointOf(calls[0]?.args ?? [])).toMatch(/\/repos\/acme\/docs\/issues\/42\/comments/);
    expect(calls[0]?.input).toBeUndefined(); // a GET, not a POST
    expect((retried as ProjectedCommentRecord).github.issueCommentId).toBe(900201);
  });

  it('converges on the earliest comment if a duplicate ever did slip through the race window', () => {
    const dup = (id: number): ProjectedCommentRecord =>
      projectIssueComment(
        { id, body: `x\n\n<!-- visual-spec: key=${KEY} -->`, user: 'u', createdAt: '', updatedAt: '', htmlUrl: '' },
        'docs/spec.md',
      );
    expect(findByIdempotencyKey([dup(900202), dup(900201)], KEY)?.github.issueCommentId).toBe(900201);
    expect(findByIdempotencyKey([dup(900201)], 'other-key')).toBeNull();
  });

  it('a record with no key takes the original path — no extra list call (R-10.1 cost)', async () => {
    const { store: s, calls } = store([KEYED_CREATED]);
    await s.addComment?.({ ...keyedRecord(), collab: { nodeId: 'n-7' } } as unknown as CommentRecord);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeDefined(); // straight to the POST
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({
      body: 'Tighten this paragraph.\n\n<!-- visual-spec: documentId=doc-1 nodeId=n-7 -->',
    });
  });

  it('never reaches a review-comment endpoint, on either path (R-5.5)', async () => {
    const { store: s, calls } = store([LIST, KEYED_CREATED]);
    await s.addComment?.(keyedRecord());
    for (const call of calls) expect(endpointOf(call.args)).not.toMatch(/\/pulls\/\d+\/comments/);
  });
});
