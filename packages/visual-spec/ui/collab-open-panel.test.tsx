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

/**
 * P6 — the manual URL + document-id form is a disclosure now, collapsed by default,
 * because the pull request list next door already holds both answers for every row it
 * shows. It is still the way in for a pull request in another repository, so every test
 * that uses it opens it first.
 */
const openByUrl = () => fireEvent.click(screen.getByRole('button', { name: /Open a document from a pull request URL/ }));

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
    openByUrl();
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
 * R-8.5 IS NO LONGER THIS PANEL'S. A "New document" form used to sit here and post
 * `POST /__vs/collab/start` with an empty body — a create action on the reviewer's
 * screen, which made an author's first act a publish of a document nobody had written.
 * The author's entry is `StartPullRequestButton` in the main header, which sends the
 * file they actually wrote at the path it already has; `ui/start-pull-request.test.tsx`
 * carries R-8.5's assertions. What stays here is the one below: this panel creates
 * nothing, so no request it makes may be a create.
 */
describe('the panel creates nothing', () => {
  it('offers no way to start a document, even to a credential that could publish', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } }, { ...AVAILABLE, canPublish: true });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    expect(screen.queryByText(/New document/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Create pull request/ })).toBeNull();
  });
});

describe('R-11.2 — opening by pull request reference', () => {
  it('posts the parsed pull number and the document id', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true, kind: 'sync' } });
    const onOpened = vi.fn();
    render(<CollabOpenPanel fetchImpl={impl} onOpened={onOpened} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    openByUrl();
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

    openByUrl();
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

    openByUrl();
    type('Pull request', '#42');
    type('Document id', 'doc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });
});

/*
 * P6 — the landing page asked you to type what it already knew.
 *
 * It led with a form wanting a pull request URL *and* a document id typed by hand, then
 * "Start a new document", and only third the list of pull requests — which already
 * contains those same pull requests as buttons, each carrying the `documentId` the server
 * resolved from the body (R-7.4). Nothing is removed here: the form is still the answer for
 * a pull request in another repository, which is what it is now labelled as.
 */
describe('the manual form is a disclosure, labelled for what it is for (P6)', () => {
  it('is collapsed until it is asked for, and says why it exists', async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, json: { ok: true } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    const toggle = screen.getByRole('button', { name: /Open a document from a pull request URL/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('another repository');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });

  it('still opens a document once expanded', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true, kind: 'sync' } });
    const onOpened = vi.fn();
    render(<CollabOpenPanel fetchImpl={impl} onOpened={onOpened} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    openByUrl();
    type('Pull request', '#7');
    type('Document id', 'doc-7');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('doc-7'));
    expect(calls.at(-1)).toEqual({ url: '/__vs/collab/open', body: { documentId: 'doc-7', pullNumber: 7 } });
  });
});
