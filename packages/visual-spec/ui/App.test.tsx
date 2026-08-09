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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** What `POST /pulls/42/mount` answers with — git's own path (R-13.8), never a guessed one. */
const WORKTREE = { pullNumber: 42, path: '/repo/.visual-spec/worktrees/pr-42', headSha: 'a'.repeat(40) };

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
    // R-13.3 — the checkout git produced, plus the two reads `CollabPrReview` opens with.
    if (url === '/__vs/collab/pulls/42/mount' && method === 'POST') return jsonRes({ worktree: WORKTREE });
    if (url === '/__vs/collab/pulls/42/files') return jsonRes({ files: ['docs/spec.md'] });
    if (url === '/__vs/collab/pulls/42/drafts') return jsonRes({ drafts: [] });
    // The sidebar's collaborate item and the header chip both count these (R-7.1).
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
    const item = await screen.findByRole('button', { name: /Collaborate on pull requests/ });
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
    await waitFor(() => expect(screen.getByRole('button', { name: /Collaborate on pull requests/ })).toBeTruthy());

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
    fireEvent.click(screen.getByRole('button', { name: /Collaborate on pull requests/ }));

    // The picker arrives as a modal drawer beside the file shell rather than in place of
    // it: choosing what to review is a detour, and the work behind it stays on screen.
    const drawer = await screen.findByRole('dialog', { name: 'Collaborate on pull requests' });
    expect(screen.getByText(/Select a file or folder/)).toBeTruthy();
    await screen.findByText(/Open a document from a pull request/);
    await screen.findByText(/Signed in as reviewer-rita/);

    // The ✕ is the way out, and it holds focus from the moment the drawer opens —
    // the standing-in-for-Escape half of the "only the ✕ closes it" decision.
    const close = screen.getByRole('button', { name: 'Close' });
    expect(drawer.contains(close)).toBe(true);
    expect(document.activeElement).toBe(close);

    // Escape is deliberately inert: the panel's buttons run git, and a stray keypress
    // must not tear the surface down around a checkout already in flight.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Collaborate on pull requests' })).toBeTruthy();

    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Collaborate on pull requests' })).toBeNull());
    expect(screen.queryByText(/Signed in as reviewer-rita/)).toBeNull();
    expect(screen.getByText(/Select a file or folder/)).toBeTruthy();
  });

  /*
   * The drawer is a picker, so what it picks has to leave it. A pull request's code needs
   * the whole window — a file list, a diff and a comment column do not fit in 480px — and
   * the checkout the drawer already paid git for has to travel with the choice rather than
   * being mounted a second time on the other side.
   */
  it('hands a checked-out pull request to the full-width surface, mounting it once', async () => {
    const impl = installFetch();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Collaborate on pull requests/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Collaborate on pull requests' });

    const row = drawer.querySelector('[data-vs-pull="42"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Review the code/ }));

    // The drawer is gone and the review has the window to itself.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Collaborate on pull requests' })).toBeNull());
    await waitFor(() => expect(screen.queryByText(/Select a file or folder/)).toBeNull());
    await screen.findByText(/The Spec/);

    const mounts = impl.mock.calls.filter(([u, i]) => String(u).endsWith('/pulls/42/mount') && (i as RequestInit | undefined)?.method === 'POST');
    expect(mounts).toHaveLength(1);

    // The review's way back is labelled `← Pull requests`, so it lands on the list — and
    // the list is the drawer now. Landing on the file view instead would make the button
    // name something the click does not do.
    fireEvent.click(screen.getByRole('button', { name: '← Pull requests' }));
    await screen.findByRole('dialog', { name: 'Collaborate on pull requests' });
  });

  it('opens a document from a PR reference and renders it read-only beside the real comment panel', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Collaborate on pull requests/ }));
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
