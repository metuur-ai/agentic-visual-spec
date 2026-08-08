// @vitest-environment jsdom
/**
 * use-collab-document.test.tsx — the hook that keeps one document live (R-8.2 / R-8.4).
 *
 * Both transports are injected: a `CollabClient` stub and a fake `EventSource` whose
 * frames are pushed by hand. What is asserted is what a mounted component would see —
 * the seeded snapshot, the effect of each streamed frame, and that unmounting actually
 * closes the stream (a leaked subscriber keeps the server's poller alive).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { JobEvent, JobSnapshot, JobSync } from '../core/collaboration/job-hub';
import type { CollabCommentSourceDeps } from './collab-comment-source';
import type { CollabClient, CollabDocumentStatus, JobAccepted } from './collab-client';
import { useCollabDocument, type EventSourceLike } from './use-collab-document';

const SNAPSHOT: JobSnapshot = {
  documentId: 'doc-1',
  state: 'draft',
  running: false,
  job: null,
  events: [],
  droppedEvents: 0,
};

const STATUS: CollabDocumentStatus = {
  ...SNAPSHOT,
  document: { documentId: 'doc-1', documentPath: 'docs/spec.md', title: 'Spec', github: null },
};

const ACCEPTED: JobAccepted = { ok: true, jobId: 'doc-1-1', kind: 'sync' };

/** The whole document `GET /:id/document` serves — what `status()` cannot give. */
const DOCUMENT: CollaborationDocument = {
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'Spec',
  frontmatter: { status: 'draft' },
  nodes: [{ id: 'n-7', type: 'paragraph', version: 3, content: 'a claim' }],
  doc: { root: {} },
};

const comment = (id: string, text: string, over: Partial<CommentRecord> = {}): CommentRecord =>
  ({
    id,
    workflow: 'visual-spec',
    target: { path: 'docs/spec.md', kind: 'file' },
    comment: text,
    status: 'open',
    ts: 'T0',
    ...over,
  }) as CommentRecord;

/** A stub client; only the members the hook uses are real. */
function stubClient(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    availability: vi.fn(),
    start: vi.fn(),
    open: vi.fn(),
    status: vi.fn(async () => ({ ok: true, value: STATUS })),
    document: vi.fn(async () => ({ ok: true, value: DOCUMENT })),
    comments: vi.fn(async () => ({ ok: true, value: [] as CommentRecord[] })),
    sync: vi.fn(async () => ({ ok: true, value: ACCEPTED })),
    publish: vi.fn(async () => ({ ok: true, value: ACCEPTED })),
    addComment: vi.fn(),
    replyToComment: vi.fn(),
    patchComment: vi.fn(),
    eventsUrl: (id: string) => `/__vs/collab/${id}/events`,
    ...overrides,
  } as unknown as CollabClient;
}

/** A fake `EventSource` whose frames the test pushes. */
function fakeStream() {
  const opened: string[] = [];
  let closed = 0;
  let source: EventSourceLike | null = null;
  const factory = (url: string): EventSourceLike => {
    opened.push(url);
    source = {
      onmessage: null,
      onerror: null,
      close: () => {
        closed += 1;
      },
    };
    return source;
  };
  const push = (frame: JobEvent | JobSync) => source?.onmessage?.({ data: JSON.stringify(frame) });
  const pushRaw = (data: string) => source?.onmessage?.({ data });
  return { factory, push, pushRaw, opened, closedCount: () => closed };
}

/** Renders the hook's state as text, which is what a component would do with it. */
function Probe({ client, factory, documentId = 'doc-1' }: { client: CollabClient; factory: (url: string) => EventSourceLike; documentId?: string }) {
  const state = useCollabDocument(documentId, { client, eventSourceImpl: factory });
  return (
    <div>
      <span data-testid="title">{state.document?.title ?? '—'}</span>
      <span data-testid="pull">{state.document?.github?.pullNumber ?? '—'}</span>
      <span data-testid="state">{state.snapshot?.state ?? '—'}</span>
      <span data-testid="running">{String(state.running)}</span>
      <span data-testid="events">{state.snapshot?.events.length ?? -1}</span>
      <span data-testid="error">{state.error?.kind ?? '—'}</span>
      <span data-testid="nodes">{state.fullDocument?.nodes.length ?? -1}</span>
      <span data-testid="comments">{state.comments.map((c) => `${c.id}:${c.comment}:${c.status}`).join('|') || '—'}</span>
      <span data-testid="comments-error">{state.commentsError?.kind ?? '—'}</span>
      <button data-testid="add" onClick={() => void state.addComment({ nodeId: 'n-7', comment: 'tighten', workflow: 'visual-spec' })} />
      <button data-testid="reply" onClick={() => void state.replyToComment('c-1', 'agreed')} />
      <button data-testid="patch" onClick={() => void state.patchComment('c-1', { status: 'applied' })} />
      <button data-testid="reload" onClick={() => void state.reload()} />
    </div>
  );
}

describe('seeding from GET /:id', () => {
  it('exposes the document identity the stream never carries', async () => {
    const stream = fakeStream();
    render(<Probe client={stubClient()} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));
    expect(screen.getByTestId('state').textContent).toBe('draft');
    expect(stream.opened).toEqual(['/__vs/collab/doc-1/events']);
  });

  it('surfaces a seeding failure by kind rather than throwing out of the effect', async () => {
    const client = stubClient({
      status: vi.fn(async () => ({ ok: false, kind: 'not-found', status: 404, message: 'unknown document: doc-9' })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('not-found'));
  });
});

describe('applying streamed frames to the mounted state', () => {
  it('folds job-start and job-done into running / state', async () => {
    const stream = fakeStream();
    render(<Probe client={stubClient()} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));

    stream.push({ type: 'job-start', jobId: 'doc-1-1', kind: 'sync', startedAt: 10 });
    await waitFor(() => expect(screen.getByTestId('running').textContent).toBe('true'));

    stream.push({ type: 'log', jobId: 'doc-1-1', kind: 'progress', text: 'fetching comments' });
    await waitFor(() => expect(screen.getByTestId('events').textContent).toBe('2'));

    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'sync', ok: true, state: 'ready', finishedAt: 20 });
    await waitFor(() => expect(screen.getByTestId('running').textContent).toBe('false'));
    expect(screen.getByTestId('state').textContent).toBe('ready');
  });

  it('takes a sync frame as authoritative — this is how a late subscriber recovers (R-8.4)', async () => {
    const stream = fakeStream();
    render(<Probe client={stubClient()} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));

    stream.push({ type: 'sync', ...SNAPSHOT, state: 'publishing', running: true, droppedEvents: 12 });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('publishing'));
    expect(screen.getByTestId('running').textContent).toBe('true');
  });

  it('ignores a frame that is not JSON instead of tearing the stream down', async () => {
    const stream = fakeStream();
    render(<Probe client={stubClient()} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));
    stream.push({ type: 'job-start', jobId: 'doc-1-1', kind: 'sync', startedAt: 10 });
    await waitFor(() => expect(screen.getByTestId('running').textContent).toBe('true'));
    // A half-written frame, as a dropped connection can deliver.
    stream.pushRaw('{"type":"log","job');
    expect(screen.getByTestId('running').textContent).toBe('true');
    expect(screen.getByTestId('events').textContent).toBe('1');
  });
});

describe('the lifetime of the subscription', () => {
  it('closes the stream on unmount — a leaked subscriber keeps the server polling', async () => {
    const stream = fakeStream();
    const { unmount } = render(<Probe client={stubClient()} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));
    expect(stream.closedCount()).toBe(0);
    unmount();
    expect(stream.closedCount()).toBe(1);
  });

  it('closes the old stream and opens a new one when the document id changes', async () => {
    const stream = fakeStream();
    const { rerender } = render(<Probe client={stubClient()} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));
    rerender(<Probe client={stubClient()} factory={stream.factory} documentId="doc-2" />);
    await waitFor(() => expect(stream.opened).toHaveLength(2));
    expect(stream.opened[1]).toBe('/__vs/collab/doc-2/events');
    expect(stream.closedCount()).toBe(1);
  });
});

describe('the actions a component triggers', () => {
  it('returns the accepted job so the caller can match its own frames', async () => {
    const stream = fakeStream();
    const client = stubClient();
    let sync: (() => Promise<unknown>) | null = null;
    function Actions() {
      const state = useCollabDocument('doc-1', { client, eventSourceImpl: stream.factory });
      sync = state.sync;
      return null;
    }
    render(<Actions />);
    await waitFor(() => expect(sync).not.toBeNull());
    await expect(sync!()).resolves.toEqual({ ok: true, value: ACCEPTED });
  });

  it('returns a 409 as a conflict, which is the expected answer to a second click (R-8.1)', async () => {
    const conflict = { ok: false, kind: 'conflict', status: 409, message: 'a sync is already running for doc-1' };
    const client = stubClient({ sync: vi.fn(async () => conflict) } as unknown as Partial<CollabClient>);
    const stream = fakeStream();
    let sync: (() => Promise<unknown>) | null = null;
    function Actions() {
      const state = useCollabDocument('doc-1', { client, eventSourceImpl: stream.factory });
      sync = state.sync;
      return null;
    }
    render(<Actions />);
    await waitFor(() => expect(sync).not.toBeNull());
    await expect(sync!()).resolves.toEqual(conflict);
  });

  it('publish passes the R-8.9 payload straight through', async () => {
    const client = stubClient();
    const stream = fakeStream();
    let publish: ((input: { json: never; markdown: string }) => Promise<unknown>) | null = null;
    function Actions() {
      const state = useCollabDocument('doc-1', { client, eventSourceImpl: stream.factory });
      publish = state.publish as typeof publish;
      return null;
    }
    render(<Actions />);
    await waitFor(() => expect(publish).not.toBeNull());
    await publish!({ json: { root: {} } as never, markdown: '# Spec\n' });
    expect(client.publish).toHaveBeenCalledWith('doc-1', { json: { root: {} }, markdown: '# Spec\n' });
  });
});

/* ================================================================== *
 * The two reads the collaboration UI mounts on
 * ================================================================== */
describe('GET /:id/document and GET /:id/comments', () => {
  it('exposes the whole document alongside the identity summary', async () => {
    const client = stubClient();
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('1'));
    // Both reads happen, once each, and neither replaces the other.
    expect(client.document).toHaveBeenCalledWith('doc-1');
    expect(client.document).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('title').textContent).toBe('Spec');
  });

  it('seeds the conversation from the comments route (R-5.7)', async () => {
    const client = stubClient({
      comments: vi.fn(async () => ({ ok: true, value: [comment('c-1', 'tighten'), comment('c-2', 'overall')] })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:open|c-2:overall:open'));
  });

  it('a failed document read is a seeding error, not a throw out of the effect', async () => {
    const client = stubClient({
      document: vi.fn(async () => ({ ok: false, kind: 'not-found', status: 404, message: 'unknown document: doc-9' })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('not-found'));
    expect(screen.getByTestId('nodes').textContent).toBe('-1');
  });

  it('a failed comments read lands on commentsError and leaves the document renderable', async () => {
    const client = stubClient({
      comments: vi.fn(async () => ({ ok: false, kind: 'conflict', status: 409, message: 'no pull request yet' })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('comments-error').textContent).toBe('conflict'));
    expect(screen.getByTestId('nodes').textContent).toBe('1');
    expect(screen.getByTestId('error').textContent).toBe('—');
  });
});

describe('comment mutations, shaped for CollabCommentSourceDeps', () => {
  it('add posts the nodeId and folds the saved record in without re-reading', async () => {
    const saved = comment('c-9', 'tighten', { collab: { nodeId: 'n-7' } } as Partial<CommentRecord>);
    const client = stubClient({
      addComment: vi.fn(async () => ({ ok: true, value: { ok: true, id: 'c-9', comment: saved } })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('1'));

    screen.getByTestId('add').click();
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-9:tighten:open'));
    /*
     * R-7.5 — the nodeId reaches the route, and so does the routing tag. This assertion
     * used to pin the opposite, with a comment explaining that the server stamps its own
     * workflow "so it is not sent" — which described the defect rather than a decision:
     * the panel's "Apply via" control was discarded here, and every collaborative comment
     * was born routed to the default whatever the author picked.
     */
    expect(client.addComment).toHaveBeenCalledWith('doc-1', {
      comment: 'tighten',
      nodeId: 'n-7',
      workflow: 'visual-spec',
    });
    expect(client.comments).toHaveBeenCalledTimes(1);
  });

  it('reply appends the reply the server saved', async () => {
    const saved = comment('c-2', 'agreed', { collab: { replyTo: 'c-1' } } as Partial<CommentRecord>);
    const client = stubClient({
      comments: vi.fn(async () => ({ ok: true, value: [comment('c-1', 'tighten')] })),
      replyToComment: vi.fn(async () => ({ ok: true, value: { ok: true, id: 'c-2', comment: saved } })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:open'));

    screen.getByTestId('reply').click();
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:open|c-2:agreed:open'));
    expect(client.replyToComment).toHaveBeenCalledWith('doc-1', 'c-1', { comment: 'agreed' });
  });

  /*
   * R-5.21 — `status` is the LOCAL apply-agent flag, not a resolution. The pair of
   * `removeComment` / `restoreComment` helpers this used to exercise wrote a resolution
   * marker, and went with the protocol (R-5.13).
   */
  it('patchComment folds the saved record in — status is local bookkeeping (R-5.21)', async () => {
    const client = stubClient({
      comments: vi.fn(async () => ({ ok: true, value: [comment('c-1', 'tighten')] })),
      patchComment: vi.fn(async () => ({ ok: true, value: { ok: true, comment: comment('c-1', 'tighten', { status: 'applied' }) } })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:open'));

    screen.getByTestId('patch').click();
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:applied'));
    expect(client.patchComment).toHaveBeenCalledWith('doc-1', 'c-1', { status: 'applied' });
  });

  /*
   * An agent applying comments edits `documents/<id>.json` on disk, outside every job this
   * hub knows about, so no frame arrives and nothing re-reads. Without this the author's
   * copy stays pre-agent — and publishing from a pre-agent copy silently discards the
   * agent's work, because the editor seeds itself from exactly this value.
   */
  it('reload re-reads the document, which is the only way an out-of-band edit becomes visible', async () => {
    const document = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: DOCUMENT })
      .mockResolvedValue({
        ok: true,
        value: { ...DOCUMENT, nodes: [...DOCUMENT.nodes, { ...DOCUMENT.nodes[0]!, id: 'n-agent' }] },
      });
    const client = stubClient({ document } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('1'));

    screen.getByTestId('reload').click();

    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('2'));
  });

  it('a failed mutation lands on commentsError and leaves the list alone', async () => {
    const client = stubClient({
      comments: vi.fn(async () => ({ ok: true, value: [comment('c-1', 'tighten')] })),
      addComment: vi.fn(async () => ({ ok: false, kind: 'forbidden', status: 403, message: 'reviewer-rita may not' })),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={fakeStream().factory} />);
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:open'));

    screen.getByTestId('add').click();
    await waitFor(() => expect(screen.getByTestId('comments-error').textContent).toBe('forbidden'));
    expect(screen.getByTestId('comments').textContent).toBe('c-1:tighten:open');
  });

  it('the hook’s document + comments + add + reply satisfy CollabCommentSourceDeps', async () => {
    let deps: CollabCommentSourceDeps | null = null;
    const client = stubClient();
    const { factory } = fakeStream();
    function Wire() {
      const state = useCollabDocument('doc-1', { client, eventSourceImpl: factory });
      // The type assertion IS the test: a later wave passes this straight into
      // `collabCommentPanelSource(...)`, so a signature drift must fail the build.
      if (state.fullDocument) {
        deps = {
          document: state.fullDocument,
          comments: state.comments,
          add: state.addComment,
          reply: state.replyToComment,
        };
      }
      return null;
    }
    render(<Wire />);
    await waitFor(() => expect(deps).not.toBeNull());
    expect(deps!.document.documentId).toBe('doc-1');
  });
});

describe('re-reading what a finished job changed', () => {
  /** The scenario the whole feature exists for: someone else comments on github.com. */
  it('renders a comment that only arrives because the hub polled GitHub', async () => {
    const stream = fakeStream();
    const comments = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: [] as CommentRecord[] })
      .mockResolvedValue({ ok: true, value: [comment('c-9', 'from the reviewer')] });
    render(<Probe client={stubClient({ comments } as unknown as Partial<CollabClient>)} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('—'));

    // What the poller emits when it finds a new comment on the PR.
    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'sync', ok: true, state: 'draft', finishedAt: 20 });

    await waitFor(() => expect(screen.getByTestId('comments').textContent).toBe('c-9:from the reviewer:open'));
  });

  it('leaves the document alone on a poll, so a tick cannot re-render under a typing author', async () => {
    const stream = fakeStream();
    const client = stubClient();
    render(<Probe client={client} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('1'));
    expect(client.document).toHaveBeenCalledTimes(1);

    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'sync', ok: true, state: 'draft', finishedAt: 20 });
    await waitFor(() => expect(client.comments).toHaveBeenCalledTimes(2));

    expect(client.document).toHaveBeenCalledTimes(1);
    expect(client.status).toHaveBeenCalledTimes(1);
  });

  /*
   * R-11.2's whole promise is that opening a PR shows what is on the branch. The open job
   * fetches that document and writes it locally, but the browser only learns it changed
   * from the `job-done` frame's kind — and while the route labelled the job `sync`, this
   * hook classified it comment-only and never re-read. A reviewer therefore stared at the
   * seed document until they reloaded the page. Behavioural, not a set-membership check:
   * relabel the job anything comment-only and this goes red.
   */
  it('re-reads the document after open, so a reviewer sees the branch and not the seed', async () => {
    const stream = fakeStream();
    const document = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: DOCUMENT })
      .mockResolvedValue({
        ok: true,
        value: { ...DOCUMENT, nodes: [...DOCUMENT.nodes, { ...DOCUMENT.nodes[0]!, id: 'n-2' }] },
      });
    const client = stubClient({ document } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('1'));

    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'open', ok: true, state: 'draft', finishedAt: 20 });

    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('2'));
  });

  it('re-reads identity after create, which is how a PR number first reaches the title bar', async () => {
    const stream = fakeStream();
    const status = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: STATUS })
      .mockResolvedValue({
        ok: true,
        value: { ...STATUS, document: { ...STATUS.document, github: { owner: 'o', repo: 'r', pullNumber: 12 } } },
      });
    const client = stubClient({ status } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('pull').textContent).toBe('—'));

    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'create', ok: true, state: 'draft', finishedAt: 20 });

    await waitFor(() => expect(screen.getByTestId('pull').textContent).toBe('12'));
    expect(client.document).toHaveBeenCalledTimes(2);
  });

  it('does not re-read after a job that failed — there is nothing new to read', async () => {
    const stream = fakeStream();
    const client = stubClient();
    render(<Probe client={client} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('Spec'));

    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'publish', ok: false, state: 'draft', finishedAt: 20 });
    stream.push({ type: 'job-start', jobId: 'doc-1-2', kind: 'sync', startedAt: 30 });
    await waitFor(() => expect(screen.getByTestId('running').textContent).toBe('true'));

    expect(client.comments).toHaveBeenCalledTimes(1);
    expect(client.document).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good screen when a background re-read fails', async () => {
    const stream = fakeStream();
    const client = stubClient({
      document: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: DOCUMENT })
        .mockResolvedValue({ ok: false, kind: 'network', message: 'connection reset' }),
    } as unknown as Partial<CollabClient>);
    render(<Probe client={client} factory={stream.factory} />);
    await waitFor(() => expect(screen.getByTestId('nodes').textContent).toBe('1'));

    stream.push({ type: 'job-done', jobId: 'doc-1-1', kind: 'publish', ok: true, state: 'published', finishedAt: 20 });
    await waitFor(() => expect(client.document).toHaveBeenCalledTimes(2));

    // `error` would blank the document view; the document itself is still rendered.
    expect(screen.getByTestId('error').textContent).toBe('—');
    expect(screen.getByTestId('nodes').textContent).toBe('1');
  });
});
