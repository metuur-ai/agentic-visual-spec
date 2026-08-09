// @vitest-environment jsdom
/**
 * start-pull-request.test.tsx — a pull request for the file that is already open (R-8.5).
 *
 * The defect these pin is not "the route is wrong" — `POST /__vs/collab/start` has always
 * accepted an arbitrary `documentPath` and an initial `markdown`. It is that the only
 * caller sent neither, so an author holding a written file had no way to put *it* under
 * review: the UI could create a new empty document under `documents/` and nothing else.
 *
 * So the load-bearing assertions here are on the request body: the file's OWN path, and
 * the bytes it currently holds.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainHeader, documentIdFromPath } from './main-header';

const CONFIGURED = { available: true, login: 'author-ana', repo: { owner: 'acme', repo: 'docs', baseBranch: 'main' }, scopes: [] };
const FILE = 'test/javier/for-comment.md';
const MARKDOWN = '# For comment\n\nThe body the author actually wrote.\n';

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

type Server = {
  availability?: unknown;
  /** What `GET /__vs/tree/file` answers for the open file. */
  fileRead?: () => Response;
  /** What `POST /__vs/collab/start` answers. */
  start?: () => Response;
};

function installFetch(server: Server = {}) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
    if (url === '/__vs/git') return jsonRes({ state: 'none' });
    if (url === '/__vs/git/branches') return jsonRes({ error: 'no route' }, 404);
    if (url === '/__vs/collab') return jsonRes(server.availability ?? CONFIGURED);
    if (url === '/__vs/collab/start') return (server.start ?? (() => jsonRes({ ok: true, jobId: 'job-1', kind: 'create' })))();
    if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
    if (url.startsWith('/__vs/tree/file')) return (server.fileRead ?? (() => jsonRes({ path: FILE, kind: 'markdown', content: MARKDOWN, size: MARKDOWN.length })))();
    if (url.startsWith('/__vs/comments')) return jsonRes([]);
    if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

/** jsdom has no `EventSource`; `ApplyButton` opens one unconditionally. */
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const type = (labelText: string, value: string) =>
  fireEvent.change(screen.getByText(labelText).parentElement?.querySelector('input') as HTMLInputElement, { target: { value } });

type Calls = ReturnType<typeof installFetch>;

const bodyOf = (calls: Calls, url: string): Record<string, unknown> | undefined =>
  calls.filter((c) => c.url === url).at(-1)?.body as Record<string, unknown> | undefined;

const urls = (calls: Calls) => calls.map((c) => c.url);

async function openForm(server: Server = {}, file = FILE) {
  const calls = installFetch(server);
  const onResumeCollab = vi.fn();
  render(<MainHeader file={file} isMarkdown onModeChange={() => {}} actions={{ onResumeCollab }} />);
  const button = await screen.findByRole('button', { name: 'Start pull request' });
  fireEvent.click(button);
  return { calls, onResumeCollab };
}

describe('the document id derived from the file name', () => {
  it('sanitizes what a file name may hold and an id may not', () => {
    expect(documentIdFromPath('test/javier/for-comment.md')).toBe('for-comment');
    expect(documentIdFromPath('docs/Payment Rules.md')).toBe('payment-rules');
    expect(documentIdFromPath('notes/2026 · plan (draft).md')).toBe('2026-plan-draft');
    expect(documentIdFromPath('keep_underscores.md')).toBe('keep_underscores');
    // The pattern anchors on an alphanumeric, so a leading run of anything else goes.
    expect(documentIdFromPath('-leading.md')).toBe('leading');
    // Nothing survives sanitizing — the form asks rather than inventing a name.
    expect(documentIdFromPath('---.md')).toBe('');
  });
});

describe('R-8.5 — where the control appears at all', () => {
  it('is offered for an open markdown file on a configured repository', async () => {
    installFetch();
    render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Start pull request' })).toBeTruthy();
  });

  it('is absent for a file that is not markdown', async () => {
    installFetch();
    render(<MainHeader file="src/index.ts" onModeChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'History' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start pull request' })).toBeNull();
  });

  it('is absent where collaboration is not configured (R-7.8)', async () => {
    installFetch({ availability: { available: false, reason: 'no_credential', message: 'Collaboration is unavailable: no GitHub credential is configured.' } });
    render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'History' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start pull request' })).toBeNull();
  });
});

describe('R-8.5 — the request carries the open file, not a new empty one', () => {
  it('posts the file’s own path and the bytes it holds', async () => {
    const { calls, onResumeCollab } = await openForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(onResumeCollab).toHaveBeenCalledWith('for-comment'));
    expect(bodyOf(calls, '/__vs/collab/start')).toEqual({
      documentId: 'for-comment',
      // NOT `documents/for-comment.md`. The file keeps the path it already has, so the
      // branch never holds the same document twice.
      documentPath: FILE,
      markdown: MARKDOWN,
    });
  });

  it('reads the file’s content at the moment the author asks, from its own path', async () => {
    const { calls } = await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));
    await waitFor(() => expect(bodyOf(calls, '/__vs/collab/start')).toBeTruthy());
    expect(urls(calls)).toContain(`/__vs/tree/file?path=${encodeURIComponent(FILE)}`);
  });

  // The omitted half is the `toEqual` above: no `title` key at all when none was typed.
  it('sends the title when there is one', async () => {
    const { calls } = await openForm();
    type('Title', 'For comment');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));
    await waitFor(() => expect(bodyOf(calls, '/__vs/collab/start')?.title).toBe('For comment'));
  });

  it('lets the author correct the derived id, and posts the corrected one', async () => {
    const { calls } = await openForm();
    type('Document id', 'payment-rules');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));
    await waitFor(() => expect(bodyOf(calls, '/__vs/collab/start')?.documentId).toBe('payment-rules'));
  });

  it('asks for an id the file name could not supply, rather than posting one it invented', async () => {
    const { calls } = await openForm({}, 'docs/---.md');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(screen.getByText(/Enter a document id/)).toBeTruthy());
    expect(urls(calls)).not.toContain('/__vs/collab/start');
  });

  it('refuses an id the route would refuse, in the route’s own terms', async () => {
    const { calls } = await openForm();
    type('Document id', 'has spaces');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(screen.getByText(/invalid documentId: has spaces/)).toBeTruthy());
    expect(urls(calls)).not.toContain('/__vs/collab/start');
  });
});

describe('R-9.7 / R-12.5 — a session that cannot create says so, in the server’s words', () => {
  it('replaces the form with the server’s reason rather than offering a button that fails', async () => {
    const message = 'acme/docs was not found. Check the repository name in your visual-spec config.';
    await openForm({ availability: { ...CONFIGURED, canPublish: false, publishBlocked: { reason: 'no_repo', message } } });

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull();
  });

  it('falls back to a sentence naming write access when the server sends only the boolean', async () => {
    await openForm({ availability: { ...CONFIGURED, canPublish: false } });
    await waitFor(() => expect(screen.getByText(/no write access to acme\/docs/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull();
  });

  it('offers the form when write access could not be determined, because the route still refuses', async () => {
    await openForm();
    expect(screen.getByRole('button', { name: 'Create pull request' })).toBeTruthy();
  });
});

describe('the server’s failure reaches the author verbatim (R-11.4)', () => {
  it('shows the refusal as reported, not as a generic error', async () => {
    const message = 'create is available to the document author only: the GitHub credential has no write access to acme/docs.';
    const { onResumeCollab } = await openForm({ availability: { ...CONFIGURED, canPublish: true }, start: () => jsonRes({ error: message }, 403) });

    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(onResumeCollab).not.toHaveBeenCalled();
  });

  it('says the file could not be read instead of committing nothing under its name', async () => {
    const { calls } = await openForm({ fileRead: () => jsonRes({ error: 'gone' }, 404) });

    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(screen.getByText(new RegExp(`Could not read ${FILE}`))).toBeTruthy());
    expect(urls(calls)).not.toContain('/__vs/collab/start');
  });
});
