// @vitest-environment jsdom
/**
 * file-tree-write.test.tsx — the create/rename controls in the tree column
 * (Unit 5: R-5.1, R-5.2, R-5.3, R-5.6, R-5.7, R-5.8, R-5.9).
 *
 * `FileTree` is mounted directly with stub callbacks, so what is asserted here is
 * the request the tree issues and the text the author reads back — not the shell's
 * navigation, which `file-tree-write-app.test.tsx` drives through `<App />`.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from './file-tree';
import type { TreeEntry } from './use-tree';

const ENTRIES: TreeEntry[] = [
  { path: 'notes', name: 'notes', type: 'dir' },
  { path: 'notes/kickof.md', name: 'kickof.md', type: 'file', kind: 'markdown' },
];

type Call = { url: string; method: string; body: unknown };

/** A `fetch` that records every call and answers with one canned response. */
function fakeFetch(response: { ok: boolean; status: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: response.ok, status: response.status, json: async () => response.json } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function mount(overrides: Partial<Parameters<typeof FileTree>[0]> = {}) {
  const onCreated = vi.fn();
  const onRenamed = vi.fn();
  render(<FileTree entries={ENTRIES} current="" filter="" onPick={() => {}} onCreated={onCreated} onRenamed={onRenamed} {...overrides} />);
  return { onCreated, onRenamed };
}

const beginRename = (path: string) => {
  // Folders start collapsed, so the row has to be revealed before it can be hovered.
  const folder = screen.queryByTitle('notes — expand');
  if (folder) fireEvent.click(folder);
  fireEvent.mouseEnter(screen.getByTitle(path).parentElement as HTMLElement);
  fireEvent.click(screen.getByLabelText(`Rename ${path}`));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('R-5.1 / R-5.2 / R-5.3 — the New file control and its inline input', () => {
  it('opens a single-line input in the tree column and posts what was typed', async () => {
    const calls = fakeFetch({ ok: true, status: 200, json: { path: 'notes/kickoff.md', root: '/w' } });
    const { onCreated } = mount();

    // Nothing is asked for until the control is activated (R-5.2).
    expect(screen.queryByLabelText('New file path')).toBeNull();
    fireEvent.click(screen.getByText('+ New file'));

    const input = screen.getByLabelText('New file path') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT'); // a field, not a modal
    fireEvent.change(input, { target: { value: 'notes/kickoff.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: '/__vs/tree/create', method: 'POST', body: { path: 'notes/kickoff.md' } });
    // R-5.6 — the input is dismissed on success, and the caller gets the server's path.
    await waitFor(() => expect(screen.queryByLabelText('New file path')).toBeNull());
    expect(onCreated).toHaveBeenCalledWith('notes/kickoff.md');
  });

  it('reopens the create input empty rather than holding the last value (R-5.6)', async () => {
    fakeFetch({ ok: true, status: 200, json: { path: 'a.md', root: '/w' } });
    mount();

    fireEvent.click(screen.getByText('+ New file'));
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'a.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByLabelText('New file path')).toBeNull());

    fireEvent.click(screen.getByText('+ New file'));
    expect((screen.getByLabelText('New file path') as HTMLInputElement).value).toBe('');
  });
});

describe('R-5.2 — rename is offered on the row, prefilled with that row‘s path', () => {
  it('prefills the current path so a typo is an edit, not a retype', async () => {
    const calls = fakeFetch({ ok: true, status: 200, json: { path: 'notes/kickoff.md', root: '/w' } });
    const { onRenamed } = mount();

    beginRename('notes/kickof.md');
    const input = screen.getByLabelText('Rename path') as HTMLInputElement;
    expect(input.value).toBe('notes/kickof.md');

    fireEvent.change(input, { target: { value: 'notes/kickoff.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: '/__vs/tree/rename', method: 'POST', body: { from: 'notes/kickof.md', to: 'notes/kickoff.md' } });
    expect(onRenamed).toHaveBeenCalledWith('notes/kickof.md', 'notes/kickoff.md');
  });
});

describe('R-5.7 — the server’s own words, and the typed path kept', () => {
  it('renders a 400 verbatim and leaves what was typed in the field', async () => {
    const message = 'refused .txt: only .md files can be created here (got notes/kickoff.txt)';
    fakeFetch({ ok: false, status: 400, json: { error: message } });
    const { onCreated } = mount();

    fireEvent.click(screen.getByText('+ New file'));
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'notes/kickoff.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The exact sentence, not a flattened "could not create file".
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect((screen.getByLabelText('New file path') as HTMLInputElement).value).toBe('notes/kickoff.txt');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('renders a 409 collision verbatim on rename, keeping the typed path', async () => {
    const message = 'notes/kickoff.md already exists';
    fakeFetch({ ok: false, status: 409, json: { error: message } });
    const { onRenamed } = mount();

    beginRename('notes/kickof.md');
    fireEvent.change(screen.getByLabelText('Rename path'), { target: { value: 'notes/kickoff.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect((screen.getByLabelText('Rename path') as HTMLInputElement).value).toBe('notes/kickoff.md');
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('renders a 400 naming the missing parent directory verbatim', async () => {
    const message = 'cannot rename into archive: the directory archive does not exist';
    fakeFetch({ ok: false, status: 400, json: { error: message } });
    mount();

    beginRename('notes/kickof.md');
    fireEvent.change(screen.getByLabelText('Rename path'), { target: { value: 'archive/kickoff.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });
});

describe('R-5.8 / R-5.9 — one request per submit, none on dismissal', () => {
  it('disables submit while a request is in flight and issues no second request', async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
        await pending;
        return { ok: true, status: 200, json: async () => ({ path: 'a.md', root: '/w' }) } as Response;
      }),
    );
    mount();

    fireEvent.click(screen.getByText('+ New file'));
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'a.md' } });
    const submit = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => expect(submit.disabled).toBe(true));
    fireEvent.click(submit);
    fireEvent.submit(submit.closest('form') as HTMLFormElement);
    expect(calls).toHaveLength(1);

    release();
    await waitFor(() => expect(screen.queryByLabelText('New file path')).toBeNull());
    expect(calls).toHaveLength(1);
  });

  it('issues no request when the input is dismissed without submitting', () => {
    const calls = fakeFetch({ ok: true, status: 200, json: {} });
    mount();

    fireEvent.click(screen.getByText('+ New file'));
    fireEvent.change(screen.getByLabelText('New file path'), { target: { value: 'notes/kickoff.md' } });
    fireEvent.click(screen.getByLabelText('Cancel'));
    expect(screen.queryByLabelText('New file path')).toBeNull();

    beginRename('notes/kickof.md');
    fireEvent.keyDown(screen.getByLabelText('Rename path'), { key: 'Escape' });
    expect(screen.queryByLabelText('Rename path')).toBeNull();

    expect(calls).toHaveLength(0);
  });
});
