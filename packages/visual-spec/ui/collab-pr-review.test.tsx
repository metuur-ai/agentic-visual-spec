// @vitest-environment jsdom
/**
 * collab-pr-review.test.tsx — reading a checked-out pull request (R-13.11, R-13.19).
 *
 * Two fakes, for two boundaries. `/__vs/collab/pulls/:n/files` is injected into the
 * component (`fetchImpl`); `/__vs/tree` and `/__vs/tree/file` are stubbed on the global,
 * because `useTree`/`useFile` are the shared browsing hooks and take no injection. Either
 * way nothing here reaches a server, a git repository or a disk.
 *
 * The read-only suite at the bottom is the one that matters most: R-13.19 is a promise
 * about what the interface does *not* offer, and the only way to keep such a promise
 * under refactoring is to assert the absence.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '../core/collaboration/review-drafts';
import { worktreeRelPath } from '../core/collaboration/worktree';
import { CollabPrReview, entriesUnder, worktreePrefix } from './collab-pr-review';
import { invalidateTree, type TreeEntry } from './use-tree';

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

const PREFIX = '.visual-spec/worktrees/pr-42/';

/** The whole served tree: the checkout, plus a file outside it that must not appear. */
const TREE: TreeEntry[] = [
  { path: '.visual-spec', name: '.visual-spec', type: 'dir' },
  { path: '.visual-spec/worktrees', name: 'worktrees', type: 'dir' },
  { path: '.visual-spec/worktrees/pr-42', name: 'pr-42', type: 'dir' },
  { path: `${PREFIX}src`, name: 'src', type: 'dir' },
  { path: `${PREFIX}src/pay.ts`, name: 'pay.ts', type: 'file', kind: 'code' },
  { path: `${PREFIX}src/util.ts`, name: 'util.ts', type: 'file', kind: 'code' },
  { path: `${PREFIX}spec.md`, name: 'spec.md', type: 'file', kind: 'markdown' },
  { path: 'notes.md', name: 'notes.md', type: 'file', kind: 'markdown' },
];

const CONTENT: Record<string, string> = {
  [`${PREFIX}src/pay.ts`]: 'export const pay = () => 1;\n',
  [`${PREFIX}src/util.ts`]: 'export const util = () => 2;\n',
  [`${PREFIX}spec.md`]: '# Refunds\n\nWithin five business days.\n',
};

/** Stub `/__vs/tree` and `/__vs/tree/file` on the global — the hooks take no injection. */
function stubTreeFetch() {
  const impl = vi.fn(async (url: string) => {
    if (url === '/__vs/tree') return { ok: true, status: 200, json: async () => TREE } as unknown as Response;
    const file = /^\/__vs\/tree\/file\?path=(.+)$/.exec(url);
    if (file) {
      const path = decodeURIComponent(file[1] as string);
      const content = CONTENT[path];
      if (content === undefined) return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ path, kind: 'code', content, size: content.length }),
      } as unknown as Response;
    }
    throw new Error(`unexpected global fetch: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

/** The one collaboration route this surface calls. */
function fakeCollabFetch(reply: { ok: boolean; status: number; json: unknown }) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok: reply.ok, status: reply.status, json: async () => reply.json } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const changedFiles = (files: string[]): { ok: boolean; status: number; json: unknown } => ({
  ok: true,
  status: 200,
  json: {
    pullNumber: 42,
    headSha: PULL.headSha,
    baseBranch: 'main',
    headBranch: 'feat/payments',
    mergeBaseSha: 'base9999',
    files,
  },
});

beforeEach(() => {
  // The tree walk is cached for seconds at module scope, so without this the second
  // test in the file would render the first one's tree.
  invalidateTree();
  stubTreeFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = (reply = changedFiles(['src/pay.ts'])) => {
  const { impl, calls } = fakeCollabFetch(reply);
  render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);
  return calls;
};

describe('the checkout path convention is the one core writes', () => {
  it('matches `worktreeRelPath`, which is what git was told to create', () => {
    expect(worktreePrefix(42)).toBe(`${worktreeRelPath(42)}/`);
    expect(WORKTREE.path.endsWith(worktreeRelPath(42))).toBe(true);
  });

  it('re-roots the checkout and leaves everything outside it alone', () => {
    expect(entriesUnder(TREE, PREFIX).map((e) => e.path)).toEqual(['src', 'src/pay.ts', 'src/util.ts', 'spec.md']);
  });
});

describe('R-13.11 — the changed files are the entry point', () => {
  it('lists what the pull request changed, and opens one on click', async () => {
    const calls = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'src/pay.ts' })).toBeTruthy());
    // Two routes, not one: the held review comments are read alongside the changed files
    // (R-13.13), so this asserts the entry point is called rather than that it is alone.
    expect(calls).toContain('/__vs/collab/pulls/42/files');
    expect(calls).toContain('/__vs/collab/pulls/42/drafts');

    fireEvent.click(screen.getByRole('button', { name: 'src/pay.ts' }));

    await waitFor(() => expect(screen.getByText(/export const pay/)).toBeTruthy());
  });

  it('says so when the pull request changed nothing', async () => {
    mount(changedFiles([]));
    await waitFor(() => expect(screen.getByText('This pull request changes no files.')).toBeTruthy());
  });

  it('shows the server’s words when the changed-file list could not be read', async () => {
    const message = 'cannot compare acme/docs: read access denied (HTTP 403).';
    mount({ ok: false, status: 403, json: { error: message } });
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
  });
});

describe('R-13.11 — any other file in the checkout can be opened', () => {
  it('browses the whole checkout, not only the changed subset', async () => {
    mount();
    // The filter force-opens the tree, which is how a reviewer reaches a file the pull
    // request did not touch without clicking through every folder.
    await waitFor(() => expect(screen.getByPlaceholderText('filter…')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('filter…'), { target: { value: 'util' } });

    const row = await screen.findByRole('button', { name: /util\.ts/ });
    fireEvent.click(row);

    await waitFor(() => expect(screen.getByText(/export const util/)).toBeTruthy());
  });

  it('shows nothing from outside the checkout', async () => {
    mount();
    await waitFor(() => expect(screen.getByPlaceholderText('filter…')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('filter…'), { target: { value: 'notes' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /notes\.md/ })).toBeNull());
  });
});

describe('R-13.19 — a checkout is a review surface, not a workspace', () => {
  it('states that it is read-only, and names the commit being read', async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Read-only checkout/)).toBeTruthy());
    expect(screen.getByText(/Read-only checkout/).textContent).toContain('no commit, push or merge');
    expect(screen.getByText(/at abc1234/)).toBeTruthy();
    expect(screen.getByText(/#42 Rework the payment rules/)).toBeTruthy();
  });

  it('offers no way to create a file', async () => {
    mount();
    await waitFor(() => expect(screen.getByPlaceholderText('filter…')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '+ New file' })).toBeNull();
    expect(screen.queryByLabelText('New file path')).toBeNull();
  });

  it('offers no way to rename a file, even on the row under the cursor', async () => {
    mount();
    await waitFor(() => expect(screen.getByPlaceholderText('filter…')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('filter…'), { target: { value: 'util' } });

    const row = await screen.findByRole('button', { name: /util\.ts/ });
    fireEvent.mouseEnter(row.parentElement as HTMLElement);

    await waitFor(() => expect(screen.getByRole('button', { name: /util\.ts/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull();
    expect(screen.queryByLabelText('Rename path')).toBeNull();
  });

  it('opens a file with no editing or saving control on it', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'src/pay.ts' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'src/pay.ts' }));
    await waitFor(() => expect(screen.getByText(/export const pay/)).toBeTruthy());

    for (const name of [/save/i, /edit/i, /publish/i, /commit/i, /push/i, /merge/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // Nothing to type into either: a viewer has no buffer.
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });
});

/* ================================================================== *
 * R-13.13 … R-13.18 — holding a review comment, and publishing it
 * ================================================================== */

type Reply = { status: number; json: unknown };
type ServerState = { drafts: ReviewDraft[] };

const draftRecord = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({
  id: 'd-aaaa1111',
  pullNumber: 42,
  headSha: PULL.headSha,
  target: { path: 'src/pay.ts', kind: 'range', startLine: 1, snippet: 'export const pay = () => 1;' },
  comment: 'This returns a number, not a payment.',
  status: 'draft',
  ts: '2026-02-01T11:00:00Z',
  ...over,
});

/**
 * A stand-in for the four `/pulls/:n/drafts` routes with state, because every one of
 * these flows is "act, then re-read" — the component never patches its own copy, and a
 * fixed reply would let a card show a state the server never reported.
 */
function fakeDraftServer(opts: {
  drafts?: ReviewDraft[];
  publish?: (id: string, body: Record<string, unknown>, state: ServerState) => Reply;
  del?: (id: string, state: ServerState) => Reply;
} = {}) {
  const state: ServerState = { drafts: opts.drafts ?? [] };
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const reply = (r: Reply) =>
    ({ ok: r.status < 400, status: r.status, json: async () => r.json }) as unknown as Response;

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });

    // `spec.md` is changed too, so the Markdown path is reachable from the entry point
    // a reviewer actually starts at rather than only by walking the tree.
    if (url.endsWith('/files')) return reply({ status: 200, json: changedFiles(['src/pay.ts', 'spec.md']).json });
    if (url === '/__vs/collab/pulls/42/drafts' && method === 'GET') {
      return reply({ status: 200, json: { drafts: state.drafts } });
    }
    if (url === '/__vs/collab/pulls/42/drafts' && method === 'POST') {
      const draft = draftRecord({
        headSha: body!.headSha as string,
        comment: body!.comment as string,
        target: {
          path: body!.path as string,
          kind: 'range',
          startLine: body!.startLine as number,
          ...(body!.endLine ? { endLine: body!.endLine as number } : {}),
          ...(body!.snippet ? { snippet: body!.snippet as string } : {}),
        },
      });
      state.drafts = [...state.drafts, draft];
      return reply({ status: 200, json: { ok: true, draft } });
    }
    const publish = /\/drafts\/([^/]+)\/publish$/.exec(url);
    if (publish && method === 'POST') return reply(opts.publish!(publish[1]!, body ?? {}, state));
    const item = /\/drafts\/([^/]+)$/.exec(url);
    if (item && method === 'DELETE') return reply(opts.del!(item[1]!, state));
    throw new Error(`unexpected collab fetch: ${method} ${url}`);
  });

  return { impl: impl as unknown as typeof fetch, calls, state };
}

/** Mark a draft published in the fake server's state, the way the route does. */
function publishInState(state: ServerState, id: string, htmlUrl?: string): ReviewDraft {
  const published = {
    ...state.drafts.find((d) => d.id === id)!,
    status: 'published' as const,
    published: { reviewCommentId: 700123, htmlUrl: htmlUrl ?? '', ts: '2026-02-01T12:00:00Z' },
  };
  state.drafts = state.drafts.map((d) => (d.id === id ? published : d));
  return published;
}

/** Open `src/pay.ts` and click line 1 — the selection a comment anchors to. */
async function openAndSelectLine1(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));
  await waitFor(() => expect(screen.getByText(/export const pay/)).toBeTruthy());
  fireEvent.click(document.querySelector('[data-line="1"]') as HTMLElement);
}

/*
 * The rendered Markdown surface has no lines, and a comment anchors to one — so on a
 * Markdown file the composer was unreachable. In a Markdown-centric product that meant
 * commenting did not work on precisely the files people review. Caught in the browser
 * against a real pull request, not by the suite.
 */
describe('R-13.13 — a Markdown file under review can be commented on', () => {
  it('renders by default, and switching to source exposes the same line composer', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    fireEvent.click(await screen.findByRole('button', { name: 'spec.md' }));
    // Rendered first: the heading is a heading, and there is no line to pick.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Refunds' })).toBeTruthy());
    expect(document.querySelector('[data-line="1"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Source · to comment' }));
    await waitFor(() => expect(document.querySelector('[data-line="1"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-line="3"]') as HTMLElement);

    fireEvent.change(await screen.findByLabelText('Review comment'), {
      target: { value: 'Working days or calendar days?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(screen.getByText('Working days or calendar days?')).toBeTruthy());
    const post = server.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ path: 'spec.md', startLine: 3 });
  });

  it('drops a pending selection when the view flips, so no composer outlives its line', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    fireEvent.click(await screen.findByRole('button', { name: 'spec.md' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Source · to comment' }));
    await waitFor(() => expect(document.querySelector('[data-line="1"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-line="1"]') as HTMLElement);
    expect(screen.getByLabelText('Review comment')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rendered' }));
    await waitFor(() => expect(screen.queryByLabelText('Review comment')).toBeNull());
  });
});

describe('R-13.13 — a comment is held locally, and never sent by typing it', () => {
  it('anchors it to the selected line, at the checked-out head, and lists it as a draft', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    await openAndSelectLine1();
    fireEvent.change(await screen.findByLabelText('Review comment'), {
      target: { value: 'This returns a number, not a payment.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(screen.getByText('This returns a number, not a payment.')).toBeTruthy());
    const post = server.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/__vs/collab/pulls/42/drafts');
    // The path the pull request names — re-rooted, not the served path the tree browses.
    expect(post.body).toEqual({
      path: 'src/pay.ts',
      comment: 'This returns a number, not a payment.',
      headSha: WORKTREE.headSha,
      startLine: 1,
      snippet: 'export const pay = () => 1;',
    });
    // Nothing was published by writing it.
    expect(server.calls.some((c) => c.url.endsWith('/publish'))).toBe(false);
    expect((document.querySelector('[data-vs-draft-origin]') as HTMLElement).textContent).toBe(
      'Local draft — not on GitHub',
    );
  });

  it('offers no composer until a line is picked — a viewer has no idle buffer', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));
    await waitFor(() => expect(screen.getByText(/export const pay/)).toBeTruthy());
    expect(screen.queryByLabelText('Review comment')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });
});

describe('R-13.15 / R-13.16 — publishing is a second, explicit act', () => {
  it('posts the held comment and re-labels the card as living on the pull request', async () => {
    const server = fakeDraftServer({
      drafts: [draftRecord()],
      publish: (id, _body, state) => ({
        status: 200,
        json: { ok: true, alreadyPublished: false, draft: publishInState(state, id, 'https://github.com/acme/docs/pull/42#discussion_r700123') },
      }),
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect((document.querySelector('[data-vs-draft-origin]') as HTMLElement).textContent).toBe('On GitHub · #42'),
    );
    expect(document.querySelector('[data-vs-draft-origin]')!.getAttribute('data-vs-draft-origin')).toBe('github');
    expect((screen.getByText('Open on GitHub') as HTMLAnchorElement).getAttribute('href')).toBe(
      'https://github.com/acme/docs/pull/42#discussion_r700123',
    );
    // Once it is on the pull request there is nothing left to publish or to discard here.
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(server.calls.filter((c) => c.url.endsWith('/publish'))).toHaveLength(1);
  });

  it('says so, without posting twice, when the comment was already published', async () => {
    const server = fakeDraftServer({
      drafts: [draftRecord()],
      publish: (id, _body, state) => ({
        status: 200,
        json: { ok: true, alreadyPublished: true, draft: publishInState(state, id, 'https://github.com/x#1') },
      }),
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(screen.getByText(/already on the pull request/i)).toBeTruthy());
    expect(document.querySelector('[data-vs-draft-notice="note"]')).toBeTruthy();
  });
});

describe('R-13.14 — a stale draft is refused with both shas, and forced only on purpose', () => {
  const staleServer = () =>
    fakeDraftServer({
      drafts: [draftRecord()],
      publish: (id, body, state) =>
        body.force === true
          ? { status: 200, json: { ok: true, alreadyPublished: false, draft: publishInState(state, id, 'https://github.com/x#9') } }
          : {
              status: 409,
              json: {
                error: 'This comment was written against abc1234def5678, and pull request #42 is now at 99ffee1122.',
                reason: 'stale-draft',
                draftHeadSha: 'abc1234def5678',
                currentHeadSha: '99ffee1122',
              },
            },
    });

  it('shows the sha it was written against and the one the pull request is at now', async () => {
    const server = staleServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(document.querySelector('[data-vs-draft-notice="stale"]')).toBeTruthy());
    const notice = document.querySelector('[data-vs-draft-notice="stale"]') as HTMLElement;
    expect(notice.textContent).toContain('abc1234def5678');
    expect(notice.textContent).toContain('99ffee1122');
    // Not forced behind the reviewer's back: one call, and it carried no `force`.
    const attempts = server.calls.filter((c) => c.url.endsWith('/publish'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body).toEqual({});
    // And it is still a local draft — the refusal did not pretend anything went out.
    expect((document.querySelector('[data-vs-draft-origin]') as HTMLElement).textContent).toBe(
      'Local draft — not on GitHub',
    );
  });

  it('retries with force only when the reviewer asks for it', async () => {
    const server = staleServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Publish anyway' }));

    await waitFor(() =>
      expect((document.querySelector('[data-vs-draft-origin]') as HTMLElement).textContent).toBe('On GitHub · #42'),
    );
    const attempts = server.calls.filter((c) => c.url.endsWith('/publish'));
    expect(attempts.map((c) => c.body)).toEqual([{}, { force: true }]);
  });
});

describe('R-13.17 — discarding a comment that already went out is not the reviewer’s error', () => {
  it('keeps the record, says why, and points at the comment on GitHub', async () => {
    const server = fakeDraftServer({
      drafts: [draftRecord()],
      // The route's own answer: the record is kept, because it is what stops a second post.
      del: (id, state) => {
        publishInState(state, id, 'https://github.com/acme/docs/pull/42#discussion_r700123');
        return {
          status: 409,
          json: { error: 'd-aaaa1111 has already been published to pull request #42.', reason: 'already-published' },
        };
      },
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(document.querySelector('[data-vs-draft-notice="note"]')).toBeTruthy());
    expect(document.querySelector('[data-vs-draft-notice="note"]')!.textContent).toMatch(/already on the pull request/i);
    // Not rendered as a failure: the card flips to its GitHub identity, with the way there.
    expect(document.querySelector('[data-vs-draft-notice="error"]')).toBeNull();
    expect((document.querySelector('[data-vs-draft-origin]') as HTMLElement).textContent).toBe('On GitHub · #42');
    expect((screen.getByText('Open on GitHub') as HTMLAnchorElement).getAttribute('href')).toBe(
      'https://github.com/acme/docs/pull/42#discussion_r700123',
    );
  });

  it('drops a held comment that was never published', async () => {
    const server = fakeDraftServer({
      drafts: [draftRecord()],
      del: (id, state) => {
        state.drafts = state.drafts.filter((d) => d.id !== id);
        return { status: 200, json: { ok: true, removed: true } };
      },
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(document.querySelector('[data-vs-draft]')).toBeNull());
  });
});

describe('R-13.18 — a held comment and a published one are told apart by a label', () => {
  it('labels each card by what it is, not by which control it happens to have', async () => {
    const server = fakeDraftServer({
      drafts: [
        draftRecord({ id: 'd-held0001', comment: 'still mine' }),
        // The trap: published, and with NO permalink to link to. It must still read as
        // living on the pull request — the absence of a link is not evidence of locality.
        draftRecord({
          id: 'd-sent0002',
          comment: 'already sent',
          status: 'published',
          published: { reviewCommentId: 700124, htmlUrl: '', ts: '2026-02-01T12:00:00Z' },
        }),
      ],
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src/pay.ts' }));

    await waitFor(() => expect(screen.getByText('already sent')).toBeTruthy());
    const chips = Array.from(document.querySelectorAll('[data-vs-draft-origin]')) as HTMLElement[];
    expect(chips.map((c) => c.getAttribute('data-vs-draft-origin'))).toEqual(['local', 'github']);
    expect(chips.map((c) => c.textContent)).toEqual(['Local draft — not on GitHub', 'On GitHub · #42']);
    // The published one has nothing to link to, and still says where it lives.
    expect(screen.queryByText('Open on GitHub')).toBeNull();
    // And the tally in the banner counts the two apart.
    expect(document.querySelector('[data-vs-draft-tally]')!.textContent).toBe('1 held locally · 1 on GitHub');
  });
});
