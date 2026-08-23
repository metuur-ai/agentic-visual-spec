// @vitest-environment jsdom
/**
 * review-view.test.tsx — B6.2, driven through a real mount over a fake SSE stream.
 *
 * The component is mounted inside `CommentPanel` rather than in isolation, because the
 * claims under test are about the whole path: a row action starts a session for one
 * comment (R-8.10), the stream's frames become a readable proposal (R-4.x), the follow-up
 * box posts (R-5.x), approval is deliberate (R-6.1), `applied` refreshes the document and
 * the sidebar (R-6.5), drift asks for re-approval rather than reporting a fault (R-6.3),
 * and a reload finds the session that is already running (R-8.9).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InspectorProvider } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { Proposal } from '../core/editing/review-prompt';
import { CommentPanel } from './comment-panel';

const COMMENT = {
  id: 'c1',
  workflow: 'visual-spec',
  target: { path: 'a.md', kind: 'range', startLine: 3, heading: 'Intro' },
  comment: 'Tighten this paragraph',
  status: 'open',
  ts: '2026-08-07T00:00:00.000Z',
} as unknown as CommentRecord;

const OTHER = { ...COMMENT, id: 'c2', comment: 'Something else' } as CommentRecord;

const PATCH = ['--- a/a.md', '+++ b/a.md', '@@ -3,2 +3,2 @@', '-wordy sentence', '+tight sentence', ' after', ''].join('\n');

const PROPOSAL: Proposal = {
  interpretation: 'You want the paragraph shortened.',
  strategy: 'Replace the sentence with a tighter one.',
  reasoning: 'The meaning survives at half the length.',
  assumptions: ['The heading stays as it is'],
  ambiguities: ['How short is short'],
  alternatives: [{ summary: 'Delete the paragraph', tradeoff: 'Loses the example' }],
  patch: PATCH,
  impact: 'One paragraph in a.md; nothing links to it.',
};

/** The single live stream, so a test can push frames the way the server would. */
let stream: FakeEventSource | null = null;
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    stream = this;
  }
  close() {
    this.closed = true;
  }
}
const emit = (frame: unknown) => act(() => stream?.onmessage?.({ data: JSON.stringify(frame) }));

/** Every request the panel makes, so the tests can assert on the review POSTs. */
let calls: { url: string; init?: RequestInit }[] = [];
let reviewStatus: { running: boolean; commentId: string | null } = { running: false, commentId: null };
let postReply: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true } };

function stubFetch(comments: CommentRecord[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/__vs/review') return json(reviewStatus);
      if (url.startsWith('/__vs/review/')) return new Response(JSON.stringify(postReply.body), { status: postReply.status, headers: { 'content-type': 'application/json' } });
      return json(comments);
    }),
  );
}
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  stream = null;
  reviewStatus = { running: false, commentId: null };
  postReply = { status: 200, body: { ok: true } };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('matchMedia', undefined);
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(comments: CommentRecord[] = [COMMENT]) {
  stubFetch(comments);
  const view = render(
    <InspectorProvider surfaceId="a.md" pageIndex={0}>
      <CommentPanel file="a.md" width={320} />
    </InspectorProvider>,
  );
  await screen.findByText(comments[0]!.comment);
  return view;
}

const reviewPosts = () => calls.filter((c) => c.url.startsWith('/__vs/review/') && c.init?.method === 'POST');
const bodyOf = (i: number) => JSON.parse(String(reviewPosts()[i]!.init!.body));

/** Open a session on `c1` and land a proposal on it. */
async function openWithProposal() {
  await mount([COMMENT, OTHER]);
  fireEvent.click(screen.getAllByRole('button', { name: /Review & apply/ })[0]!);
  await screen.findByRole('dialog');
  await emit({ type: 'review-start', commentId: 'c1', startedAt: 1 });
  await emit({ type: 'proposal', proposal: PROPOSAL });
  await emit({ type: 'awaiting-input' });
}

describe('B6.1 — the per-comment entry point (R-8.10)', () => {
  it('every open comment row offers a review action', async () => {
    await mount([COMMENT, OTHER]);
    expect(screen.getAllByRole('button', { name: /Review & apply/ })).toHaveLength(2);
  });

  it('starts a session for that comment id and no other', async () => {
    await mount([COMMENT, OTHER]);
    fireEvent.click(screen.getAllByRole('button', { name: /Review & apply/ })[1]!);
    await waitFor(() => expect(reviewPosts()).toHaveLength(1));
    expect(reviewPosts()[0]!.url).toBe('/__vs/review/start');
    expect(bodyOf(0)).toEqual({ commentId: 'c2' });
  });

  it('does not touch the bulk apply route', async () => {
    await mount([COMMENT]);
    fireEvent.click(screen.getByRole('button', { name: /Review & apply/ }));
    await waitFor(() => expect(reviewPosts()).toHaveLength(1));
    expect(calls.some((c) => c.url.startsWith('/__vs/apply'))).toBe(false);
  });

  it('names the holder when the shared lock is already taken', async () => {
    postReply = { status: 409, body: { error: 'a bulk apply is running', holder: 'apply' } };
    await mount([COMMENT]);
    fireEvent.click(screen.getByRole('button', { name: /Review & apply/ }));
    expect(await screen.findByText(/A bulk apply is running/)).toBeTruthy();
  });
});

describe('B6.2 — the proposal (R-4.1–R-4.6)', () => {
  it('renders the patch as a diff, not as a blob', async () => {
    await openWithProposal();
    const kinds = [...document.querySelectorAll('[data-vs-patch-line]')].map((el) => el.getAttribute('data-vs-patch-line'));
    expect(kinds).toEqual(['del', 'add', 'context']);
    expect(screen.getByText('The change you are approving')).toBeTruthy();
  });

  it('shows the rest of the envelope as context beneath it', async () => {
    await openWithProposal();
    expect(screen.getByText(PROPOSAL.interpretation)).toBeTruthy();
    expect(screen.getByText(PROPOSAL.strategy)).toBeTruthy();
    expect(screen.getByText(PROPOSAL.reasoning)).toBeTruthy();
    expect(screen.getByText(PROPOSAL.impact)).toBeTruthy();
    expect(screen.getByText('The heading stays as it is')).toBeTruthy();
    expect(screen.getByText('How short is short')).toBeTruthy();
    expect(screen.getByText(/Delete the paragraph/)).toBeTruthy();
  });

  /* R-4.4 is faithful surfacing: no alternatives means no section, not an empty one. */
  it('omits the alternatives section when the model saw one option', async () => {
    await mount([COMMENT]);
    fireEvent.click(screen.getByRole('button', { name: /Review & apply/ }));
    await screen.findByRole('dialog');
    await emit({ type: 'proposal', proposal: { ...PROPOSAL, alternatives: [], assumptions: [] } });
    expect(screen.queryByText('Alternatives considered')).toBeNull();
    expect(screen.queryByText('Assumptions')).toBeNull();
  });

  it('replaces the proposal when a later turn revises it', async () => {
    await openWithProposal();
    await emit({ type: 'proposal', proposal: { ...PROPOSAL, patch: '--- a/a.md\n+++ b/a.md\n@@ -3,1 +3,1 @@\n-wordy sentence\n+much tighter\n' } });
    expect(screen.getByText('much tighter')).toBeTruthy();
    expect(screen.queryByText('tight sentence')).toBeNull();
  });
});

describe('B6.2 — refinement (R-5.x)', () => {
  it('posts a follow-up turn to /message', async () => {
    await openWithProposal();
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/), { target: { value: 'shorter still' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(reviewPosts()).toHaveLength(2));
    expect(reviewPosts()[1]!.url).toBe('/__vs/review/message');
    expect(bodyOf(1)).toEqual({ text: 'shorter still' });
  });

  /* R-5.4 — the waiting state is the server's `awaiting-input` frame, not a local guess. */
  it('says the session is waiting only once the server says so', async () => {
    await mount([COMMENT]);
    fireEvent.click(screen.getByRole('button', { name: /Review & apply/ }));
    await screen.findByRole('dialog');
    await emit({ type: 'review-start', commentId: 'c1', startedAt: 1 });
    expect(screen.queryByText(/Waiting for your next message/)).toBeNull();
    await emit({ type: 'awaiting-input' });
    expect(screen.getByText(/Waiting for your next message/)).toBeTruthy();
  });

  it('replays the user turn the server echoes back', async () => {
    await openWithProposal();
    await emit({ type: 'user-turn', text: 'shorter still' });
    expect(screen.getByText(/shorter still/)).toBeTruthy();
  });
});

describe('B6.2 — approval (R-6.1, R-6.5)', () => {
  it('needs a second, explicit press before anything is written', async () => {
    await openWithProposal();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(reviewPosts()).toHaveLength(1); // the start, and nothing else
    fireEvent.click(screen.getByRole('button', { name: 'Yes, apply' }));
    await waitFor(() => expect(reviewPosts()).toHaveLength(2));
    expect(reviewPosts()[1]!.url).toBe('/__vs/review/approve');
  });

  it('cannot be approved before a proposal exists', async () => {
    await mount([COMMENT]);
    fireEvent.click(screen.getByRole('button', { name: /Review & apply/ }));
    await screen.findByRole('dialog');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  /* R-6.5's client half: the `applied` frame is what makes the doc and sidebar stale. */
  it('refreshes the document and the sidebar when the patch lands', async () => {
    const seen: string[] = [];
    const listen = (e: Event) => seen.push(e.type);
    window.addEventListener('vs:comments-changed', listen);
    window.addEventListener('vs:source-changed', listen);
    await openWithProposal();
    expect(seen).toEqual([]);
    await emit({ type: 'applied', commentId: 'c1', path: 'a.md', result: 'Tightened the paragraph' });
    expect(seen).toEqual(['vs:comments-changed', 'vs:source-changed']);
    expect(screen.getByText(/Tightened the paragraph/)).toBeTruthy();
    window.removeEventListener('vs:comments-changed', listen);
    window.removeEventListener('vs:source-changed', listen);
  });

  it('cancelling ends the session and writes nothing', async () => {
    await openWithProposal();
    fireEvent.click(screen.getByRole('button', { name: /Cancel session/ }));
    await waitFor(() => expect(reviewPosts()).toHaveLength(2));
    expect(reviewPosts()[1]!.url).toBe('/__vs/review/cancel');
    await emit({ type: 'ended', ok: true, reason: 'cancelled' });
    expect(screen.getByText(/Nothing was written and the comment is still open/)).toBeTruthy();
  });
});

describe('B6.2 — drift and endings (R-6.3, R-7.6)', () => {
  it('asks for re-approval rather than reporting a failure', async () => {
    await openWithProposal();
    await emit({ type: 'drift', message: 'the patch no longer applies to a.md.' });
    const banner = document.querySelector('[data-vs-review-drift]');
    expect(banner?.textContent).toContain('Re-approval needed');
    expect(banner?.textContent).toContain('the patch no longer applies');
    // Still approvable — R-6.3 asks for re-approval, not for the session to be over.
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears the drift banner when a fresh proposal supersedes it', async () => {
    await openWithProposal();
    await emit({ type: 'drift', message: 'the patch no longer applies to a.md.' });
    await emit({ type: 'proposal', proposal: PROPOSAL });
    expect(document.querySelector('[data-vs-review-drift]')).toBeNull();
  });

  it('tells an idle reaping apart from a crash', async () => {
    await openWithProposal();
    await emit({ type: 'ended', ok: true, reason: 'idle' });
    expect(document.querySelector('[data-vs-review-ended="idle"]')?.textContent).toMatch(/left idle/);
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it('reports a dead child as a stop, not as a silent nothing', async () => {
    await openWithProposal();
    await emit({ type: 'ended', ok: false, reason: 'error' });
    expect(document.querySelector('[data-vs-review-ended="error"]')?.textContent).toMatch(/failed/);
  });

  it('distinguishes a dead session from no session at all', async () => {
    await openWithProposal();
    postReply = { status: 409, body: { error: 'the review session has ended', code: 'session-ended' } };
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, apply' }));
    expect(await screen.findByText(/The review process stopped/)).toBeTruthy();
  });
});

describe('B6.2 — a returning tab (R-8.9)', () => {
  it('opens the view for a session that is already running', async () => {
    reviewStatus = { running: true, commentId: 'c1' };
    await mount([COMMENT]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // Nothing was started — the session was found, not created.
    expect(reviewPosts()).toHaveLength(0);
  });

  it('rebuilds its whole state from the sync replay', async () => {
    reviewStatus = { running: true, commentId: 'c1' };
    await mount([COMMENT]);
    await screen.findByRole('dialog');
    await emit({
      type: 'sync',
      running: true,
      phase: 'awaiting-input',
      commentId: 'c1',
      startedAt: 1,
      events: [
        { type: 'review-start', commentId: 'c1', startedAt: 1 },
        { type: 'proposal', proposal: PROPOSAL },
        { type: 'awaiting-input' },
      ],
    });
    expect(screen.getByText('tight sentence')).toBeTruthy();
    expect(screen.getByText(/Waiting for your next message/)).toBeTruthy();
  });

  it('does not re-fire the refresh when a past applied frame is replayed', async () => {
    reviewStatus = { running: true, commentId: 'c1' };
    await mount([COMMENT]);
    await screen.findByRole('dialog');
    const seen: string[] = [];
    const listen = (e: Event) => seen.push(e.type);
    window.addEventListener('vs:comments-changed', listen);
    await emit({
      type: 'sync',
      running: false,
      phase: 'ended',
      commentId: 'c1',
      startedAt: 1,
      events: [
        { type: 'proposal', proposal: PROPOSAL },
        { type: 'applied', commentId: 'c1', path: 'a.md', result: 'done' },
        { type: 'ended', ok: true, reason: 'applied' },
      ],
    });
    expect(seen).toEqual([]);
    window.removeEventListener('vs:comments-changed', listen);
  });

  /* Closing the view must not end the session — the stream stays open behind it. */
  it('closing the drawer leaves the session and its subscription alone', async () => {
    await openWithProposal();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(reviewPosts()).toHaveLength(1); // still just the start
    expect(stream?.closed).toBe(false);
  });
});
