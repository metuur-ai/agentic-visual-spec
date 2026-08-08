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
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { CollabPullsPanel, shortSha } from './collab-pulls-panel';

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

const WORKTREE = { pullNumber: 42, path: '/repo/.visual-spec/worktrees/pr-42', headSha: 'abc1234def5678' };

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
    '/__vs/collab/pulls/42/mount': { ok: true, status: 200, json: { ok: true, worktree: WORKTREE } },
    ...overrides,
  };
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const reply = routes[url] ?? { ok: false, status: 404, json: { error: `no fake route: ${url}` } };
    return { ok: reply.ok, status: reply.status, json: async () => reply.json } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

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

    fireEvent.click(screen.getByRole('button', { name: 'Check out & review' }));

    await waitFor(() => expect(onReview).toHaveBeenCalledWith(PULL, WORKTREE));
    expect(calls.filter((c) => c.url === '/__vs/collab/pulls/42/mount')).toEqual([
      { url: '/__vs/collab/pulls/42/mount', method: 'POST' },
    ]);
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
    expect(screen.getByRole('button', { name: 'Open review' })).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: 'Check out & review' }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    // A failed mount opens no review: there is no checkout to read.
    expect(onReview).not.toHaveBeenCalled();
  });
});
