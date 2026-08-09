// @vitest-environment jsdom
/**
 * App.test.tsx — task U-1: the collaboration UI must be *reachable* from the app
 * shell, not merely correct in isolation.
 *
 * Every collaboration module (`collab-open-panel`, `collab-comment-source`,
 * `use-collab-document`) already has its own unit suite
 * mounting it directly. None of that proves App.tsx ever renders them — and before
 * this task it did not: `App.tsx` had zero references to `collab`. This suite drives
 * the whole thing through `<App />`, exactly as a browser would load it, and checks
 * that a reviewer can get from the file-tree shell to a rendered document and its
 * comments and back.
 */
import './prism-global'; // must precede @lyfie/luthor
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationRecord } from '../core/collaboration/document-record';
import type { CommentRecord } from '../core/editing/comment-doc';
import { App } from './App';

/** A minimal but real collaboration document: line 3 is what the anchored comment names. */
const DOCUMENT: CollaborationRecord = {
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'The Spec',
  markdown: '# The Spec\n\nFirst paragraph.\n',
};

const ANCHORED_COMMENT: CommentRecord = {
  id: 'c-anchored',
  workflow: 'visual-spec',
  // R-0.3 — anchored by path and line, resolved against the rendered `data-vs-loc`.
  target: { path: 'docs/spec.md', kind: 'range', startLine: 3, heading: 'The Spec' },
  comment: 'needs a citation',
  status: 'open',
  ts: '2026-08-07T00:00:00.000Z',
  // The projected review thread: unresolved on GitHub, so the row links out to it (R-5.14).
  github: {
    reviewCommentId: 700001,
    isOutdated: false,
    isResolved: false,
    htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r700001',
    user: 'reviewer-rita',
    updatedAt: '2026-08-07T00:00:00.000Z',
  },
  replies: [],
} as CommentRecord;

const ORPHAN_COMMENT: CommentRecord = {
  id: 'c-orphan',
  workflow: 'visual-spec',
  // R-6.4 — no current line, so it is presented document-level with its captured text.
  target: { path: 'docs/spec.md', kind: 'file', snippet: 'the paragraph that got deleted' },
  comment: 'this block used to say something else',
  status: 'open',
  ts: '2026-08-07T00:00:00.000Z',
} as CommentRecord;

const AVAILABILITY = { available: true, login: 'reviewer-rita', repo: { owner: 'acme', repo: 'docs' } };

/** Two open pull requests, so the sidebar's badge has a number that is not 0 or 1. */
const OPEN_PULLS = [
  { number: 42, title: 'The Spec', author: 'author-ana', state: 'open', draft: false, headBranch: 'vs/doc-1', baseBranch: 'main', headSha: 'a'.repeat(40), htmlUrl: 'https://github.com/acme/docs/pull/42', documentId: 'doc-1' },
  { number: 43, title: 'Unrelated', author: 'dev-dan', state: 'open', draft: false, headBranch: 'fix/thing', baseBranch: 'main', headSha: 'b'.repeat(40), htmlUrl: 'https://github.com/acme/docs/pull/43', documentId: null },
];

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

/** Routes every fetch this render tree can issue: the file tree plus the collab API. */
function installFetch(availability: unknown = AVAILABILITY) {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/__vs/tree') return jsonRes([]);
    if (url === '/__vs/collab') return jsonRes(availability);
    // Nothing is checked out, so `CollabPullsPanel` gets an empty worktree list. Matched
    // before the listing below, whose prefix would otherwise swallow it.
    if (url === '/__vs/collab/pulls/mounted') return jsonRes({ worktrees: [] });
    // The sidebar's "Pull requests" item and the header chip both count these (R-7.1).
    if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: OPEN_PULLS });
    if (url === '/__vs/collab/open' && method === 'POST') return jsonRes({ ok: true });
    if (url === '/__vs/collab/doc-1') {
      return jsonRes({
        documentId: 'doc-1',
        state: 'draft',
        running: false,
        job: null,
        events: [],
        droppedEvents: 0,
        document: { documentId: 'doc-1', documentPath: 'docs/spec.md', title: 'The Spec', github: { owner: 'acme', repo: 'docs', branch: 'vs/doc-1', pullNumber: 42, resolved: false } },
      });
    }
    if (url === '/__vs/collab/doc-1/document') return jsonRes(DOCUMENT);
    if (url === '/__vs/collab/doc-1/comments') return jsonRes([ANCHORED_COMMENT, ORPHAN_COMMENT]);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

/** jsdom has no `EventSource`; `useCollabDocument` opens one unconditionally. */
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  installFetch();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/*
 * The way in to pull requests, and where it sits.
 *
 * It used to be the first line of the sidebar FOOTER — 11px muted, between the
 * copyright and a buy-me-a-coffee link, which is how this sidebar dresses chrome.
 * Reviewing a pull request is one of the two jobs the tool does, and the only one the
 * file tree cannot lead anyone to, so these pin it as navigation: above the tree, with
 * the count that says whether there is anything waiting.
 */
describe('the sidebar offers pull requests as navigation, not as footer text', () => {
  it('carries the count of open pull requests', async () => {
    render(<App />);
    const badge = await screen.findByTestId('sidebar-pull-count');
    expect(badge.textContent).toBe('2');
  });

  it('sits above the file tree rather than in the footer', async () => {
    const { container } = render(<App />);
    const item = await screen.findByRole('button', { name: /Pull requests/ });
    expect(item.closest('footer')).toBeNull();

    // Ahead of the "Files" heading in document order — DOCUMENT_POSITION_FOLLOWING is
    // the browser's own answer to "does this come after that".
    const files = screen.getByText('Files');
    expect(item.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('footer')?.textContent).not.toMatch(/pull request/i);
  });

  /*
   * R-7.2 — where collaboration is not configured the count is not merely hidden, it is
   * never asked for. The badge is absent rather than `0`, because `0` is a claim about a
   * repository nobody named.
   */
  it('shows no count where collaboration is unconfigured, and asks for none', async () => {
    const impl = installFetch({ available: false, reason: 'no_credential', message: 'Collaboration is unavailable.' });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Pull requests/ })).toBeTruthy());

    expect(screen.queryByTestId('sidebar-pull-count')).toBeNull();
    expect(impl.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith('/__vs/collab/pulls'))).toBe(false);
  });
});

describe('the collaboration UI is mounted from App.tsx (task U-1)', () => {
  it('is unreachable through the file tree but reachable through its own route', async () => {
    render(<App />);

    // Starts in the ordinary file-tree shell.
    await waitFor(() => expect(screen.getByText(/Select a file or folder/)).toBeTruthy());
    expect(screen.queryByText(/Open a document from a pull request/)).toBeNull();

    // The entry point lives in the file shell, not inside any TreeEntry.
    fireEvent.click(screen.getByRole('button', { name: /Pull requests/ }));

    // The whole shell swapped — file view is gone, the open panel is up.
    expect(screen.queryByText(/Select a file or folder/)).toBeNull();
    await screen.findByText(/Open a document from a pull request/);
    await screen.findByText(/Signed in as reviewer-rita/);
  });

  it('opens a document from a PR reference and renders it read-only beside the real comment panel', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Pull requests/ }));
    await screen.findByText(/Signed in as reviewer-rita/);

    // The manual URL form is a disclosure now — the pull request list above it is the
    // primary path, and this form is the answer for a pull request that is not in it.
    fireEvent.click(screen.getByRole('button', { name: /Open a document from a pull request URL/ }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/owner/repo/pull/42'), {
      target: { value: 'https://github.com/acme/docs/pull/42' },
    });
    fireEvent.change(screen.getByPlaceholderText('doc-1'), { target: { value: 'doc-1' } });
    fireEvent.click(screen.getByText('Open'));

    // R-7.3 — the Markdown renders through the shared surface, with every block stamped
    // `data-vs-loc`, which is the position a review comment is anchored by (R-0.3).
    const paragraph = await screen.findByText('First paragraph.');
    expect(paragraph.getAttribute('data-vs-loc')).toBe('3:0');
    expect(paragraph.closest('[data-inspector-root]')).toBeTruthy();

    // Its existing comments are listed — anchored and orphaned alike — and the real
    // panel is mounted, so the reviewer can also write one (U-1 round trip).
    await screen.findByText('needs a citation');
    expect(screen.getByText(/this block used to say something else/)).toBeTruthy();
    expect(screen.getByText(/the paragraph that got deleted/)).toBeTruthy();
    expect(screen.getAllByLabelText('Reply').length).toBeGreaterThan(0);
    // R-5.13 / R-5.14 — the way to resolve is a link to github.com, not a control here.
    expect(screen.getByText('Open on GitHub').getAttribute('href')).toBe(
      'https://github.com/acme/docs/pull/42#discussion_r700001',
    );
    expect(screen.queryByLabelText('Resolve comment')).toBeNull();

    // The route swap is reversible.
    fireEvent.click(screen.getByText('← Files'));
    await waitFor(() => expect(screen.getByText(/Select a file or folder/)).toBeTruthy());
    expect(screen.queryAllByText('First paragraph.')).toHaveLength(0);
  });
});
