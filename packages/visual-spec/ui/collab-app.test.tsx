// @vitest-environment jsdom
/**
 * collab-app.test.tsx — naming the pull request under review (R-9.1 … R-9.4).
 *
 * `CollabApp`'s own header said `Collaboration review` and never said which pull request
 * was on screen. The number and the commit come from the state the surface already holds —
 * the `pull` and `worktree` it was handed when the checkout was mounted — so the header is
 * rendered here as a pure component and asserted against props alone: no `fetch`, no git.
 *
 * R-9.2 gets its own test because it is the requirement that is easy to satisfy by
 * accident and easy to break by accident. The mounted tree is checked out `--detach` at a
 * commit; it is on no branch, so naming one — the pull request's head branch included —
 * would be false about the thing being displayed.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CollabApp, CollabHeader } from './collab-app';

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

const WORKTREE = { pullNumber: 42, path: '/repo/.visual-spec/worktrees/pr-42', headSha: 'fedcba9876543' };

describe('CollabHeader', () => {
  it('names the pull request and the commit of the mounted tree, from props alone (R-9.1, R-9.4)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<CollabHeader onExit={() => {}} review={{ pull: PULL, worktree: WORKTREE }} />);

    const chip = screen.getByTestId('vs-review-pull');
    expect(chip.textContent).toContain('#42');
    // The commit of the *mounted tree*, not of the pull request record.
    expect(chip.textContent).toContain('fedcba9');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('presents the mounted tree as read-only (R-9.3)', () => {
    render(<CollabHeader onExit={() => {}} review={{ pull: PULL, worktree: WORKTREE }} />);

    expect(screen.getByTestId('vs-review-pull').textContent).toMatch(/read-only/i);
  });

  it('names no branch for a mounted tree (R-9.2)', () => {
    const { container } = render(<CollabHeader onExit={() => {}} review={{ pull: PULL, worktree: WORKTREE }} />);

    const text = container.textContent ?? '';
    expect(text).not.toContain('feat/payments');
    expect(text).not.toContain('main');
    expect(container.innerHTML).not.toContain('feat/payments');
  });

  it('claims no pull request when the surface is not reviewing one', () => {
    const { container } = render(<CollabHeader onExit={() => {}} review={null} />);

    expect(screen.queryByTestId('vs-review-pull')).toBeNull();
    expect(container.textContent).not.toContain('#42');
  });
});

/*
 * R-7.7 / R-7.8 — where the header's pull request list sends the user.
 *
 * Both destinations already existed and neither was reachable without knowing this
 * surface existed and finding the row again on it. What is asserted here is that the
 * intent lands: a document opens on the document, a pull request opens checked out.
 * The header's half — which row offers which action, and the route resume calls — is
 * in `ui/pull-count-chip.test.tsx`.
 */
describe('CollabApp opens where the caller asked (R-7.7 / R-7.8)', () => {
  const DOCUMENT = { documentId: 'doc-c', documentPath: 'docs/spec.md', title: 'The Spec', markdown: '# The Spec\n' };
  const WORKTREE_43 = { pullNumber: 43, path: '/repo/.visual-spec/worktrees/pr-43', headSha: 'deadbee1234' };

  function jsonRes(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  class FakeEventSource {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {}
    close() {}
  }

  beforeEach(() => {
    // `vsdoc` is written to the real URL and outlives a test; a leftover one would
    // make the next render open a document instead of the pull request it was asked for.
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/__vs/collab') return jsonRes({ available: true, login: 'ana', repo: { owner: 'acme', repo: 'docs' }, scopes: [] });
        if (url === '/__vs/collab/doc-c') {
          return jsonRes({ documentId: 'doc-c', state: 'draft', running: false, job: null, events: [], droppedEvents: 0, document: { ...DOCUMENT, github: null } });
        }
        if (url === '/__vs/collab/doc-c/document') return jsonRes(DOCUMENT);
        if (url === '/__vs/collab/doc-c/comments') return jsonRes([]);
        if (url === '/__vs/tree') return jsonRes([]);
        if (url === '/__vs/collab/pulls/mounted') return jsonRes({ worktrees: [] });
        if (url.startsWith('/__vs/collab/pulls/43/mount')) return jsonRes({ worktree: WORKTREE_43 });
        if (url.startsWith('/__vs/collab/pulls/43/files')) {
          return jsonRes({ pullNumber: 43, headSha: 'ccccccc3', baseBranch: 'main', headBranch: 'chore/lint', mergeBaseSha: 'ddddddd4', files: [] });
        }
        if (url.startsWith('/__vs/collab/pulls/43/drafts')) return jsonRes({ drafts: [] });
        if (url.startsWith('/__vs/collab/pulls')) {
          return jsonRes({ pulls: [{ number: 43, title: 'Bump the linter', state: 'open', draft: false, headBranch: 'chore/lint', baseBranch: 'main', headSha: 'ccccccc3', htmlUrl: 'https://github.com/acme/docs/pull/43', author: 'cy', updatedAt: '2026-08-03T00:00:00.000Z' }] });
        }
        return jsonRes({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens straight onto a resumed collaboration document', async () => {
    render(<CollabApp onExit={() => {}} initial={{ documentId: 'doc-c' }} />);

    // Twice over: the document's title bar and the rendered Markdown's own heading.
    await screen.findAllByText('The Spec');
    // Not the entry panels — the user does not have to find the row a second time.
    expect(screen.queryByText(/Review a pull request’s code/)).toBeNull();
    // And it is in the URL, so a reload comes back to the same document.
    expect(new URLSearchParams(window.location.search).get('vsdoc')).toBe('doc-c');
  });

  it('checks a named pull request out through the panel’s own mount path', async () => {
    render(<CollabApp onExit={() => {}} initial={{ reviewPull: 43 }} />);

    // Nothing was clicked: the mount the reviewer would have triggered was triggered.
    const chip = await screen.findByTestId('vs-review-pull');
    expect(chip.textContent).toContain('#43');
    expect(chip.textContent).toContain('deadbee');
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === '/__vs/collab/pulls/43/mount')).toHaveLength(1),
    );
  });
});
