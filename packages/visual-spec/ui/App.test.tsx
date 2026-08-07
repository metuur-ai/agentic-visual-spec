// @vitest-environment jsdom
/**
 * App.test.tsx — task U-1: the collaboration UI must be *reachable* from the app
 * shell, not merely correct in isolation.
 *
 * Every collaboration module (`collab-open-panel`, `collab-document-view`,
 * `collab-comment-source`, `use-collab-document`) already has its own unit suite
 * mounting it directly. None of that proves App.tsx ever renders them — and before
 * this task it did not: `App.tsx` had zero references to `collab`. This suite drives
 * the whole thing through `<App />`, exactly as a browser would load it, and checks
 * that a reviewer can get from the file-tree shell to a rendered document and its
 * comments and back.
 */
import './prism-global'; // must precede @lyfie/luthor
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import type { CommentRecord } from '../core/editing/comment-doc';
import { App } from './App';

/** A minimal but real collaboration document — one anchored paragraph, one orphan target. */
const DOCUMENT: CollaborationDocument = {
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'The Spec',
  frontmatter: {},
  nodes: [{ id: 'n-1', type: 'paragraph', version: 2, content: 'First paragraph.' }],
  doc: {
    root: {
      type: 'root',
      children: [{ type: 'paragraph', version: 1, $: { nodeId: 'n-1' }, children: [{ type: 'text', text: 'First paragraph.' }] }],
    },
  },
};

const ANCHORED_COMMENT: CommentRecord = {
  id: 'c-anchored',
  workflow: 'visual-spec',
  target: { path: 'docs/spec.md', kind: 'file' },
  comment: 'needs a citation',
  status: 'open',
  ts: '2026-08-07T00:00:00.000Z',
  // trailer carries the nodeId the comment resolves against (collab-comment-source.ts)
  collab: { nodeId: 'n-1' },
} as CommentRecord;

const ORPHAN_COMMENT: CommentRecord = {
  id: 'c-orphan',
  workflow: 'visual-spec',
  target: { path: 'docs/spec.md', kind: 'file' },
  comment: 'this block used to say something else',
  status: 'open',
  ts: '2026-08-07T00:00:00.000Z',
  collab: { nodeId: 'n-gone', text: 'the paragraph that got deleted' },
} as CommentRecord;

const AVAILABILITY = { available: true, login: 'reviewer-rita', repo: { owner: 'acme', repo: 'docs' } };

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

/** Routes every fetch this render tree can issue: the file tree plus the collab API. */
function installFetch() {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/__vs/tree') return jsonRes([]);
    if (url === '/__vs/collab') return jsonRes(AVAILABILITY);
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

describe('the collaboration UI is mounted from App.tsx (task U-1)', () => {
  it('is unreachable through the file tree but reachable through its own route', async () => {
    render(<App />);

    // Starts in the ordinary file-tree shell.
    await waitFor(() => expect(screen.getByText(/Select a file or folder/)).toBeTruthy());
    expect(screen.queryByText(/Open a document from a pull request/)).toBeNull();

    // The entry point lives in the file shell, not inside any TreeEntry.
    fireEvent.click(screen.getByText('Review a pull request…'));

    // The whole shell swapped — file view is gone, the open panel is up.
    expect(screen.queryByText(/Select a file or folder/)).toBeNull();
    await screen.findByText(/Open a document from a pull request/);
    await screen.findByText(/Signed in as reviewer-rita/);
  });

  it('opens a document from a PR reference and renders it read-only beside the real comment panel', async () => {
    render(<App />);

    fireEvent.click(await screen.findByText('Review a pull request…'));
    await screen.findByText(/Signed in as reviewer-rita/);

    fireEvent.change(screen.getByPlaceholderText('https://github.com/owner/repo/pull/42'), {
      target: { value: 'https://github.com/acme/docs/pull/42' },
    });
    fireEvent.change(screen.getByPlaceholderText('doc-1'), { target: { value: 'doc-1' } });
    fireEvent.click(screen.getByText('Open'));

    // The canonical JSON renders, identity attributes stamped (R-7.3). The text also
    // appears in the panel as the anchored comment's quoted target, so the document
    // copy is the one carrying the identity attributes.
    const rendered = await screen.findAllByText('First paragraph.');
    const paragraph = rendered.find((el) => el.closest('[data-vs-node-id="n-1"]'));
    expect(paragraph).toBeTruthy();
    expect(paragraph!.closest('[data-vs-document-id="doc-1"]')).toBeTruthy();

    // Its existing comments are listed — anchored and orphaned alike — and the real
    // panel is mounted, so the reviewer can also write one (U-1 round trip).
    await screen.findByText('needs a citation');
    expect(screen.getByText(/this block used to say something else/)).toBeTruthy();
    expect(screen.getByText(/the paragraph that got deleted/)).toBeTruthy();
    expect(screen.getAllByLabelText('Reply').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Resolve comment').length).toBeGreaterThan(0);

    // The route swap is reversible.
    fireEvent.click(screen.getByText('← Files'));
    await waitFor(() => expect(screen.getByText(/Select a file or folder/)).toBeTruthy());
    expect(screen.queryAllByText('First paragraph.')).toHaveLength(0);
  });
});
