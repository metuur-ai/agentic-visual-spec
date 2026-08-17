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
  /** The local sidecar's notes, which decide whether the control is promoted. */
  comments?: unknown[];
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
    if (url.startsWith('/__vs/comments')) return jsonRes(server.comments ?? []);
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
  const button = await screen.findByRole('button', { name: 'Start collaboration' });
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
    expect(await screen.findByRole('button', { name: 'Start collaboration' })).toBeTruthy();
  });

  it('is absent for a file that is not markdown', async () => {
    installFetch();
    render(<MainHeader file="src/index.ts" onModeChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'More: help and history' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start collaboration' })).toBeNull();
  });

  it('is absent where collaboration is not configured (R-7.8)', async () => {
    installFetch({ availability: { available: false, reason: 'no_credential', message: 'Collaboration is unavailable: no GitHub credential is configured.' } });
    render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'More: help and history' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start collaboration' })).toBeNull();
  });
});

/*
 * The draft loop's last step, marked at the moment it becomes the next one.
 *
 * The control was `secondary` unconditionally, so the header read identically whether
 * the author had a page of unaddressed notes or a document they had worked all the way
 * through. These pin the condition rather than the colour: "notes that were applied, and
 * none still open", on THIS file. Weight is asserted through `data-vs-start-pr-ready`,
 * because a test that read the violet out of the style attribute would fail the next
 * time the violet changed and pass the next time the condition broke.
 */
describe('“Start collaboration” is promoted only when the notes are worked through', () => {
  const note = (id: string, status: 'open' | 'applied', path = FILE) => ({
    id,
    workflow: 'visual-spec',
    target: { path, kind: 'range', startLine: 3, heading: 'For comment' },
    comment: 'needs a citation',
    status,
    ts: '2026-08-08T00:00:00.000Z',
    replies: [],
  });

  const start = async (server: Server) => {
    installFetch(server);
    render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
    return screen.findByRole('button', { name: /Start collaboration/ });
  };

  it('is promoted once every note on the file has been applied', async () => {
    const button = await start({ comments: [note('c-1', 'applied'), note('c-2', 'applied')] });
    await waitFor(() => expect(button.getAttribute('data-vs-start-pr-ready')).toBe('true'));
    // Colour is not the only carrier of the state (WCAG 1.4.1).
    expect(button.querySelector('svg')).toBeTruthy();
  });

  /*
   * Each negative waits on the Apply button's COUNT before asserting. The count is
   * rendered from the same loaded notes, so it is proof they arrived — without it these
   * would pass on the first frame, when nothing has loaded and the attribute is absent
   * for a reason that has nothing to do with the rule being tested.
   */
  const notesLoaded = (openCount: number) =>
    waitFor(() =>
      expect(
        screen.getByRole('button', { name: new RegExp(`Apply ${openCount} comment${openCount === 1 ? '' : 's'}$`) }),
      ).toBeTruthy(),
    );

  it('is not promoted while a note is still open', async () => {
    const button = await start({ comments: [note('c-1', 'applied'), note('c-2', 'open')] });
    await notesLoaded(1);
    expect(button.getAttribute('data-vs-start-pr-ready')).toBeNull();
  });

  /*
   * The half that keeps the promotion meaning something. This file has no notes, so it
   * has no open ones either — and promoting on that alone would announce readiness about
   * a document that has been through nothing. The applied note next door is not this
   * document's readiness, and the open one beside it is only here to prove the load.
   */
  it('is not promoted on a file with no notes, whatever other files hold', async () => {
    const button = await start({
      comments: [note('c-1', 'applied', 'docs/other.md'), note('c-2', 'open', 'docs/other.md')],
    });
    await notesLoaded(1);
    expect(button.getAttribute('data-vs-start-pr-ready')).toBeNull();
  });
});

/*
 * R-8.34 / R-8.35 — putting more than one file on the same pull request.
 *
 * The candidate set is the load-bearing decision. "Every markdown file" would be a file
 * picker, and the author already has one of those in the sidebar. The useful set is the
 * files they have been leaving notes on, which the sidecar already knows — so these pin
 * that the offer is derived from the author's own work rather than from a folder.
 */
describe('starting a collaboration on more than one file', () => {
  const OTHER = 'docs/rules.md';
  const OTHER_MARKDOWN = '# Rules\n\nthe companion body.\n';

  const note = (id: string, path: string) => ({
    id,
    workflow: 'visual-spec',
    target: { path, kind: 'range', startLine: 3, heading: 'h' },
    comment: 'needs a citation',
    status: 'open',
    ts: '2026-08-08T00:00:00.000Z',
    replies: [],
  });

  /** The file route answers for whichever path is asked for, so companions read too. */
  const fileRead = () => {
    const bodies: Record<string, string> = { [FILE]: MARKDOWN, [OTHER]: OTHER_MARKDOWN };
    return (url: string) => {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? FILE;
      const content = bodies[path] ?? '';
      return jsonRes({ path, kind: 'markdown', content, size: content.length });
    };
  };

  async function openWithCandidates(comments: unknown[]) {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const answer = fileRead();
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
      if (url === '/__vs/git') return jsonRes({ state: 'none' });
      if (url === '/__vs/git/branches') return jsonRes({ error: 'no route' }, 404);
      if (url === '/__vs/collab') return jsonRes(CONFIGURED);
      if (url === '/__vs/collab/start') return jsonRes({ ok: true, jobId: 'job-1', kind: 'create' });
      if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
      if (url.startsWith('/__vs/tree/file')) return answer(url);
      if (url.startsWith('/__vs/comments')) return jsonRes(comments);
      if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', impl);
    render(<MainHeader file={FILE} isMarkdown onModeChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Start collaboration/ }));
    return calls;
  }

  it('offers the files that carry notes, and offers them unticked', async () => {
    await openWithCandidates([note('c-1', OTHER), note('c-2', FILE)]);

    const box = await screen.findByRole('checkbox', { name: new RegExp(OTHER) });
    // R-8.34 — the default selection is the open file alone.
    expect((box as HTMLInputElement).checked).toBe(false);
    // The document is stated, not offered: it is not the author's to untick.
    expect(screen.queryByRole('checkbox', { name: new RegExp(FILE) })).toBeNull();
  });

  it('offers nothing at all when no other file carries notes', async () => {
    await openWithCandidates([note('c-2', FILE)]);
    await screen.findByPlaceholderText('for-comment');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  /* R-8.35 — offered is not chosen. An untouched picker sends the single-file request. */
  it('sends no files array when nothing was ticked', async () => {
    const calls = await openWithCandidates([note('c-1', OTHER)]);
    await screen.findByRole('checkbox', { name: new RegExp(OTHER) });
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(bodyOf(calls, '/__vs/collab/start')).toBeTruthy());
    const body = bodyOf(calls, '/__vs/collab/start')!;
    expect(body).toMatchObject({ documentPath: FILE, markdown: MARKDOWN });
    expect(body).not.toHaveProperty('files');
  });

  it('sends the document and every ticked file, each with its own bytes', async () => {
    const calls = await openWithCandidates([note('c-1', OTHER)]);
    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(OTHER) }));
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(bodyOf(calls, '/__vs/collab/start')?.files).toBeTruthy());
    const body = bodyOf(calls, '/__vs/collab/start')!;
    // The document stays `documentPath` — the collaboration still has exactly one (R-8.30).
    expect(body.documentPath).toBe(FILE);
    expect(body.files).toEqual([
      { path: FILE, markdown: MARKDOWN },
      { path: OTHER, markdown: OTHER_MARKDOWN },
    ]);
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
