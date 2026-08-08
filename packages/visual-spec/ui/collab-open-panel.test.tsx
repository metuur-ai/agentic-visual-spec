// @vitest-environment jsdom
/**
 * collab-open-panel.test.tsx — the reviewer's entry point (R-11.2, R-11.4, R-11.5).
 *
 * `fetch` is injected, so nothing here touches a server; the assertions are on the
 * request the panel sends and on the text a reviewer actually reads back.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { CollabOpenPanel, parsePullRequestReference } from './collab-open-panel';

describe('the pull request references a reviewer actually has to hand', () => {
  it('accepts a copied URL, `#42` and a bare number, and rejects the rest', () => {
    expect(parsePullRequestReference('https://github.com/acme/docs/pull/42')).toBe(42);
    expect(parsePullRequestReference('https://github.com/acme/docs/pull/42#issuecomment-9')).toBe(42);
    expect(parsePullRequestReference('#42')).toBe(42);
    expect(parsePullRequestReference(' 42 ')).toBe(42);
    expect(parsePullRequestReference('acme/docs')).toBeNull();
    expect(parsePullRequestReference('')).toBeNull();
  });
});

const AVAILABLE = {
  available: true,
  login: 'reviewer-rita',
  repo: { owner: 'acme', repo: 'docs', baseBranch: 'main' },
  scopes: ['repo'],
};

/** A `fetch` that answers `/__vs/collab` and `/__vs/collab/open` and records both. */
function fakeFetch(openResponse: { ok: boolean; status: number; json: unknown }, availability: unknown = AVAILABLE) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
    if (url === '/__vs/collab') return { ok: true, status: 200, json: async () => availability } as unknown as Response;
    return { ok: openResponse.ok, status: openResponse.status, json: async () => openResponse.json } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const type = (labelText: string, value: string) =>
  fireEvent.change(screen.getByText(labelText).parentElement?.querySelector('input') as HTMLInputElement, { target: { value } });

describe('R-11.5 — the reviewer sees their own GitHub identity', () => {
  it('names the login comments will be attributed to', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as reviewer-rita/).textContent).toContain('reviewer-rita'));
    expect(screen.getByText(/Signed in as reviewer-rita/).textContent).toContain(
      'comments you leave here are posted to acme/docs as reviewer-rita',
    );
  });

  it('shows the availability message instead when collaboration is off (R-7.8)', async () => {
    const { impl } = fakeFetch(
      { ok: true, status: 200, json: { ok: true } },
      { available: false, reason: 'no_credential', message: 'Collaboration is unavailable: no GitHub credential is configured.' },
    );
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/no GitHub credential is configured/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('R-12.5 — a session that cannot publish says so, and says why', () => {
  it('renders the server’s reason verbatim rather than a generic review-only line', async () => {
    const message = 'acme/docs was not found. Check the repository name in your visual-spec config.';
    const { impl } = fakeFetch(
      { ok: true, status: 200, json: { ok: true } },
      { ...AVAILABLE, canPublish: false, publishBlocked: { reason: 'no_repo', message } },
    );
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  it('falls back to the review-only sentence when the server sends only the boolean', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } }, { ...AVAILABLE, canPublish: false });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/review-only session/)).toBeTruthy());
    expect(screen.getByText(/review-only session/).textContent).toContain('comment and reply but not publish');
  });

  it('says nothing at all when write access could not be determined', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());
    expect(screen.queryByText(/review-only session/)).toBeNull();
  });
});

/*
 * R-8.5 — the author's entry. Before this existed, `POST /__vs/collab/start` was
 * implemented, exported on the client, and called by nothing: an author could not create
 * a first document at all. These pin the caller, not just the route.
 */
describe('R-8.5 — starting a new document', () => {
  const authoring = { ...AVAILABLE, canPublish: true };

  it('posts the document id, the store path and the title', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true, kind: 'create' } }, authoring);
    const onOpened = vi.fn();
    render(<CollabOpenPanel fetchImpl={impl} onOpened={onOpened} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('New document id', 'doc-7');
    type('Title', 'Payment rules');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('doc-7'));
    expect(calls.at(-1)).toEqual({
      url: '/__vs/collab/start',
      // A `.md` path, not `.json`: the create job commits `doc.markdown` to
      // `documentPath` verbatim (R-0.1), so the extension has to match the bytes.
      body: { documentId: 'doc-7', documentPath: 'documents/doc-7.md', title: 'Payment rules' },
    });
  });

  it('omits the title entirely rather than sending an empty one', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true } }, authoring);
    render(<CollabOpenPanel fetchImpl={impl} onOpened={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('New document id', 'doc-8');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(calls.at(-1)?.url).toBe('/__vs/collab/start'));
    expect(calls.at(-1)?.body).toEqual({ documentId: 'doc-8', documentPath: 'documents/doc-8.md' });
  });

  it('refuses to post without a document id', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true } }, authoring);
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(screen.getByText(/Enter a document id/)).toBeTruthy());
    expect(calls.map((c) => c.url)).toEqual(['/__vs/collab']);
  });

  it('shows the server’s refusal verbatim', async () => {
    const message = 'create is available to the document author only: the GitHub credential has no write access to acme/docs.';
    const { impl } = fakeFetch({ ok: false, status: 403, json: { error: message } }, authoring);
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('New document id', 'doc-9');
    fireEvent.click(screen.getByRole('button', { name: 'Create pull request' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });

  /*
   * R-9.11 — hiding a control is never the enforcement, but offering a reviewer a button
   * that exists only to be refused is its own defect. `false` is a definite answer.
   */
  it('is hidden for a session the server said cannot publish', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } }, { ...AVAILABLE, canPublish: false });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull();
  });

  it('is shown when write access is undeterminable, because the route still refuses', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Create pull request' })).toBeTruthy();
  });
});

describe('R-11.2 — opening by pull request reference', () => {
  it('posts the parsed pull number and the document id', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true, kind: 'sync' } });
    const onOpened = vi.fn();
    render(<CollabOpenPanel fetchImpl={impl} onOpened={onOpened} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('Pull request', 'https://github.com/acme/docs/pull/42');
    type('Document id', 'doc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('doc-1'));
    expect(calls.at(-1)).toEqual({ url: '/__vs/collab/open', body: { documentId: 'doc-1', pullNumber: 42 } });
  });

  it('refuses to post a reference it could not parse', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('Pull request', 'acme/docs');
    type('Document id', 'doc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(screen.getByText(/Enter a pull request URL or number/)).toBeTruthy());
    expect(calls.map((c) => c.url)).toEqual(['/__vs/collab']);
  });
});

describe('R-11.4 — the server’s specific cause reaches the reviewer verbatim', () => {
  it('shows the open failure as reported, not as a generic error', async () => {
    const message = 'cannot open acme/docs#42: read access denied (HTTP 403) — this credential can reach GitHub but not acme/docs.';
    const { impl } = fakeFetch({ ok: false, status: 409, json: { error: message } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('Pull request', '#42');
    type('Document id', 'doc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });
});
