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
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('doc-1'));
    expect(calls.at(-1)).toEqual({ url: '/__vs/collab/open', body: { documentId: 'doc-1', pullNumber: 42 } });
  });

  it('refuses to post a reference it could not parse', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true } });
    render(<CollabOpenPanel fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeTruthy());

    type('Pull request', 'acme/docs');
    type('Document id', 'doc-1');
    fireEvent.click(screen.getByRole('button'));

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
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });
});
