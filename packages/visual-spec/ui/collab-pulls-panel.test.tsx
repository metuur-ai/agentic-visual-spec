// @vitest-environment jsdom
/**
 * collab-pulls-panel.test.tsx — discovering and checking out a pull request
 * (R-13.1, R-13.2, R-13.3, R-13.9).
 *
 * `fetch` is injected, so nothing here touches a server or a git repository; the
 * assertions are on the request the panel sends and on the sentence a reviewer reads
 * back. R-13.9's four causes get one test each, because the whole point of keeping them
 * apart in `worktree.ts` is that they reach a human as four different instructions.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollabPullsPanel, groupByOwner, shortSha } from './collab-pulls-panel';

const PULL = {
  number: 42,
  title: 'Rework the payment rules',
  state: 'open',
  draft: false,
  headBranch: 'feat/payments',
  baseBranch: 'main',
  headSha: 'abc1234def5678',
  htmlUrl: 'https://github.com/acme/docs/pull/42',
  author: 'reviewer-rita',
  updatedAt: '2026-02-01T10:00:00Z',
};

const WORKTREE = {
  pullNumber: 42,
  // R-W3.5 — a checkout is addressed by repository and number, so the path carries both.
  repo: { owner: 'acme', repo: 'docs' },
  path: '/repo/.visual-spec/worktrees/acme/docs/pr-42',
  headSha: 'abc1234def5678',
};

/** What the mount route answers where a checkout supplies the review (R-W1.5). */
const REPO = { owner: 'acme', repo: 'docs' };
const CHECKOUT_MOUNT = { ok: true, source: 'checkout', headSha: WORKTREE.headSha, repo: REPO, worktree: WORKTREE };
/** And where the repository host does: same shape, same success, no path on this disk. */
const HOST_MOUNT = { ok: true, source: 'host', headSha: WORKTREE.headSha, repo: REPO };

type Reply = { ok: boolean; status: number; json: unknown };

/**
 * A `fetch` that answers the three `/pulls` routes and records every call. Routes are
 * matched on the exact URL the client builds, so a change to the path shape fails here
 * rather than silently falling through to the default.
 */
function fakeFetch(overrides: Record<string, Reply> = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const routes: Record<string, Reply> = {
    '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [PULL] } },
    '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees: [] } },
    '/__vs/collab/pulls/42/mount': { ok: true, status: 200, json: CHECKOUT_MOUNT },
    ...overrides,
  };
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const reply = routes[url] ?? { ok: false, status: 404, json: { error: `no fake route: ${url}` } };
    return { ok: reply.ok, status: reply.status, json: async () => reply.json } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/* ================================================================== *
 * R-8.4 — which repository these rows are of
 * ================================================================== */
describe('R-8.4 — the panel names the repository it is listing', () => {
  /*
   * It said "Every open pull request in this repository" and named none, so "this" was
   * read as the directory on screen — the one pairing that can be false. The collaboration
   * repository is configured independently of the served directory's `origin`, and this is
   * the surface that checks a pull request out INTO that directory.
   *
   * `availability` already travels here for the Yours/From-others split, so naming the
   * repository costs no request; the snapshot's `repo` was simply dropped on arrival.
   */
  const available = (repo: { owner: string; repo: string }) => ({
    ok: true,
    status: 200,
    json: { available: true, login: 'ana', repo, scopes: [] },
  });

  it('names it, rather than calling it “this repository”', async () => {
    const { impl } = fakeFetch({ '/__vs/collab': available({ owner: 'metuur', repo: 'agentic-visual-spec' }) });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);

    await waitFor(() => expect(screen.getByTestId('collab-pulls-repo').textContent).toBe('metuur/agentic-visual-spec'));
    expect(document.body.textContent).not.toContain('pull request in this repository');
    // And it says the pairing a reader would otherwise assume is not guaranteed.
    expect(document.body.textContent).toContain('not necessarily the repository of the directory you are serving');
  });

  it('still says which kind of repository it means when the snapshot cannot be read', async () => {
    // No `/__vs/collab` route in the fake — the listing renders regardless, and a panel
    // that fell back to "this repository" would reintroduce exactly the wrong reading.
    const { impl } = fakeFetch();
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);

    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());
    expect(screen.getByTestId('collab-pulls-repo').textContent).toBe('the configured collaboration repository');
  });
});

describe('R-13.1 — the reviewer sees what there is to review', () => {
  it('lists each pull request with its number, title, branches, author and head', async () => {
    const { impl } = fakeFetch();
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);

    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());
    expect(screen.getByText('#42')).toBeTruthy();
    const meta = screen.getByText(/feat\/payments/);
    expect(meta.textContent).toContain('reviewer-rita');
    expect(meta.textContent).toContain('main');
    expect(meta.textContent).toContain(shortSha(PULL.headSha));
  });

  it('asks for open pull requests by default and re-asks when the state changes', async () => {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls?state=all': { ok: true, status: 200, json: { pulls: [] } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());
    expect(calls.map((c) => c.url)).toContain('/__vs/collab/pulls?state=open');

    fireEvent.change(screen.getByLabelText('Pull request state'), { target: { value: 'all' } });
    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/__vs/collab/pulls?state=all'));
  });

  it('says so rather than showing an empty frame when there is nothing open', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [] } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/No open pull requests/)).toBeTruthy());
  });

  it('shows the server’s own words when the listing fails (R-11.4)', async () => {
    const message = 'acme/docs was not found. Check the repository name in your visual-spec config.';
    const { impl } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: false, status: 404, json: { error: message } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });
});

describe('R-13.3 — checking a pull request out', () => {
  it('posts the mount and hands the caller the pull and the worktree git reported', async () => {
    const { impl, calls } = fakeFetch();
    const onReview = vi.fn();
    render(<CollabPullsPanel onReview={onReview} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Review the code' }));

    await waitFor(() =>
      expect(onReview).toHaveBeenCalledWith(PULL, { source: 'checkout', headSha: WORKTREE.headSha, repo: REPO, worktree: WORKTREE }),
    );
    expect(calls.filter((c) => c.url === '/__vs/collab/pulls/42/mount')).toEqual([
      { url: '/__vs/collab/pulls/42/mount', method: 'POST' },
    ]);
  });

  /*
   * R-W1.3 / R-W1.5 — a review the host supplies is a review.
   *
   * This is the case the whole change exists for: the reviewer serving a directory that is
   * not a git working tree. The response carries no `worktree` because there is no path on
   * this disk, and the panel used to read that absence as a failure and print a sentence
   * telling the reviewer to go and clone something. Nothing failed. The panel opens the
   * review, and passes on which source is supplying it so the surface can say so.
   */
  it('opens a host-supplied review, which has no worktree and is not a failure', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls/42/mount': { ok: true, status: 200, json: HOST_MOUNT },
    });
    const onReview = vi.fn();
    render(<CollabPullsPanel onReview={onReview} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Review the code' }));

    await waitFor(() => expect(onReview).toHaveBeenCalledWith(PULL, { source: 'host', headSha: WORKTREE.headSha, repo: REPO }));
    // Nothing is said about cloning, serving a git directory, or an `origin` remote — the
    // exact sentences the refusal used to print.
    expect(screen.queryByText(/origin/i)).toBeNull();
    expect(screen.queryByText(/needs a checkout/i)).toBeNull();
  });

  /*
   * R-13.8 — "already checked out" is answered by git's registry, not by anything this
   * component remembers, so it survives a reload and a server restart.
   */
  it('marks a pull request that is already checked out, and names the commit', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees: [WORKTREE] } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);

    await waitFor(() => expect(screen.getByText(/checked out · abc1234/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Review the code' })).toBeTruthy();
  });

  it('removes a checkout through DELETE and re-reads what is mounted', async () => {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees: [WORKTREE] } },
      '/__vs/collab/pulls/42/mount': { ok: true, status: 200, json: { ok: true, removed: true } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove checkout' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Remove checkout' }));

    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/__vs/collab/pulls/42/mount', method: 'DELETE' }),
    );
  });
});

/*
 * R-13.9 — four causes, four instructions. A shared "could not check out" would tell the
 * reviewer to do nothing in particular, which is why each of these is asserted verbatim.
 */
describe('R-13.9 — each way a checkout can fail says which one it was', () => {
  const cases: Array<{ name: string; reply: Reply; message: string }> = [
    {
      name: 'the served directory is not a git repository',
      reply: { ok: false, status: 409, json: { error: 'not a git repository: this directory has no git working tree, so a pull request cannot be checked out here.', reason: 'not-a-repo' } },
      message: 'not a git repository: this directory has no git working tree, so a pull request cannot be checked out here.',
    },
    {
      name: 'it has no origin remote',
      reply: { ok: false, status: 409, json: { error: 'no origin remote: add one with `git remote add origin <url>` so the pull request head can be fetched.', reason: 'no-origin' } },
      message: 'no origin remote: add one with `git remote add origin <url>` so the pull request head can be fetched.',
    },
    {
      name: 'the pull request reference could not be fetched',
      reply: { ok: false, status: 502, json: { error: 'could not fetch the pull request head from origin — check your network and your access to the repository.', reason: 'fetch-failed' } },
      message: 'could not fetch the pull request head from origin — check your network and your access to the repository.',
    },
    {
      name: 'git refused the checkout',
      reply: { ok: false, status: 500, json: { error: 'git refused to create the worktree.', reason: 'worktree-failed' } },
      message: 'git refused to create the worktree.',
    },
  ];

  it.each(cases)('reports verbatim when $name', async ({ reply, message }) => {
    const { impl } = fakeFetch({ '/__vs/collab/pulls/42/mount': reply });
    const onReview = vi.fn();
    render(<CollabPullsPanel onReview={onReview} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Review the code' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    // A failed mount opens no review: there is no checkout to read.
    expect(onReview).not.toHaveBeenCalled();
  });
});

/*
 * P6 — the list already holds both answers, so it offers both.
 *
 * The landing page used to lead with a form asking for a pull request URL and a document
 * id typed by hand, with this list third — although since the server started resolving
 * `documentId` from the pull request body (R-7.4) every row that has a document already
 * knows it. So the row offers the two things a reviewer can actually do with it, and a row
 * that can only offer one of them says why rather than looking broken beside its
 * neighbours.
 */
const WITH_DOC = { ...PULL, number: 44, title: 'The style guide', documentId: 'style-guide' };

describe('a pull request that carries a document offers to resume it (P6)', () => {
  it('offers Resume writing first, and Review the code beside it', async () => {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [WITH_DOC] } },
      '/__vs/collab/open': { ok: true, status: 200, json: { ok: true, kind: 'sync' } },
    });
    const onResume = vi.fn();
    render(<CollabPullsPanel onReview={vi.fn()} onResume={onResume} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/The style guide/)).toBeTruthy());

    expect(screen.getByRole('button', { name: 'Review the code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume writing' }));

    // R-7.7 — through the route that already attaches to a collaboration, with the id the
    // server resolved. Nothing here parses a pull request body, and nothing here could.
    await waitFor(() => expect(onResume).toHaveBeenCalledWith('style-guide'));
    expect(calls.map((c) => c.url)).toContain('/__vs/collab/open');
  });

  it('says why a row without a document offers less than its neighbours', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [PULL, WITH_DOC] } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} onResume={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/The style guide/)).toBeTruthy());

    const bare = document.querySelector('[data-vs-pull="42"]') as HTMLElement;
    expect(bare.textContent).toContain('no document');
    expect(bare.querySelector('[data-vs-pull-nodoc]')).toBeTruthy();
    // And it is not offered a resume it cannot honour.
    expect(bare.textContent).not.toContain('Resume writing');
  });

  it('shows the server’s words when the resume is refused', async () => {
    const message = 'cannot open acme/docs#44: read access denied (HTTP 403).';
    const { impl } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [WITH_DOC] } },
      '/__vs/collab/open': { ok: false, status: 403, json: { error: message } },
    });
    const onResume = vi.fn();
    render(<CollabPullsPanel onReview={vi.fn()} onResume={onResume} fetchImpl={impl} />);
    await waitFor(() => expect(screen.getByText(/The style guide/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Resume writing' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(onResume).not.toHaveBeenCalled();
  });
});

/*
 * On someone else's pull request you review; on your own you read what came back. The
 * listing made the reader draw that line by eye, matching a login against an author
 * column row by row — and the login is something the server already told us.
 */
describe('your own pull requests are their own section', () => {
  const MINE = { ...PULL, number: 7, title: 'My own work', author: 'reviewer-rita' };
  const THEIRS = { ...PULL, number: 8, title: 'Someone else’s', author: 'dev-dan' };

  /** `GET /__vs/collab` — the snapshot the whole collaboration UI already gates on. */
  const signedIn = (login: string) => ({
    '/__vs/collab': { ok: true, status: 200, json: { available: true, login, repo: { owner: 'acme', repo: 'docs' } } },
  });

  it('puts yours first, under their own headings', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [THEIRS, MINE] } },
      ...signedIn('reviewer-rita'),
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);

    await screen.findByText('Yours');
    const groups = [...document.querySelectorAll('[data-vs-pull-group]')].map((g) => g.getAttribute('data-vs-pull-group'));
    expect(groups).toEqual(['mine', 'others']);

    const mine = document.querySelector('[data-vs-pull-group="mine"]') as HTMLElement;
    expect(mine.textContent).toContain('My own work');
    expect(mine.textContent).not.toContain('Someone else’s');
    expect(screen.getByText('From others').textContent).toBe('From others');
  });

  /*
   * GitHub logins are case-insensitive, and a wrong split is worse than none: it would
   * file the reader's own work under someone else's heading.
   */
  it('matches the login regardless of case', () => {
    const groups = groupByOwner([MINE, THEIRS], 'Reviewer-Rita');
    expect(groups.map((g) => g.key)).toEqual(['mine', 'others']);
    expect(groups[0]!.rows).toEqual([MINE]);
  });

  /*
   * A heading over the only group is a label, not a division — so where every row falls
   * on one side, or the login never arrived, the list stays exactly as it was.
   */
  it('stays flat when there is nothing to divide', () => {
    expect(groupByOwner([MINE, THEIRS], null).map((g) => g.title)).toEqual([null]);
    expect(groupByOwner([MINE], 'reviewer-rita').map((g) => g.title)).toEqual([null]);
    expect(groupByOwner([THEIRS], 'reviewer-rita').map((g) => g.title)).toEqual([null]);
  });

  it('renders no heading when the availability snapshot cannot be read', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [THEIRS, MINE] } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);

    await screen.findByText(/My own work/);
    expect(screen.queryByText('Yours')).toBeNull();
    expect(document.querySelector('[data-vs-pull-group="all"]')).toBeTruthy();
  });
});

/*
 * Every button here runs git or GitHub, and none of them showed it: `Resume writing` and
 * `Remove checkout` only greyed out, and the row-wide busy flag put "Opening the review…" on
 * the *mount* button when `Resume` was the one pressed. Reported as "it looks like nothing
 * happened".
 */
describe('a control that is waiting on the network says so, and it is the right control', () => {
  /**
   * A `fetch` that never settles for one route and answers the rest normally, so the
   * in-flight state stays on screen to be asserted.
   */
  function hangingOn(route: string, overrides: Parameters<typeof fakeFetch>[0] = {}): typeof fetch {
    const rest = fakeFetch(overrides).impl as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    return (async (url: string, init?: RequestInit) =>
      url.startsWith(route) ? new Promise<Response>(() => {}) : rest(url, init)) as unknown as typeof fetch;
  }

  it('spins the button that was pressed, not the one beside it', async () => {
    const withDoc = { ...PULL, documentId: 'doc-1' };
    const impl = hangingOn('/__vs/collab/open', {
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [withDoc] } },
    });

    render(<CollabPullsPanel onReview={vi.fn()} onResume={vi.fn()} fetchImpl={impl} />);
    const resume = await screen.findByRole('button', { name: /Resume writing/ });

    fireEvent.click(resume);

    // The pressed control carries the ring and says what it is doing.
    await waitFor(() => expect(screen.getByRole('button', { name: /Opening…/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /Opening…/ }).querySelector('[data-vs-spinner]')).toBeTruthy();
    // ...and the neighbour is not claiming the wait it is not doing.
    expect(screen.queryByText('Opening the review…')).toBeNull();
    expect(screen.getByRole('button', { name: /Review the code/ })).toBeTruthy();
  });

  it('spins while a checkout is being mounted', async () => {
    const impl = hangingOn('/__vs/collab/pulls/42/mount');

    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /Review the code/ }));

    const btn = await screen.findByRole('button', { name: /Opening the review…/ });
    expect(btn.querySelector('[data-vs-spinner]')).toBeTruthy();
  });

  it('spins the list itself while the pull requests are still being read', async () => {
    const impl = hangingOn('/__vs/collab/pulls?');

    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    const line = await screen.findByText('Loading pull requests…');
    expect(line.querySelector('[data-vs-spinner]')).toBeTruthy();
  });
});

/*
 * A listing of titles answers "what is open" and not "what is this" — the second question
 * cost a trip to github.com. The body is a disclosure and not a column: it is unbounded
 * prose, and printing every one of them would bury the listing it belongs to.
 */
describe('a pull request can say what it is, without leaving the list', () => {
  const withBody = (body: string) => ({
    '/__vs/collab/pulls/42/description': { ok: true, status: 200, json: { pullNumber: 42, body } },
  });

  it('reads the description only once it is asked for, and renders it as Markdown', async () => {
    const { impl, calls } = fakeFetch(withBody('## Why\n\nBecause the rules changed.'));
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await screen.findByText(/Rework the payment rules/);

    // Nothing was fetched for a row nobody opened.
    expect(calls.map((c) => c.url)).not.toContain('/__vs/collab/pulls/42/description');

    fireEvent.click(screen.getByRole('button', { name: /View description/ }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Why' })).toBeTruthy());
    expect(screen.getByText('Because the rules changed.')).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain('/__vs/collab/pulls/42/description');
  });

  it('closes again on a second press', async () => {
    const { impl } = fakeFetch(withBody('Some prose.'));
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await screen.findByText(/Rework the payment rules/);

    fireEvent.click(screen.getByRole('button', { name: /View description/ }));
    await screen.findByText('Some prose.');

    fireEvent.click(screen.getByRole('button', { name: /Hide description/ }));
    await waitFor(() => expect(screen.queryByText('Some prose.')).toBeNull());
  });

  /* `''` is a real answer — the author wrote no description — not a failed read. */
  it('says so when there is no description, rather than showing an empty box', async () => {
    const { impl } = fakeFetch(withBody(''));
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await screen.findByText(/Rework the payment rules/);

    fireEvent.click(screen.getByRole('button', { name: /View description/ }));
    await screen.findByText('No description on this pull request.');
  });

  it('spins the control while the body is being read', async () => {
    const impl = ((url: string) =>
      url.endsWith('/description')
        ? new Promise<Response>(() => {})
        : (fakeFetch().impl as unknown as (u: string) => Promise<Response>)(url)) as unknown as typeof fetch;
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await screen.findByText(/Rework the payment rules/);

    const btn = screen.getByRole('button', { name: /View description/ });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.querySelector('[data-vs-spinner]')).toBeTruthy());
  });

  /* R-11.4 — the server's own sentence, in the panel's one error line. */
  it('shows the server’s words when the description cannot be read', async () => {
    const message = 'cannot read acme/docs#42: read access denied (HTTP 403).';
    const { impl } = fakeFetch({
      '/__vs/collab/pulls/42/description': { ok: false, status: 403, json: { error: message } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await screen.findByText(/Rework the payment rules/);

    fireEvent.click(screen.getByRole('button', { name: /View description/ }));
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });
});

/* ================================================================== *
 * R-7.8 — a deep link opens one pull request, and says which
 * ================================================================== */
/*
 * `?vspr=42` used to render the whole landing page — every open pull request and the
 * "open from a URL" form — with the checkout's only sign of life a spinner inside one
 * row, and then replace the lot with the review. The reader asked for #42.
 */
describe('opening a pull request from a deep link', () => {
  it('names the pull request it is opening instead of listing every other one', async () => {
    // The mount never settles, so the opening state stays on screen to assert.
    const { impl: base } = fakeFetch();
    const impl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/mount')) return new Promise<Response>(() => {});
      return (base as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    render(<CollabPullsPanel onReview={vi.fn()} autoReview={42} fetchImpl={impl} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: /Opening #42/ })).toBeTruthy());
    expect(screen.getByText(/Checking it out beside your files/)).toBeTruthy();
    // The listing is not the answer to this URL, so it is not on screen.
    expect(screen.queryByText(/Rework the payment rules/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Open collaborations' })).toBeNull();
  });

  it('falls back to the list, with the error, when the checkout fails', async () => {
    const { impl } = fakeFetch({
      '/__vs/collab/pulls/42/mount': { ok: false, status: 502, json: { error: 'could not fetch the head', reason: 'fetch-failed' } },
    });
    const onAutoReviewFailed = vi.fn();
    render(<CollabPullsPanel onReview={vi.fn()} autoReview={42} onAutoReviewFailed={onAutoReviewFailed} fetchImpl={impl} />);

    await waitFor(() => expect(screen.getByText('could not fetch the head')).toBeTruthy());
    // The list comes back, because a retry belongs next to the row it failed on.
    expect(screen.getByText(/Rework the payment rules/)).toBeTruthy();
    expect(onAutoReviewFailed).toHaveBeenCalled();
  });

  it('falls back to the list when the pull request is not in it at all', async () => {
    const { impl } = fakeFetch();
    const onAutoReviewFailed = vi.fn();
    render(<CollabPullsPanel onReview={vi.fn()} autoReview={999} onAutoReviewFailed={onAutoReviewFailed} fetchImpl={impl} />);

    await waitFor(() => expect(onAutoReviewFailed).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'Open collaborations' })).toBeTruthy();
  });

  it('leaves the listing alone when no deep link asked for anything', async () => {
    const { impl } = fakeFetch();
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    expect(screen.queryByRole('heading', { name: /Opening #/ })).toBeNull();
    await waitFor(() => expect(screen.getByText(/Rework the payment rules/)).toBeTruthy());
  });
});

/*
 * The two sections of R-A3.1 … R-A3.9.
 *
 * TWO FETCHES, ON PURPOSE. The panel's own reads go through the injected `fetchImpl`; the
 * `awaiting` store reads the *global* `fetch`, because it is a module store shared with the
 * header and has no props to be injected through. Stubbing both is what the running app
 * does too, and it keeps the store's own de-duplication in the picture rather than mocking
 * the hook and asserting against a fiction.
 */
describe('what is waiting on you, as two sections of this list', () => {
  const WITH_DOC = { ...PULL, documentId: 'doc-1' };
  /** In the listing (#42) and not in it (#99) — R-7.9 bounds the list, not the count. */
  const MENTION = { author: 'dev-dan', excerpt: 'can @reviewer-rita take the rounding rule?' };

  const awaitingBody = (over: Record<string, unknown> = {}) => ({
    reviewRequested: {
      ok: true,
      complete: true,
      total: 2,
      items: [
        { number: 42, title: PULL.title, htmlUrl: PULL.htmlUrl },
        { number: 99, title: 'Retire the legacy importer', htmlUrl: 'https://github.com/acme/docs/pull/99' },
      ],
    },
    mentioned: {
      ok: true,
      complete: true,
      total: 1,
      items: [{ number: 42, title: PULL.title, htmlUrl: PULL.htmlUrl, mention: MENTION }],
    },
    ...over,
  });

  /** The store's server: availability, then the two counts. Nothing else is reachable. */
  function stubStore(body: unknown = awaitingBody()) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json =
          url === '/__vs/collab'
            ? { available: true, login: 'reviewer-rita', repo: { owner: 'acme', repo: 'docs' }, scopes: [] }
            : url === '/__vs/collab/pulls/awaiting'
              ? body
              : (() => {
                  throw new Error(`unexpected global fetch: ${url}`);
                })();
        return { ok: true, status: 200, json: async () => json } as Response;
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const section = (key: string) => document.querySelector(`[data-vs-awaiting="${key}"]`) as HTMLElement;

  async function mountPanel(over: Parameters<typeof fakeFetch>[0] = {}) {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [WITH_DOC] } },
      ...over,
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(section('review')).toBeTruthy());
    return { calls };
  }

  it('renders both sections above the listing, and leaves the listing whole (R-A3.1/2/6)', async () => {
    stubStore();
    await mountPanel();

    expect(screen.getByText('Waiting on your review')).toBeTruthy();
    expect(screen.getByText('You were mentioned')).toBeTruthy();

    // "Inside the existing list, above it" is a claim about document order, so it is read
    // off the document rather than inferred from the JSX.
    const blocks = [...document.querySelectorAll('[data-vs-awaiting], [data-vs-pull-group]')].map(
      (n) => n.getAttribute('data-vs-awaiting') ?? `group:${n.getAttribute('data-vs-pull-group')}`,
    );
    expect(blocks).toEqual(['review', 'mentions', 'group:all']);

    // R-A3.6 — the listing is not filtered down to what the sections show.
    const group = document.querySelector('[data-vs-pull-group="all"]') as HTMLElement;
    expect(group.querySelectorAll('[data-vs-pull]')).toHaveLength(1);
    expect(group.textContent).toContain(PULL.title);
  });

  it('gives a listed pull request the same actions it has in the listing (R-A3.3)', async () => {
    stubStore();
    await mountPanel();

    const names = (root: HTMLElement) =>
      [...root.querySelectorAll('[data-vs-pull="42"] button')].map((b) => b.textContent);
    const group = document.querySelector('[data-vs-pull-group="all"]') as HTMLElement;

    expect(names(section('review'))).toEqual(['Resume writing', 'Review the code', 'View description']);
    expect(names(section('review'))).toEqual(names(group));
    // And the link out, which is the one control the unlisted row also gets.
    expect((section('review').querySelector('[data-vs-pull="42"] a') as HTMLAnchorElement).href).toBe(PULL.htmlUrl);
  });

  it('renders a pull request the listing does not have, without a checkout (R-A3.4/5)', async () => {
    stubStore();
    await mountPanel();

    const row = section('review').querySelector('[data-vs-awaiting-unlisted="99"]') as HTMLElement;
    expect(row.textContent).toContain('#99');
    expect(row.textContent).toContain('Retire the legacy importer');
    expect((row.querySelector('a') as HTMLAnchorElement).href).toBe('https://github.com/acme/docs/pull/99');
    // The whole point: no button that would need a branch and a head commit nobody fetched.
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(row.textContent).toContain('Not among the pull requests listed below');
  });

  it('shows who wrote the mention and what they said (R-A3.7)', async () => {
    stubStore();
    await mountPanel();

    const quote = section('mentions').querySelector('[data-vs-awaiting-mention="42"]') as HTMLElement;
    expect(quote.textContent).toContain('@dev-dan');
    expect(quote.textContent).toContain('can @reviewer-rita take the rounding rule?');
    // It belongs to the mention, not to every appearance of the pull request.
    expect(section('review').querySelector('[data-vs-awaiting-mention="42"]')).toBeNull();
  });

  it('says when it shows fewer rows than it counts (R-A3.8)', async () => {
    stubStore(
      awaitingBody({
        reviewRequested: {
          ok: true,
          complete: true,
          total: 40,
          items: [{ number: 42, title: PULL.title, htmlUrl: PULL.htmlUrl }],
        },
      }),
    );
    await mountPanel();

    expect(section('review').textContent).toContain('Showing 1 of 40');
    // The mentions side is whole, so it says nothing — a note on every section is noise.
    expect(section('mentions').querySelector('[data-vs-awaiting-shortfall]')).toBeNull();
  });

  it('stays open-only, and says so, when the listing is switched (R-A3.9)', async () => {
    stubStore();
    await mountPanel({ '/__vs/collab/pulls?state=closed': { ok: true, status: 200, json: { pulls: [] } } });
    expect(section('review').querySelector('[data-vs-awaiting-open-only]')).toBeNull();

    fireEvent.change(screen.getByLabelText('Pull request state'), { target: { value: 'closed' } });

    await waitFor(() =>
      expect(section('review').querySelector('[data-vs-awaiting-open-only="review"]')).toBeTruthy(),
    );
    expect(section('review').textContent).toContain('applies to the listing, not to this section');
    expect(section('mentions').querySelector('[data-vs-awaiting-open-only="mentions"]')).toBeTruthy();
    // The pull requests counted are unchanged: the toggle re-queried the listing, not these.
    expect(section('review').textContent).toContain('#42');
    expect(section('review').textContent).toContain('#99');
  });

  it('renders no section for a side that has not answered (R-A1.5)', async () => {
    stubStore(awaitingBody({ mentioned: { ok: false } }));
    await mountPanel();

    expect(section('mentions')).toBeNull();
    expect(screen.queryByText('You were mentioned')).toBeNull();
  });

  /*
   * FOUND IN THE BROWSER, NOT HERE. The section wrappers are `display: contents`, so the
   * rows of the listing sat flush under "You were mentioned" with nothing between them —
   * a one-row section reading as a three-row one. Document order was already correct and
   * already asserted, which is exactly why the order assertions could not see it. These
   * assert the *grouping*: whose subtree a row is in, and what separates it from the block
   * above.
   */
  it('gives the listing its own heading once a section is stacked above it', async () => {
    stubStore();
    await mountPanel();

    const heading = screen.getByRole('heading', { name: 'All open pull requests' });
    const firstListed = document.querySelector('[data-vs-pull-group="all"] [data-vs-pull]') as HTMLElement;

    // The defect, stated directly: the listing's rows are not part of the mention section.
    expect(section('mentions').contains(firstListed)).toBe(false);
    // And something says where one ends and the other begins.
    expect(heading.compareDocumentPosition(firstListed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section('mentions').compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The author split owns its own headings; it must not gain a second one above them.
    expect(screen.queryByText('Yours')).toBeNull();
  });

  /*
   * The 99% case, and the one that must not move: nothing is waiting on you, so the panel
   * is the listing and a heading over the only block would be a label, not a division.
   */
  it('adds no heading to the listing when neither section renders', async () => {
    stubStore({ reviewRequested: { ok: false }, mentioned: { ok: false } });
    const { impl } = fakeFetch({ '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls: [WITH_DOC] } } });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await screen.findByText(new RegExp(PULL.title));

    expect(document.querySelector('[data-vs-awaiting]')).toBeNull();
    // "Open collaborations" is the panel's own `h2` and predates all of this.
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Open collaborations']);
  });

  it('does not fetch the counts itself — the store is the only caller', async () => {
    stubStore();
    const { calls } = await mountPanel();
    expect(calls.filter((c) => c.url.includes('awaiting'))).toEqual([]);
  });
});

/* ================================================================== *
 * R-C1 — the checkouts on disk, gathered into a section of their own
 * ================================================================== */
/*
 * `mounted` was never iterated. It was consulted only as `mountedFor(pull.number)` from
 * inside a listed row, which is why a checkout stopped being visible the moment its pull
 * request left the listing — and its `Remove checkout` button, which lives on that row,
 * stopped being reachable with it. A checkout is a whole working copy of the repository,
 * so they accumulate in silence. Iterating `mounted` is the whole of the fix.
 *
 * These assert on the rows the section renders, never on a style value: the states of
 * R-C2 have to be readable without colour, and a test that reads colour would not notice
 * if they were not.
 */
describe('what is checked out on disk (R-C1)', () => {
  /** A second pull request, listed, so two checkouts can be asserted against two rows. */
  const OTHER = { ...PULL, number: 7, title: 'Tidy the importer', headSha: 'feed123beef456' };
  const OTHER_WORKTREE = {
    pullNumber: 7,
    repo: REPO,
    path: '/repo/.visual-spec/worktrees/acme/docs/pr-7',
    headSha: OTHER.headSha,
  };

  const section = () => document.querySelector('[data-vs-checkouts]') as HTMLElement | null;
  const row = (n: number) => document.querySelector(`[data-vs-checkout="${n}"]`) as HTMLElement | null;

  /**
   * `worktrees` is what `GET /pulls/mounted` answers, and `pulls` what the listing does.
   * Both are given per test, because every case here is a different join between them.
   */
  function mountPanel(worktrees: unknown[], pulls: unknown[] = [PULL]) {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls } },
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    return { calls };
  }

  /*
   * R-C1.1 / R-C1.7 — every checkout git reports, in one place. The section is rendered
   * from the mounted route's answer and from nothing this component remembers, which is
   * what makes a checkout created by an earlier run of the server appear here, and one
   * deleted from a terminal disappear.
   */
  it('renders every checkout the repository reports, in a section of its own', async () => {
    mountPanel([WORKTREE, OTHER_WORKTREE], [PULL, OTHER]);

    await waitFor(() => expect(section()).toBeTruthy());
    expect(row(42)).toBeTruthy();
    expect(row(7)).toBeTruthy();
    // Both rows are inside the section, not scattered through the listing.
    expect(section()!.contains(row(42)!)).toBe(true);
    expect(section()!.contains(row(7)!)).toBe(true);
    expect(section()!.textContent).toContain('Rework the payment rules');
    expect(section()!.textContent).toContain('Tidy the importer');
  });

  /*
   * R-C1.5 — a heading over no rows is a claim that something is half-done. The 99% case
   * is nothing checked out, and it must render exactly as it always has.
   */
  it('renders no section at all when nothing is checked out', async () => {
    mountPanel([]);

    await screen.findByText(/Rework the payment rules/);
    expect(section()).toBeNull();
    expect(screen.queryByText('Checked out on disk')).toBeNull();
  });

  /*
   * R-C1.2 / R-C1.3 — the leak, closed.
   *
   * `Remove checkout` lived only on a listed row, so a merged pull request's working
   * copy — a full copy of the repository — became invisible and unreachable at the same
   * moment. The row says the pull request is not in the listing and stops there: the
   * panel cannot tell "merged" from "filtered by the Show setting", and a row that
   * guessed "merged" would be wrong every time the toggle was on `Closed only`.
   */
  it('includes a checkout whose pull request is not listed, and offers to remove it', async () => {
    mountPanel([OTHER_WORKTREE], [PULL]);

    await waitFor(() => expect(row(7)).toBeTruthy());
    expect(row(7)!.textContent).toContain('#7');
    expect(row(7)!.textContent).toContain('Not in the listing');
    // Not a guess at why. "Merged" is the tempting word and the one the panel cannot know.
    expect(row(7)!.textContent).not.toContain('merged');
    expect(within(row(7)!).getByRole('button', { name: 'Remove checkout' })).toBeTruthy();
  });

  it('removes an unlisted checkout through the same DELETE the listed row uses', async () => {
    const { calls } = mountPanel([OTHER_WORKTREE], [PULL]);
    await waitFor(() => expect(row(7)).toBeTruthy());

    fireEvent.click(within(row(7)!).getByRole('button', { name: 'Remove checkout' }));

    await waitFor(() => expect(calls).toContainEqual({ url: '/__vs/collab/pulls/7/mount', method: 'DELETE' }));
  });

  /*
   * R-C1.4 — a working copy may hold uncommitted work, so the section makes it visible
   * and reachable and nothing more. Deleting one stays a decision the user makes.
   */
  it('removes nothing that the user has not asked to remove', async () => {
    const { calls } = mountPanel([WORKTREE, OTHER_WORKTREE], [PULL]);

    await waitFor(() => expect(row(7)).toBeTruthy());
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  /*
   * R-C1.6 — the two answer different questions and neither replaces the other. The
   * section answers "what do I have half-done"; the badge answers "is this row one of
   * them" while you are reading the listing. Dropping the badge would make the second
   * question cost a scroll to a different part of the panel.
   */
  it('still marks a checked-out pull request on its own row in the listing', async () => {
    mountPanel([WORKTREE], [PULL]);

    await waitFor(() => expect(row(42)).toBeTruthy());
    const listedRow = document.querySelector('[data-vs-pull-group="all"] [data-vs-pull="42"]') as HTMLElement;
    expect(listedRow.textContent).toContain('checked out · abc1234');
    // Both, at once: the section did not take the marking away from the listing.
    expect(section()!.contains(listedRow)).toBe(false);
    expect(row(42)!.textContent).toContain('#42');
  });
});

/* ================================================================== *
 * R-C2 — whether a checkout is still worth reading
 * ================================================================== */
/*
 * The badge named a commit and stopped. A reviewer reading a working copy pinned to a
 * commit the branch has moved past is reading code that no longer exists, and nothing on
 * screen said so — everything looked normal, which is what made it undiagnosable.
 *
 * NOTHING HERE READS A STYLE. R-C2.4 is that each state is legible without colour, so
 * every assertion below is on text content: set every colour in the component to the same
 * value and these still pass, and still tell the three states apart.
 */
describe('whether a checkout is at the pull request’s head (R-C2)', () => {
  /** The pull request has moved on; the checkout has not. */
  const MOVED = { ...PULL, headSha: '9f9f9f9aaaa111' };
  const STALE_WORKTREE = { ...WORKTREE, headSha: 'old1234cafe99' };
  const UNLISTED_WORKTREE = {
    pullNumber: 7,
    repo: REPO,
    path: '/repo/.visual-spec/worktrees/acme/docs/pr-7',
    headSha: 'feed123beef456',
  };
  /** A third pull request, so all three states can be on screen at once for R-C2.4. */
  const MOVED_9 = { ...PULL, number: 9, title: 'Split the ledger', headSha: 'aaa111bbb222' };
  const BEHIND_WORKTREE_9 = {
    pullNumber: 9,
    repo: REPO,
    path: '/repo/.visual-spec/worktrees/acme/docs/pr-9',
    headSha: 'ccc333ddd444',
  };

  const row = (n: number) => document.querySelector(`[data-vs-checkout="${n}"]`) as HTMLElement | null;

  function mountPanel(worktrees: unknown[], pulls: unknown[] = [PULL]) {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls?state=open': { ok: true, status: 200, json: { pulls } },
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees } },
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    return { calls };
  }

  /**
   * The three reads the panel makes on mount and nothing else. R-C2.5 is asserted against
   * this set: the comparison is a `===` between two values already on screen, so a fourth
   * URL appearing here would mean the panel had gone and asked somebody for it.
   */
  const ON_MOUNT = ['/__vs/collab', '/__vs/collab/pulls/mounted', '/__vs/collab/pulls?state=open'];

  it('says a checkout at the pull request’s head is up to date (R-C2.1)', async () => {
    const { calls } = mountPanel([WORKTREE], [PULL]);

    await waitFor(() => expect(row(42)!.textContent).toContain('Up to date'));
    expect(row(42)!.textContent).not.toContain('Out of date');
    // R-C2.5 — both commits were already read, so the answer cost no request.
    expect([...new Set(calls.map((c) => c.url))].sort()).toEqual(ON_MOUNT);
  });

  it('says a checkout the branch has moved past is out of date (R-C2.1)', async () => {
    const { calls } = mountPanel([STALE_WORKTREE], [MOVED]);

    await waitFor(() => expect(row(42)!.textContent).toContain('Out of date'));
    // R-C2.5 again, and this is the case that would tempt a "what is the head now?" call.
    expect([...new Set(calls.map((c) => c.url))].sort()).toEqual(ON_MOUNT);
  });

  /*
   * R-C2.2 — "out of date" without the two commits is unverifiable: the reviewer cannot
   * check the claim and cannot see how far behind they are. Without the way out it is a
   * dead end. Re-checking out is already how a checkout moves to a head that has changed
   * (R-13.12), so the row names an action that works rather than asking for a new one.
   */
  it('names both commits and the way out when a checkout is behind (R-C2.2)', async () => {
    mountPanel([STALE_WORKTREE], [MOVED]);

    await waitFor(() => expect(row(42)!.textContent).toContain('Out of date'));
    // The commit being read, and the commit that should be.
    expect(row(42)!.textContent).toContain(shortSha(STALE_WORKTREE.headSha));
    expect(row(42)!.textContent).toContain(shortSha(MOVED.headSha));
    expect(row(42)!.textContent).toContain('Checking it out again');
  });

  /*
   * R-C2.3 — there is no `PullRequestSummary` to compare against, so there is nothing to
   * say. A row that quietly defaulted to "up to date" would be asserting the one thing it
   * cannot know, about exactly the checkouts most likely to be stale: the ones whose pull
   * request has left the listing.
   */
  it('asserts nothing about the currency of a checkout that is not listed (R-C2.3)', async () => {
    mountPanel([UNLISTED_WORKTREE], [PULL]);

    await waitFor(() => expect(row(7)).toBeTruthy());
    expect(row(7)!.querySelector('[data-vs-checkout-state="current"]')).toBeNull();
    expect(row(7)!.querySelector('[data-vs-checkout-state="behind"]')).toBeNull();
    // Read as a human would read it, not just as a selector: neither word is on the row.
    expect(row(7)!.textContent).not.toContain('Up to date');
    expect(row(7)!.textContent).not.toContain('Out of date');
    expect(row(7)!.textContent).toContain('Not in the listing');
  });

  /*
   * R-C2.4 — the accessibility requirement, tested the only way that proves it.
   *
   * Everything below is read off `textContent`. There is no reference to a colour, a
   * class or a style value anywhere in it, so the test would pass unchanged with every
   * colour in the component set to the same one — and it would still tell the three
   * states apart, which is the whole claim. Anything weaker (asserting the green, or that
   * three colours differ) proves the colours exist, not that the states are legible
   * without them.
   *
   * This codebase settled the question once already, when it chose a count over a
   * coloured dot for per-file comments: a mark says "something is here" only to a reader
   * who already knows what the colour means.
   */
  it('carries each state in a word and a mark, so colour alone never distinguishes them (R-C2.4)', async () => {
    // One of each state on screen at once, which is also the case a reader has to read.
    mountPanel([WORKTREE, BEHIND_WORKTREE_9, UNLISTED_WORKTREE], [PULL, MOVED_9]);

    await waitFor(() => expect(row(9)).toBeTruthy());
    const words = { current: 'Up to date', behind: 'Out of date', unlisted: 'Not in the listing' };
    const marks = { current: '✓', behind: '!', unlisted: '?' };
    const text = { current: row(42)!.textContent!, behind: row(9)!.textContent!, unlisted: row(7)!.textContent! };

    for (const state of ['current', 'behind', 'unlisted'] as const) {
      expect(text[state]).toContain(words[state]);
      expect(text[state]).toContain(marks[state]);
    }
    // And the words are what separate them: no state's word appears on another's row.
    expect(text.current).not.toContain(words.behind);
    expect(text.current).not.toContain(words.unlisted);
    expect(text.behind).not.toContain(words.current);
    expect(text.behind).not.toContain(words.unlisted);
    expect(text.unlisted).not.toContain(words.current);
    expect(text.unlisted).not.toContain(words.behind);
  });
});

/* ================================================================== *
 * R-C3 — asking for all of this to be read again
 * ================================================================== */
/*
 * NOTHING POLLS, BY DESIGN, WHICH IS WHY A CONTROL HAS TO EXIST. R-7.10 forbids a timer
 * because a poll against a repository spends somebody's API quota — so a reviewer who has
 * just merged in another window, checked something out from a terminal, or been added as a
 * reviewer has no way to ask this panel to look again.
 *
 * THE THREE SOURCES ARE ASSERTED SEPARATELY BECAUSE THEY REFRESH SEPARATELY TODAY. The
 * listing re-reads when the `Show` setting changes, the checkouts when one is mounted or
 * removed, the counts on a tab switch — and never together. A refresh that moved two of
 * the three would be pressed and disbelieved, so every test here names all three.
 *
 * TWO FETCHES AGAIN, for the reason given above the R-A3 block: the panel's own reads go
 * through the injected `fetchImpl`, and the counts through the *global* one, because their
 * store is shared with the header and has no props to be injected through.
 */
describe('asking the panel to read all of it again (R-C3)', () => {
  /** One side answering keeps the fixture small; the other has simply never answered. */
  const AWAITING = {
    reviewRequested: {
      ok: true,
      complete: true,
      total: 1,
      items: [{ number: 42, title: PULL.title, htmlUrl: PULL.htmlUrl }],
    },
    mentioned: { ok: false },
  };

  /**
   * The store's server, recording every URL and able to start failing on command.
   *
   * `failing` is a box rather than a boolean so a test can flip it *after* a good render —
   * which is the whole shape of R-C3.5: what is on screen was read successfully, and then
   * the next read is refused.
   */
  function stubStore() {
    const urls: string[] = [];
    const state = { failing: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/__vs/collab') {
          const json = { available: true, login: 'reviewer-rita', repo: REPO, scopes: [] };
          return { ok: true, status: 200, json: async () => json } as Response;
        }
        if (url === '/__vs/collab/pulls/awaiting') {
          if (state.failing) {
            return { ok: false, status: 403, json: async () => ({ error: 'API rate limit exceeded' }) } as Response;
          }
          return { ok: true, status: 200, json: async () => AWAITING } as Response;
        }
        throw new Error(`unexpected global fetch: ${url}`);
      }),
    );
    return { urls, state };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const refreshButton = () => document.querySelector('[data-vs-refresh]') as HTMLButtonElement;
  const counted = (urls: string[]) => urls.filter((u) => u === '/__vs/collab/pulls/awaiting').length;

  /** Panel with a listed pull request, a checkout of it, and one counted section. */
  async function mountPanel(over: Parameters<typeof fakeFetch>[0] = {}) {
    const store = stubStore();
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees: [WORKTREE] } },
      ...over,
    });
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    // Every source has landed before anything is pressed. Pressing while the store's first
    // read is still in flight would be joined rather than issued (R-C3.4), which is correct
    // and would make these tests measure the wrong thing.
    await waitFor(() => expect(document.querySelector('[data-vs-awaiting="review"]')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-vs-checkouts]')).toBeTruthy());
    return { calls, ...store };
  }

  /*
   * R-C3.1 — one press, all three sources.
   *
   * Asserted as requests issued after the press and not as rows on screen, because the
   * fixture answers the same thing twice: a refresh that re-rendered nothing looks
   * identical to one that never asked. The requests are the behaviour.
   */
  it('re-reads the listing, the checkouts and both counts on one press', async () => {
    const { calls, urls } = await mountPanel();
    const panelBefore = calls.length;
    const countsBefore = counted(urls);

    fireEvent.click(refreshButton());

    await waitFor(() => expect(counted(urls)).toBe(countsBefore + 1));
    const after = calls.slice(panelBefore).map((c) => c.url);
    expect(after).toContain('/__vs/collab/pulls?state=open');
    expect(after).toContain('/__vs/collab/pulls/mounted');
  });

  /*
   * R-C3.2 — one control for the panel.
   *
   * A control per section would be three answers to one question, and two of them would be
   * wrong the moment they were used: the checkouts join against the listing, so refreshing
   * them alone can only restate a join made from a stale half.
   */
  it('offers exactly one refresh control, and none inside a section', async () => {
    await mountPanel();

    expect(document.querySelectorAll('[data-vs-refresh]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Refresh/ })).toHaveLength(1);
    expect(document.querySelector('[data-vs-awaiting="review"] [data-vs-refresh]')).toBeNull();
    expect(document.querySelector('[data-vs-checkouts] [data-vs-refresh]')).toBeNull();
    expect(document.querySelector('[data-vs-pull-group="all"] [data-vs-refresh]')).toBeNull();
  });

  /*
   * The listing is re-read at the setting the reader is looking at, not at the default.
   * A refresh that quietly reverted `Show` to `open` would answer a question nobody asked.
   */
  it('re-reads the listing at the state the “Show” setting is on', async () => {
    const { calls } = await mountPanel({
      '/__vs/collab/pulls?state=closed': { ok: true, status: 200, json: { pulls: [] } },
    });
    fireEvent.change(screen.getByLabelText('Pull request state'), { target: { value: 'closed' } });
    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/__vs/collab/pulls?state=closed'));
    const before = calls.length;

    fireEvent.click(refreshButton());

    await waitFor(() => expect(calls.slice(before).map((c) => c.url)).toContain('/__vs/collab/pulls?state=closed'));
    expect(calls.slice(before).map((c) => c.url)).not.toContain('/__vs/collab/pulls?state=open');
  });

  /*
   * R-C3.3 — a control that is waiting on the network says so, and refuses to be pressed
   * again while it does.
   *
   * This is the panel's existing rule (see the `BusyLabel` block above) applied to the one
   * control that fans out to three routes, and here it is a quota question as well as a
   * legibility one. A button that greys out and does nothing visible gets pressed again:
   * five presses in ten seconds is fifteen calls against a *search* budget of thirty a
   * minute, and the counts are the side that would go dark for the rest of the page.
   *
   * The listing is the read held open, because it is the one that reaches GitHub.
   */
  function hangAfterFirstListing(worktrees: unknown[] = [WORKTREE]) {
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees } },
    });
    const base = impl as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    let listings = 0;
    const wrapped = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('/__vs/collab/pulls?')) {
        listings += 1;
        if (listings > 1) return new Promise<Response>(() => {});
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    return { impl: wrapped, calls };
  }

  it('says a refresh is running, on the control that was pressed (R-C3.3)', async () => {
    stubStore();
    const { impl } = hangAfterFirstListing();
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(document.querySelector('[data-vs-checkouts]')).toBeTruthy());

    fireEvent.click(refreshButton());

    // The word, so a reader knows *what* is happening...
    const running = await screen.findByRole('button', { name: /Refreshing…/ });
    // ...and the ring, which is the part that says something is still happening at all.
    expect(running.querySelector('[data-vs-spinner]')).toBeTruthy();
    // The rows underneath are untouched while it runs: this is a re-read, not a reload.
    // (The title is on screen twice — the checkout's row and the listing's — which is
    // itself the point: neither was blanked to a spinner.)
    expect(screen.getAllByText(/Rework the payment rules/).length).toBeGreaterThan(0);
  });

  it('issues nothing further when it is pressed again mid-refresh (R-C3.3)', async () => {
    const { urls } = stubStore();
    const { impl, calls } = hangAfterFirstListing();
    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
    await waitFor(() => expect(document.querySelector('[data-vs-checkouts]')).toBeTruthy());

    fireEvent.click(refreshButton());
    await screen.findByRole('button', { name: /Refreshing…/ });
    const panelCalls = calls.length;
    const countReads = counted(urls);

    // Four more presses, the way an unconvinced reader presses.
    for (let i = 0; i < 4; i += 1) fireEvent.click(refreshButton());
    await Promise.resolve();

    expect(calls.length).toBe(panelCalls);
    expect(counted(urls)).toBe(countReads);
  });

  /*
   * And it comes back. A running state that never cleared would be the same defect wearing
   * the fix's clothes: the panel would still have no way to be asked a second time.
   */
  it('accepts a second refresh once the first has finished (R-C3.3)', async () => {
    const { calls, urls } = await mountPanel();

    fireEvent.click(refreshButton());
    await waitFor(() => expect(refreshButton().textContent).toContain('Refresh'));
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    const before = calls.length;
    const countReads = counted(urls);

    fireEvent.click(refreshButton());

    await waitFor(() => expect(counted(urls)).toBe(countReads + 1));
    expect(calls.slice(before).map((c) => c.url)).toContain('/__vs/collab/pulls?state=open');
  });

  /*
   * R-C3.5 — a refused refresh costs the refresh, not the panel.
   *
   * The same rule the counts already follow (R-A4.3) and the listing already follows
   * (R-7.11): what is on screen was read successfully once, and a later read that failed
   * is not new information about it. A rate-limited search is an ordinary Tuesday against
   * a budget of thirty a minute, and a panel that answered it by clearing three sections
   * and printing a banner would punish the reader for asking.
   *
   * Every source fails at once, which is the worst case and also the realistic one: all
   * three are the same credential against the same host.
   */
  it('keeps every row and count on screen when the refresh fails (R-C3.5)', async () => {
    const store = stubStore();
    const failing = { now: false };
    const { impl, calls } = fakeFetch({
      '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees: [WORKTREE] } },
    });
    const base = impl as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    const wrapped = (async (url: string, init?: RequestInit) => {
      if (failing.now) {
        calls.push({ url, method: init?.method ?? 'GET' });
        return { ok: false, status: 403, json: async () => ({ error: 'API rate limit exceeded' }) } as Response;
      }
      return base(url, init);
    }) as unknown as typeof fetch;

    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={wrapped} />);
    await waitFor(() => expect(document.querySelector('[data-vs-awaiting="review"]')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-vs-checkouts]')).toBeTruthy());

    // What a reader can see, recorded before anything is asked to fail.
    const listedBefore = document.querySelector('[data-vs-pull-group="all"]')!.textContent;
    const checkoutsBefore = document.querySelector('[data-vs-checkouts]')!.textContent;
    const countedBefore = document.querySelector('[data-vs-awaiting="review"]')!.textContent;
    const panelCalls = calls.length;

    failing.now = true;
    store.state.failing = true;
    fireEvent.click(refreshButton());
    await waitFor(() => expect(refreshButton().disabled).toBe(false));

    // The reads really were attempted — otherwise this asserts nothing at all.
    expect(calls.length).toBeGreaterThan(panelCalls);
    // …and every one of the three sources is exactly as it was.
    expect(document.querySelector('[data-vs-pull-group="all"]')!.textContent).toBe(listedBefore);
    expect(document.querySelector('[data-vs-checkouts]')!.textContent).toBe(checkoutsBefore);
    expect(document.querySelector('[data-vs-awaiting="review"]')!.textContent).toBe(countedBefore);
    // R-C3.5's second half: no error takes their place, and none appears beside them.
    expect(document.querySelector('[data-vs-collab-pulls-status]')).toBeNull();
    expect(screen.queryByText(/API rate limit exceeded/)).toBeNull();
  });

  /*
   * And the panel is still usable afterwards: a failed refresh must not leave the control
   * spinning forever, or the reader has lost the only way to ask.
   */
  it('offers the refresh again after one has failed (R-C3.5)', async () => {
    const store = stubStore();
    store.state.failing = true;
    // Nothing this panel asks for succeeds, from the first read onwards.
    const refused = (async () =>
      ({ ok: false, status: 403, json: async () => ({ error: 'API rate limit exceeded' }) }) as Response) as unknown as typeof fetch;

    render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={refused} />);
    await waitFor(() => expect(refreshButton()).toBeTruthy());

    fireEvent.click(refreshButton());

    await waitFor(() => expect(refreshButton().textContent).toContain('Refresh'));
    expect(refreshButton().disabled).toBe(false);
  });

  /*
   * R-C3.6 / R-7.10 — none of this runs on a timer, and this is the test that keeps it
   * that way.
   *
   * THE GUARD IS THE POINT, NOT THE ASSERTION. Adding a refresh control makes "…and just
   * run it every thirty seconds" the obvious next commit, and it is the wrong one: this
   * panel is mounted for as long as the drawer is open, the counts come from a *search*
   * budget of thirty requests a minute, and the quota being spent belongs to whoever's
   * token the server is holding — a cost paid by someone who is not in the room. A poll
   * would also be indistinguishable from working correctly, which is what makes it a
   * decision somebody should have to argue for rather than one that arrives by accident.
   *
   * Fake timers are installed *before* the render, not after, so a `setInterval` registered
   * on mount is one this test owns. Installed after, a real interval would keep its own
   * clock and `advanceTimersByTime` would sail straight past it.
   */
  it('re-reads nothing on a timer, however long the panel is left open (R-C3.6)', async () => {
    vi.useFakeTimers();
    try {
      const { urls } = stubStore();
      const { impl, calls } = fakeFetch({
        '/__vs/collab/pulls/mounted': { ok: true, status: 200, json: { worktrees: [WORKTREE] } },
      });
      /*
       * `waitFor` is unusable here and that is not this panel's fault: it polls on
       * `setInterval`, and it detects *jest's* fake clock only — under vitest's it would
       * wait on an interval this test has stopped. The mount reads settle on promises and
       * nothing else, so draining the microtask queue is the whole of the wait.
       */
      const settle = async () => {
        for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
      };
      render(<CollabPullsPanel onReview={vi.fn()} fetchImpl={impl} />);
      await settle();
      expect(document.querySelector('[data-vs-checkouts]')).toBeTruthy();
      expect(document.querySelector('[data-vs-awaiting="review"]')).toBeTruthy();

      const panelCalls = calls.length;
      const countReads = counted(urls);

      // Ten minutes of a reviewer reading the diff in another tab. Twenty polls at the
      // usual thirty seconds; sixty reads across the three sources.
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      // …and whatever a fired timer might have started is given every chance to land.
      await settle();

      expect(calls.length).toBe(panelCalls);
      expect(counted(urls)).toBe(countReads);
      // Not vacuous: the panel is still mounted, still rendered, and still has the one
      // control that *is* allowed to read again.
      expect(document.querySelector('[data-vs-checkouts]')).toBeTruthy();
      expect(refreshButton()).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
