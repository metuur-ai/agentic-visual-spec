// @vitest-environment jsdom
/**
 * branch-switch-app.test.tsx — what only the shell can answer (R-6.5, R-6.7, R-6.8).
 *
 * The chip's own half is in `ui/git-branch-switch.test.tsx`. These three requirements
 * are not in the chip at all: the dirty buffer, the unsaved-changes dialog, the file
 * tree and the open pane all belong to `ui/App.tsx`, and a test that mounted the
 * header alone would assert that it *asked* — which it does — while proving nothing
 * about what happened next.
 *
 * WHICH EDITOR IS GUARDED. `MarkdownDocEditor`, the main document editor, and the
 * stub below stands in for it exactly as `file-tree-write-app.test.tsx` does — it
 * drags in Lexical, which does not survive jsdom. The stub reports itself dirty
 * through the real `onStateChange` contract, so the machinery under test is App's own.
 * `CollabEditor` can also hold unsaved work and is deliberately NOT guarded: it lives
 * inside `CollabApp`, which this component returns early, so it and the switcher are
 * never on screen together.
 */
import './prism-global'; // must precede @lyfie/luthor
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { invalidateTree } from './use-tree';

/** Dirty from the moment it mounts — the state the guard exists for. */
vi.mock('./markdown-doc-editor', () => ({
  MarkdownDocEditor: ({ path, onStateChange }: { path: string; onStateChange?: (s: { dirty: boolean; save: () => Promise<boolean> }) => void }) => {
    onStateChange?.({ dirty: true, save: async () => true });
    return <div data-testid="pane-edit">{path}</div>;
  },
}));

const REMOTE_GITHUB = {
  state: 'remote',
  branch: 'main',
  detached: false,
  owner: 'acme',
  repo: 'docs',
  host: 'github.com',
  url: 'git@github.com:acme/docs.git',
};

const LISTING = { local: [{ name: 'main', current: true }, { name: 'feature/x', current: false }], remote: [] };

const WITH_SPEC = [
  { path: 'docs', name: 'docs', type: 'dir' },
  { path: 'docs/spec.md', name: 'spec.md', type: 'file', kind: 'markdown' },
];
/** The same repository on a branch that never had the file. */
const WITHOUT_SPEC = [
  { path: 'docs', name: 'docs', type: 'dir' },
  { path: 'docs/other.md', name: 'other.md', type: 'file', kind: 'markdown' },
];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

/**
 * `trees` is read one entry per `/__vs/tree` call, holding on the last — so a test can
 * say "this branch has the file, the next one does not" without timing anything.
 */
function installFetch({ trees, checkout }: { trees: unknown[]; checkout?: () => Response }) {
  const queue = [...trees];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/tree') return jsonRes(queue.length > 1 ? queue.shift() : queue[0]);
    if (url === '/__vs/git') return jsonRes(REMOTE_GITHUB);
    if (url === '/__vs/git/branches') return jsonRes(LISTING);
    if (url === '/__vs/git/checkout') return (checkout ?? (() => jsonRes({ context: { ...REMOTE_GITHUB, branch: 'feature/x' } })))();
    if (url === '/__vs/collab') return jsonRes({ available: false, reason: 'not-configured', message: 'off', missingScopes: [] });
    if (url.startsWith('/__vs/comments')) return jsonRes([]);
    if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
    if (url === '/__vs/source/list') return jsonRes([]);
    if (url.startsWith('/__vs/source')) return jsonRes({ source: '# The Spec\n\nFirst paragraph.\n' });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

/** jsdom has no `EventSource`; the shell opens one unconditionally. */
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  // The tree cache is module-level and outlives a test; start cold so the re-read a
  // branch change forces is observable as a second GET.
  invalidateTree();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sidebar = () => within(document.querySelector('nav') as HTMLElement);
const checkoutCalls = (impl: ReturnType<typeof installFetch>) =>
  impl.mock.calls.filter(([u]) => String(u) === '/__vs/git/checkout');
const treeReads = (impl: ReturnType<typeof installFetch>) => impl.mock.calls.filter(([u]) => String(u) === '/__vs/tree').length;

/** Opens `docs/spec.md`, and puts it in Edit mode when asked — where it reports dirty. */
async function openSpec(editing: boolean) {
  await screen.findByText('+ New file');
  fireEvent.click(sidebar().getByTitle('docs — expand'));
  fireEvent.click(sidebar().getByTitle('docs/spec.md'));
  if (editing) {
    fireEvent.click(await screen.findByRole('tab', { name: 'Edit' }));
    await screen.findByTestId('pane-edit');
  }
  return await screen.findByTestId('git-branch-switch');
}

describe('unsaved work in the main document editor (R-6.5)', () => {
  it('presents the existing confirmation, and issues nothing until it is answered', async () => {
    const impl = installFetch({ trees: [WITH_SPEC] });
    render(<App />);
    const switcher = await openSpec(true);

    fireEvent.click(switcher);
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    // The dialog App already uses for leaving Edit and for switching file — the same
    // one, not a second prompt written for this path.
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    expect(dialog.textContent).toContain('changing branch');
    expect(checkoutCalls(impl)).toEqual([]);

    fireEvent.click(within(dialog).getByText('Discard'));
    await waitFor(() => expect(checkoutCalls(impl)).toHaveLength(1));
  });

  it('cancelling issues nothing and leaves the buffer where it was', async () => {
    const impl = installFetch({ trees: [WITH_SPEC] });
    render(<App />);
    const switcher = await openSpec(true);

    fireEvent.click(switcher);
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    fireEvent.click(within(dialog).getByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).toBeNull());
    expect(checkoutCalls(impl)).toEqual([]);
    // Still the same editor on the same document, still in Edit.
    expect((await screen.findByTestId('pane-edit')).textContent).toBe('docs/spec.md');
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a clean editor is not asked about at all', async () => {
    const impl = installFetch({ trees: [WITH_SPEC] });
    render(<App />);
    const switcher = await openSpec(false);

    fireEvent.click(switcher);
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    await waitFor(() => expect(checkoutCalls(impl)).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).toBeNull();
  });
});

describe('after a successful change (R-6.7 / R-6.8)', () => {
  it('re-reads the file tree', async () => {
    const impl = installFetch({ trees: [WITH_SPEC] });
    render(<App />);
    const switcher = await openSpec(false);
    const before = treeReads(impl);

    fireEvent.click(switcher);
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    // R-6.7 — the tree on the new branch is a different tree, and nothing else would
    // have told the sidebar so.
    await waitFor(() => expect(treeReads(impl)).toBe(before + 1));
  });

  it('returns to the empty state when the open file is not on the new branch', async () => {
    const impl = installFetch({ trees: [WITH_SPEC, WITHOUT_SPEC] });
    render(<App />);
    const switcher = await openSpec(false);
    expect(screen.queryByText(/Select a file or folder/)).toBeNull();

    fireEvent.click(switcher);
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    // R-6.8 — not the previous branch's bytes under the new branch's name.
    await waitFor(() => expect(screen.getByText(/Select a file or folder/)).toBeTruthy());
    expect(screen.queryByText('First paragraph.')).toBeNull();
    // And the sidebar is showing the new branch's tree, not the one it was walked on.
    await waitFor(() => expect(sidebar().queryByTitle('docs/spec.md')).toBeNull());
    expect(checkoutCalls(impl)).toHaveLength(1);
  });

  it('keeps the open file when the new branch still has it', async () => {
    installFetch({ trees: [WITH_SPEC] });
    render(<App />);
    const switcher = await openSpec(false);

    fireEvent.click(switcher);
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    await waitFor(() => expect(screen.getByTestId('git-branch-switch').textContent).toContain('feature/x'));
    // The pane did not empty itself out of caution — R-6.8 is about a file that is
    // gone, and clearing on every change would lose the reader's place for nothing.
    expect(screen.queryByText(/Select a file or folder/)).toBeNull();
  });
});
