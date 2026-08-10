// @vitest-environment jsdom
/**
 * pull-count-chip.test.tsx — the open pull requests in the header chip
 * (R-7.1, R-7.3, R-7.6 … R-7.11) and the repository the count belongs to
 * (R-8.1 … R-8.3).
 *
 * The *unconfigured* half of R-7.2 is not here. It is in `ui/git-chip.test.tsx`,
 * whose whole suite already runs against a server with no collaboration block, so the
 * "no count, and no request for one" assertion sits beside the Unit 3 assertions it
 * has to leave untouched.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainHeader } from './main-header';

const SERVED_ORIGIN = {
  state: 'remote',
  branch: 'main',
  detached: false,
  owner: 'acme',
  repo: 'docs',
  host: 'github.com',
  url: 'git@github.com:acme/docs.git',
};

/** The configured collaboration repository — the same one the directory is served from. */
const CONFIGURED = { available: true, login: 'author-ana', repo: { owner: 'acme', repo: 'docs', baseBranch: 'main' }, scopes: [] };

/**
 * A mixed list. Two carry a collaboration document, one does not — and R-7.3 counts
 * all three, because the number has to agree with the one github.com shows.
 */
const PULLS = [
  { number: 41, title: 'Spec: retention', state: 'open', draft: false, headBranch: 'vs/doc-a', baseBranch: 'main', headSha: 'aaaaaaa1', htmlUrl: 'https://github.com/acme/docs/pull/41', author: 'ana', updatedAt: '2026-08-01T00:00:00.000Z', documentId: 'doc-a' },
  { number: 42, title: 'Bump the linter', state: 'open', draft: false, headBranch: 'chore/lint', baseBranch: 'main', headSha: 'bbbbbbb2', htmlUrl: 'https://github.com/acme/docs/pull/42', author: 'bo', updatedAt: '2026-08-02T00:00:00.000Z' },
  { number: 43, title: 'Spec: exports', state: 'open', draft: false, headBranch: 'vs/doc-c', baseBranch: 'main', headSha: 'ccccccc3', htmlUrl: 'https://github.com/acme/docs/pull/43', author: 'cy', updatedAt: '2026-08-03T00:00:00.000Z', documentId: 'doc-c' },
];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

type Server = {
  git?: unknown;
  availability?: unknown;
  pulls?: () => Response;
  /**
   * `GET /pulls/awaiting` — R-A4.7's subject. It is a sibling of the listing under the
   * same prefix, so it is matched *before* it and counted separately: a read of what is
   * waiting on me is not a read of the listing, and the R-7.10 assertions below count
   * listings.
   */
  awaiting?: () => Response;
  /** What `POST /__vs/dir/pick` answers, for the root change R-8.1 is reached through. */
  pick?: unknown;
};

function installFetch(server: Server = {}) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/git') return jsonRes(server.git ?? SERVED_ORIGIN);
    // R-6.3 — the branch routes are off here; this suite is about the count.
    if (url === '/__vs/git/branches') return jsonRes({ error: 'no route' }, 404);
    if (url === '/__vs/collab') return jsonRes(server.availability ?? CONFIGURED);
    if (url.startsWith('/__vs/collab/pulls/awaiting')) {
      return (server.awaiting ?? (() => jsonRes({ reviewRequested: { ok: false }, mentioned: { ok: false } })))();
    }
    if (url.startsWith('/__vs/collab/pulls')) return (server.pulls ?? (() => jsonRes({ pulls: PULLS })))();
    if (url === '/__vs/collab/open') return jsonRes({ ok: true, jobId: 'job-1', kind: 'open' });
    if (url === '/__vs/dir/pick') return jsonRes(server.pick ?? { root: '/repo2' });
    if (url.startsWith('/__vs/comments')) return jsonRes([]);
    if (url === '/__vs/source/root') return jsonRes({ root: '/repo/docs' });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountCount(server: Server = {}) {
  const impl = installFetch(server);
  render(<MainHeader file="docs/spec.md" />);
  const count = await screen.findByTestId('git-pull-count');
  return { impl, count };
}

const pullReads = (impl: ReturnType<typeof installFetch>) =>
  impl.mock.calls.filter(([u]) => String(u).startsWith('/__vs/collab/pulls') && !String(u).startsWith('/__vs/collab/pulls/awaiting'))
    .length;

describe('the count, where collaboration is configured (R-7.1 / R-7.3)', () => {
  it('appears in the chip, beside the repository the chip already names', async () => {
    const { count } = await mountCount();
    expect(count.textContent).toContain('3');
    expect(within(screen.getByTestId('git-chip')).getByTestId('git-pull-count')).toBeTruthy();
  });

  it('counts every open pull request, not only the collaborations', async () => {
    const { count } = await mountCount();
    // Two of the three carry a document; the third is somebody's ordinary branch and
    // is counted too, so the number matches the one on github.com.
    expect(count.textContent).toContain('3');
    expect(count.textContent).not.toContain('2');
  });
});

describe('when the count is read (R-7.10 / R-7.11)', () => {
  it('reads on mount, and again on focus and on visibilitychange', async () => {
    const { impl } = await mountCount();
    await waitFor(() => expect(pullReads(impl)).toBe(1));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(pullReads(impl)).toBe(2));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(pullReads(impl)).toBe(3));
  });

  /*
   * The negative assertion, and the load-bearing one. A stray interval looks identical
   * to a correct implementation in any test that counts reads after events — until the
   * tab sits idle against somebody's API quota.
   */
  it('reads on no timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { impl } = await mountCount();
    await waitFor(() => expect(pullReads(impl)).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(pullReads(impl)).toBe(1);
  });

  it('keeps the last known count when a refresh fails', async () => {
    let attempt = 0;
    const { impl, count } = await mountCount({
      pulls: () => {
        attempt += 1;
        return attempt === 1 ? jsonRes({ pulls: PULLS }) : jsonRes({ error: 'GitHub is unreachable' }, 502);
      },
    });
    expect(count.textContent).toContain('3');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(pullReads(impl)).toBe(2));

    // Not an error, not a blank: the last thing that was actually true.
    expect(screen.getByTestId('git-pull-count').textContent).toContain('3');
    expect(screen.getByTestId('git-chip').textContent).not.toMatch(/unreachable|error/i);
  });
});

/*
 * R-A4.7. `pull-requests-awaiting-you` is an amendment, and nothing an amendment adds is
 * allowed to take down what already worked. The chips that read `/pulls/awaiting` are not
 * in the header yet — this stands guard for the commit that adds them, and asserts the
 * property in the place it has to hold rather than after it has already been broken once.
 */
describe('a failed awaiting read takes nothing with it (R-A4.7)', () => {
  it('leaves the open count, its list and the header rendering', async () => {
    const { count } = await mountCount({ awaiting: () => jsonRes({ error: 'search is unavailable' }, 500) });

    expect(count.textContent).toContain('3');
    expect(screen.getByTestId('git-chip').textContent).toContain('acme/docs');
    expect(screen.getByTestId('git-chip').textContent).not.toMatch(/unavailable|error|failed/i);

    // And the list the count opens is untouched: a reviewer who cannot see their
    // mentions can still see everything they could see yesterday.
    fireEvent.click(count);
    const menu = await screen.findByTestId('git-pull-menu');
    expect(within(menu).getAllByTestId(/^git-pull-\d+$/)).toHaveLength(3);
  });
});

describe('the list behind the count (R-7.6 … R-7.8)', () => {
  it('marks the collaborations, and offers each row its one action', async () => {
    const { count } = await mountCount();
    fireEvent.click(count);
    const menu = await screen.findByTestId('git-pull-menu');

    // R-7.6 / R-7.7 — a pull request carrying a document is an active collaboration.
    for (const number of [41, 43]) {
      const row = within(menu).getByTestId(`git-pull-${number}`);
      expect(within(row).getByTestId(`git-pull-${number}-collab`)).toBeTruthy();
      expect(within(row).getByText('Resume')).toBeTruthy();
      expect(within(row).queryByText('Review')).toBeNull();
    }

    // R-7.8 — one that carries none is somebody's code, and the thing to do is read it.
    const plain = within(menu).getByTestId('git-pull-42');
    expect(within(plain).getByText('Review')).toBeTruthy();
    expect(within(plain).queryByText('Resume')).toBeNull();
    expect(within(plain).queryByTestId('git-pull-42-collab')).toBeNull();
  });

  it('resumes through the existing open route, with the identifier the server resolved', async () => {
    const resumed: string[] = [];
    const impl = installFetch();
    render(<MainHeader file="docs/spec.md" actions={{ onResumeCollab: (id) => resumed.push(id) }} />);

    fireEvent.click(await screen.findByTestId('git-pull-count'));
    fireEvent.click(within(await screen.findByTestId('git-pull-43')).getByText('Resume'));

    await waitFor(() => expect(resumed).toEqual(['doc-c']));
    const [, init] = impl.mock.calls.find(([u]) => String(u) === '/__vs/collab/open') as unknown as [string, RequestInit];
    // R-7.4 / R-7.5 — `doc-c` came off the summary the server built from the pull
    // request body. Nothing here re-derived it, and nothing here could: no body was
    // ever sent to this process to parse.
    expect(JSON.parse(String(init.body))).toEqual({ documentId: 'doc-c', pullNumber: 43 });
    expect(Object.keys(PULLS[2])).not.toContain('body');
  });

  it('sends a non-collaboration to the review surface by number', async () => {
    const reviewed: number[] = [];
    installFetch();
    render(<MainHeader file="docs/spec.md" actions={{ onReviewPull: (n) => reviewed.push(n) }} />);

    fireEvent.click(await screen.findByTestId('git-pull-count'));
    fireEvent.click(within(await screen.findByTestId('git-pull-42')).getByText('Review'));

    expect(reviewed).toEqual([42]);
  });
});

/*
 * R-7.9 — the list is bounded and the count is not, so on a busy repository the two
 * numbers disagree. That is the requirement, not a tolerance: a test whose fixture is
 * small enough for them to agree is testing nothing.
 */
describe('a repository with more pull requests than the list renders (R-7.9)', () => {
  const MANY = Array.from({ length: 12 }, (_, i) => ({ ...PULLS[1], number: 100 + i, title: `Change ${i}` }));

  it('reports the true total while the list says it has been truncated', async () => {
    const { count } = await mountCount({ pulls: () => jsonRes({ pulls: MANY }) });
    expect(count.textContent).toContain('12');

    fireEvent.click(count);
    const menu = await screen.findByTestId('git-pull-menu');
    const rows = within(menu).getAllByTestId(/^git-pull-\d+$/);
    expect(rows.length).toBeLessThan(MANY.length);

    const truncated = within(menu).getByTestId('git-pull-truncated');
    expect(truncated.textContent).toContain(String(rows.length));
    expect(truncated.textContent).toContain('12');
    // The count did not follow the list down to the bound.
    expect(screen.getByTestId('git-pull-count').textContent).toContain('12');
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    const { count } = await mountCount();
    fireEvent.click(count);
    const menu = await screen.findByTestId('git-pull-menu');
    expect(within(menu).queryByTestId('git-pull-truncated')).toBeNull();
  });
});

/*
 * R-8.1 … R-8.3. The chip's `owner/repo` is the served directory's `origin`; the count
 * is the configured collaboration repository. `POST /__vs/dir/pick` re-roots the first
 * at runtime while the second stays fixed — which is why the divergence is reached
 * here by making that request rather than by handing the component two repositories,
 * which would test a state the product cannot get into.
 */
describe('naming the repository the count belongs to (R-8.1 / R-8.2)', () => {
  const OTHER_ORIGIN = { ...SERVED_ORIGIN, owner: 'acme', repo: 'website', url: 'git@github.com:acme/website.git' };

  it('adds nothing where the served origin and the configured repository match', async () => {
    const { count } = await mountCount();
    expect(count.textContent).toContain('3');
    expect(screen.queryByTestId('git-pull-count-repo')).toBeNull();
    // Exactly what R-7.3 rendered — the chip names one repository, once.
    expect(screen.getByTestId('git-chip').textContent).toContain('acme/docs');
    expect((screen.getByTestId('git-chip').textContent ?? '').match(/acme\/docs/g)).toHaveLength(1);
  });

  it('names it once a root change has pointed the directory at another repository', async () => {
    const impl = installFetch();
    const { unmount } = render(<MainHeader file="docs/spec.md" />);
    await screen.findByTestId('git-pull-count');
    expect(screen.queryByTestId('git-pull-count-repo')).toBeNull();

    // The real path: the folder picker, which re-roots the server and reloads the page.
    // jsdom implements no navigation, so the reload is stood in for and asserted.
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    fireEvent.click(screen.getByTitle(/Open a different directory/));
    await waitFor(() => expect(impl.mock.calls.some(([u]) => String(u) === '/__vs/dir/pick')).toBe(true));
    await waitFor(() => expect(reload).toHaveBeenCalled());

    // The reload `ChangeDirButton` performs, as a remount against the re-rooted server.
    // The configuration did not move — that is the whole point of R-8.3.
    unmount();
    installFetch({ git: OTHER_ORIGIN });
    render(<MainHeader file="docs/spec.md" />);

    const named = await screen.findByTestId('git-pull-count-repo');
    expect(named.textContent).toContain('acme/docs');
    // Both repositories are still named, and neither was changed to agree with the
    // other (R-8.3): the chip says `acme/website`, the count says it is of `acme/docs`.
    expect(screen.getByTestId('git-chip').textContent).toContain('acme/website');
  });
});
