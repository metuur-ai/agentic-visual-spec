// @vitest-environment jsdom
/**
 * file-comment-label.test.tsx — a whole-file comment has no line, and no label may
 * pretend otherwise.
 *
 * The defect these tests pin: a `CommentRecord` whose target is `{ path, kind: 'file' }`
 * carries no `startLine`. Two labels interpolated it unguarded — `· L${c.target.startLine}`
 * — and rendered the literal string "Lundefined" beside the heading in the browser:
 *
 *   ui/comment-panel.tsx  — the open-list row label in the sidebar
 *   ui/main-header.tsx    — the AllComments dropdown behind the header's comment counter
 *
 * It is reachable from ordinary use, not just from curl: `POST /__vs/comments/add` with
 * only `{ path, comment }` — the "comment on this whole file" flow — produces exactly
 * that record.
 *
 * Worth saying plainly, because it is what makes this a regression suite rather than a
 * nicety: the guard already existed a few hundred lines up, in main-header.tsx's
 * "Pick comments…" list (`c.target.startLine != null ? ... : ''`). The pattern was known;
 * these two labels were written without it. So each case below is paired with a
 * `startLine`-bearing comment asserting `· L<n>` is still rendered — a guard that drops
 * the line suffix unconditionally would hide the defect and lose the feature, and must
 * fail here too.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorProvider } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import { CommentPanel } from './comment-panel';
import { MainHeader } from './main-header';

const PATH = 'docs/spec.md';

/** What `POST /__vs/comments/add` with only `{ path, comment }` stores: no `startLine`. */
const FILE_COMMENT = {
  id: 'c-file',
  workflow: 'visual-spec',
  target: { path: PATH, kind: 'file' },
  comment: 'this whole file needs a rewrite',
  status: 'open',
  ts: '2026-08-08T00:00:00.000Z',
} as unknown as CommentRecord;

/** The ordinary case the guard must not swallow. */
const LINE_COMMENT = {
  id: 'c-line',
  workflow: 'visual-spec',
  target: { path: PATH, kind: 'range', startLine: 42, heading: 'The Spec' },
  comment: 'needs a citation',
  status: 'open',
  ts: '2026-08-08T00:00:00.000Z',
} as unknown as CommentRecord;

/** jsdom has no `EventSource`; `ApplyButton` inside `MainHeader` opens one unconditionally. */
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

function installFetch(comments: CommentRecord[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/__vs/comments') ? comments : url === '/__vs/git' ? { state: 'none' } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ================================================================== *
 * ui/main-header.tsx — the AllComments dropdown
 * ================================================================== */
describe('the header cart dropdown labels a whole-file comment without inventing a line', () => {
  /** Open the dropdown the way a user does: click the comment counter in the header. */
  async function openCart(comments: CommentRecord[]) {
    installFetch(comments);
    render(<MainHeader file={PATH} />);
    const counter = await screen.findByTitle('View all collected comments');
    await waitFor(() => expect(counter.textContent).toContain(String(comments.length)));
    fireEvent.click(counter);
    return await screen.findByText(/comments? collected/);
  }

  it('renders no "Lundefined" for a file-level comment, and still names the anchor', async () => {
    const pop = (await openCart([FILE_COMMENT])).parentElement as HTMLElement;
    const text = pop.textContent ?? '';
    // The exact rendering the user saw: "(top) · Lundefined".
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Lundefined');
    // The row is still labelled — the fix omits the line suffix, it does not blank the row.
    expect(text).toContain('(top)');
    expect(text).toContain('this whole file needs a rewrite');
  });

  it('still shows · L<n> when the comment does have a line', async () => {
    const pop = (await openCart([LINE_COMMENT])).parentElement as HTMLElement;
    const text = pop.textContent ?? '';
    expect(text).toContain('The Spec · L42');
    expect(text).not.toContain('undefined');
  });

  it('with both in the cart, only the file-level one loses its line suffix', async () => {
    const pop = (await openCart([FILE_COMMENT, LINE_COMMENT])).parentElement as HTMLElement;
    const text = pop.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).toContain('(top)');
    expect(text).toContain('The Spec · L42');
  });
});

/* ================================================================== *
 * ui/comment-panel.tsx — the sidebar's open-list row label
 * ================================================================== */
describe('the comment panel labels a whole-file comment without inventing a line', () => {
  /** Mounted exactly as markdown-editor.tsx mounts local mode. */
  function mountPanel(comments: CommentRecord[]) {
    installFetch(comments);
    render(
      <InspectorProvider surfaceId={PATH} pageIndex={0}>
        <CommentPanel file={PATH} width={320} />
      </InspectorProvider>,
    );
  }

  it('renders no "Lundefined" for a file-level comment, and still names the anchor', async () => {
    mountPanel([FILE_COMMENT]);
    const row = await screen.findByText('this whole file needs a rewrite');
    const card = row.parentElement as HTMLElement;
    const text = card.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Lundefined');
    expect(screen.getByText('(top)')).toBeTruthy();
  });

  it('still shows · L<n> when the comment does have a line', async () => {
    mountPanel([LINE_COMMENT]);
    await waitFor(() => expect(screen.getByText('needs a citation')).toBeTruthy());
    expect(screen.getByText('The Spec · L42')).toBeTruthy();
    expect(document.body.textContent).not.toContain('undefined');
  });
});
