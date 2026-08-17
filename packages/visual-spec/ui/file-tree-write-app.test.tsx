// @vitest-environment jsdom
/**
 * file-tree-write-app.test.tsx — closing the loop in the shell (R-5.4, R-5.5).
 *
 * The mechanics of the inline input are covered by `file-tree-write.test.tsx`.
 * What only `<App />` can show is what happens *after* a 200: the client tree is
 * re-read, the main pane lands on the written path, and a create lands in Edit —
 * "ready to edit" is the point of the feature, not a nicety.
 */
import './prism-global'; // must precede @lyfie/luthor
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { invalidateTree } from './use-tree';

// Only the *edit* pane is stood in for, and only because it drags in the Lexical
// editor, which does not survive jsdom. The view pane is the real component: it
// used to be stubbed as well, but that was collateral from the `hot.off` bug in
// useMarkdownSource — unmounting it threw and took the tree down. With that fixed
// the real pane mounts, so the assertions read the path off what it actually
// renders (its ContentTitle) rather than off a stub echoing its own prop.
vi.mock('./markdown-doc-editor', () => ({
  MarkdownDocEditor: ({ path }: { path: string }) => <div data-testid="pane-edit">{path}</div>,
}));

/** The path the real view pane is showing, per the sticky title inside <main>. */
const viewPanePath = () => (document.querySelector('main > div[title]') as HTMLElement | null)?.getAttribute('title');

const TREE = [
  { path: 'notes', name: 'notes', type: 'dir' },
  { path: 'notes/kickof.md', name: 'kickof.md', type: 'file', kind: 'markdown' },
];

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

/** Routes everything this shell can ask for; unknown reads answer empty rather than throw. */
function installFetch(write: (url: string, body: unknown) => Response) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === '/__vs/tree') return jsonRes(TREE);
    if (url.startsWith('/__vs/tree/create') || url.startsWith('/__vs/tree/rename')) {
      return write(url, init?.body ? JSON.parse(init.body as string) : undefined);
    }
    if (url.startsWith('/__vs/comments')) return jsonRes([]);
    if (url === '/__vs/source/root') return jsonRes({ root: '/w' });
    if (url === '/__vs/source/list') return jsonRes([]);
    if (url.startsWith('/__vs/source')) return jsonRes({ source: '# kickoff\n\n' });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

const treeReads = (calls: string[]) => calls.filter((u) => u === '/__vs/tree').length;

/** The header also carries the open file's path as a title, so tree queries are scoped. */
const tree = () => within(document.querySelector('nav') as HTMLElement);

const expandNotes = () => fireEvent.click(tree().getByTitle('notes — expand'));

const beginRename = (path: string) => {
  fireEvent.mouseEnter(tree().getByTitle(path).parentElement as HTMLElement);
  fireEvent.click(tree().getByLabelText(`Rename ${path}`));
};

/** jsdom has no `EventSource`; the shell opens one unconditionally. */
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  // The tree cache is module-level and outlives a test; start every one cold so a
  // re-read after a write is observable as a second GET.
  invalidateTree();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('R-5.4 — a created file opens in the main pane, ready to edit', () => {
  it('re-reads the tree, navigates to the created path and lands in Edit mode', async () => {
    const calls = installFetch(() => jsonRes({ path: 'notes/kickoff.md', root: '/w' }));
    render(<App />);

    await screen.findByText('+ New file');
    await waitFor(() => expect(treeReads(calls)).toBe(1));

    fireEvent.click(screen.getByText('+ New file'));
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'notes/kickoff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The pane is the *edit* pane, on the path the server settled on — `.md` was
    // appended server-side, and the client followed that rather than what was typed.
    expect((await screen.findByTestId('pane-edit')).textContent).toBe('notes/kickoff.md');
    // And the header agrees: Edit is the selected mode, not View.
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'View' }).getAttribute('aria-selected')).toBe('false');

    // R-5.4 — the cached tree was dropped, so the sidebar re-walked.
    expect(treeReads(calls)).toBe(2);
    // R-5.6 — the input is gone.
    expect(screen.queryByLabelText('New file path')).toBeNull();
  });
});

describe('R-5.5 — the pane follows the document it is showing', () => {
  it('keeps the open document under its new path and re-reads the tree', async () => {
    const calls = installFetch(() => jsonRes({ path: 'notes/kickoff.md', root: '/w' }));
    render(<App />);

    await screen.findByText('+ New file');
    expandNotes();
    fireEvent.click(tree().getByTitle('notes/kickof.md'));
    await waitFor(() => expect(viewPanePath()).toBe('notes/kickof.md'));
    const before = treeReads(calls);

    beginRename('notes/kickof.md');
    fireEvent.change(screen.getByLabelText('Rename path'), { target: { value: 'notes/kickoff.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    // Still the same document in the same pane, now under the new path — it did not
    // go blank, and it did not fall back to "select a file".
    await waitFor(() => expect(viewPanePath()).toBe('notes/kickoff.md'));
    expect(screen.queryByText(/Select a file or folder/)).toBeNull();
    expect(treeReads(calls)).toBe(before + 1);
  });
});
