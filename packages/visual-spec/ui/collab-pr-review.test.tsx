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
import { render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '../core/collaboration/review-drafts';
import { worktreeRelPath } from '../core/collaboration/worktree';
import { CollabPrReview, changedTreeEntries, entriesUnder, worktreePrefix } from './collab-pr-review';
import { reviewCommentPanelSource } from './review-comment-source';
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
    await waitFor(() => expect(screen.getByRole('button', { name: /pay\.ts/ })).toBeTruthy());
    // Two routes, not one: the held review comments are read alongside the changed files
    // (R-13.13), so this asserts the entry point is called rather than that it is alone.
    expect(calls).toContain('/__vs/collab/pulls/42/files');
    expect(calls).toContain('/__vs/collab/pulls/42/drafts');

    fireEvent.click(screen.getByRole('button', { name: /pay\.ts/ }));

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

/**
 * The rest of the checkout is behind a disclosure now, so every test that reaches a file
 * the pull request did not touch has to open it first — which is the point: the changed
 * files are what a reviewer lands on.
 */
async function openTheRest(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Rest of the checkout/ }));
  await waitFor(() => expect(screen.getByPlaceholderText('filter…')).toBeTruthy());
}

describe('R-13.11 — any other file in the checkout can be opened', () => {
  it('browses the whole checkout, not only the changed subset', async () => {
    mount();
    // The filter force-opens the tree, which is how a reviewer reaches a file the pull
    // request did not touch without clicking through every folder.
    await openTheRest();
    fireEvent.change(screen.getByPlaceholderText('filter…'), { target: { value: 'util' } });

    const row = await screen.findByRole('button', { name: /util\.ts/ });
    fireEvent.click(row);

    await waitFor(() => expect(screen.getByText(/export const util/)).toBeTruthy());
  });

  it('shows nothing from outside the checkout', async () => {
    mount();
    await openTheRest();
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
    await openTheRest();
    expect(screen.queryByRole('button', { name: '+ New file' })).toBeNull();
    expect(screen.queryByLabelText('New file path')).toBeNull();
  });

  it('offers no way to rename a file, even on the row under the cursor', async () => {
    mount();
    await openTheRest();
    fireEvent.change(screen.getByPlaceholderText('filter…'), { target: { value: 'util' } });

    const row = await screen.findByRole('button', { name: /util\.ts/ });
    fireEvent.mouseEnter(row.parentElement as HTMLElement);

    await waitFor(() => expect(screen.getByRole('button', { name: /util\.ts/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull();
    expect(screen.queryByLabelText('Rename path')).toBeNull();
  });

  it('opens a file with no editing or saving control on it', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /pay\.ts/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /pay\.ts/ }));
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
  fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
  await waitFor(() => expect(screen.getByText(/export const pay/)).toBeTruthy());
  fireEvent.click(document.querySelector('[data-line="1"]') as HTMLElement);
}

/*
 * COMMENTING ON A DOCUMENT USED TO MEAN LEAVING IT.
 *
 * `Start commenting` swapped the rendered Markdown for raw source with line numbers and
 * put a textarea underneath. It worked, and it taught a second way to do a job this
 * product already has one way to do — click the block you mean, write beside it. The
 * premise ("a rendered surface has no lines") was false too: `MarkdownSurface` stamps
 * every block with `data-vs-loc`, which is the line range a draft anchors to.
 */
describe('R-13.13 — a Markdown file under review is commented on where it is read', () => {
  it('keeps the reader in the rendered document, with the shared comment panel beside it', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Refunds' })).toBeTruthy());

    // The panel is the local surface's own, so the way in is the button it already offers.
    await screen.findByRole('button', { name: 'Start commenting' });

    // And the detour is gone: no source toggle, and no line grid to be dropped into.
    expect(screen.queryByRole('button', { name: 'Source · to comment' })).toBeNull();
    expect(document.querySelector('[data-line="1"]')).toBeNull();
    expect(document.querySelector('[data-vs-comment-hint]')).toBeNull();
  });

  /*
   * The blocks are what a comment anchors to, so they have to be selectable — which means
   * the overlay that hit-tests a click and the `data-vs-loc` it reads must both be there.
   */
  it('stamps the rendered blocks with the positions a comment anchors to', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));
    const heading = await screen.findByRole('heading', { name: 'Refunds' });
    expect(heading.getAttribute('data-vs-loc')).toBeTruthy();
    expect(heading.closest('[data-inspector-root]')).toBeTruthy();
  });

  /*
   * Code has no rendered form to click on, so it keeps the line viewer and the composer
   * under it. Dropping that path with the Markdown one would have removed commenting from
   * every file in the checkout that is not a document.
   */
  it('leaves the line composer in place for files that have no rendered form', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    await openAndSelectLine1();
    expect(await screen.findByLabelText('Review comment')).toBeTruthy();
  });
});

/*
 * The drafts on a document live in the panel now, with the two acts attached to each row.
 * They used to sit in a second list below the document; printing them in both places
 * would make one set of comments look like two.
 */
describe('a document’s review comments are worked from the panel', () => {
  const held = draftRecord({ id: 'd-held0001', target: { path: 'spec.md', kind: 'range', startLine: 3 } });
  const alsoHeld = draftRecord({ id: 'd-held0002', comment: 'Second thought.', target: { path: 'spec.md', kind: 'range', startLine: 5 } });

  const openSpec = async (server: ReturnType<typeof fakeDraftServer>) => {
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Refunds' })).toBeTruthy());
  };

  it('lists a held draft with Send and Discard, and no second copy below the document', async () => {
    const server = fakeDraftServer({ drafts: [held] });
    await openSpec(server);

    await screen.findByText('This returns a number, not a payment.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
    // R-13.18 — the chip says where it lives, so nothing is read off a missing control.
    expect(screen.getByText('Draft — not sent')).toBeTruthy();
    expect(document.querySelector('[data-vs-draft-list]')).toBeNull();
  });

  it('sends one draft through the publish route', async () => {
    const server = fakeDraftServer({
      drafts: [held],
      publish: (id, _b, state) => ({ status: 200, json: { ok: true, draft: publishInState(state, id, 'https://github.com/acme/docs/pull/42#r1') } }),
    });
    await openSpec(server);
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText(/On GitHub · #42/)).toBeTruthy());
    expect(server.calls.some((c) => c.url === '/__vs/collab/pulls/42/drafts/d-held0001/publish')).toBe(true);
    // Sent is not held: the two acts are gone and the permalink has taken their place.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')).toBe('https://github.com/acme/docs/pull/42#r1');
  });

  /* Sequential, so each 409 — stale, already published — is an answer read one at a time. */
  it('offers one send for the whole group and posts each draft in turn', async () => {
    const server = fakeDraftServer({
      drafts: [held, alsoHeld],
      publish: (id, _b, state) => ({ status: 200, json: { ok: true, draft: publishInState(state, id) } }),
    });
    await openSpec(server);

    fireEvent.click(await screen.findByRole('button', { name: 'Send all 2' }));

    await waitFor(() => {
      const published = server.calls.filter((c) => c.url.endsWith('/publish'));
      expect(published.map((c) => c.url)).toEqual([
        '/__vs/collab/pulls/42/drafts/d-held0001/publish',
        '/__vs/collab/pulls/42/drafts/d-held0002/publish',
      ]);
    });
  });

  it('discards a held draft through the delete route', async () => {
    const server = fakeDraftServer({
      drafts: [held],
      del: (id, state) => {
        state.drafts = state.drafts.filter((d) => d.id !== id);
        return { status: 200, json: { ok: true, removed: true } };
      },
    });
    await openSpec(server);

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('This returns a number, not a payment.')).toBeNull());
    expect(server.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/drafts/d-held0001'))).toBe(true);
  });

  /*
   * R-13.14 — the stale-head warning has to reach the reviewer on whichever surface they
   * are sending from. A check that appears on one and not the other is a check that can
   * be walked past without ever being seen.
   */
  it('shows the stale-head warning, and its override, in the panel', async () => {
    const server = fakeDraftServer({
      drafts: [held],
      publish: (_id, body) =>
        body.force
          ? { status: 200, json: { ok: true, draft: held } }
          : {
              status: 409,
              json: { error: 'stale draft', reason: 'stale-draft', draftHeadSha: 'abc1234', currentHeadSha: 'def5678' },
            },
    });
    await openSpec(server);

    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.querySelector('[data-vs-draft-notice="stale"]')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    await waitFor(() => {
      const forced = server.calls.filter((c) => c.url.endsWith('/publish') && c.body?.force === true);
      expect(forced).toHaveLength(1);
    });
  });

  /* A comment on another file is not this file's comment, and must not be listed here. */
  it('shows only the drafts on the file that is open', async () => {
    const onOtherFile = draftRecord({ id: 'd-other001', comment: 'About the code.', target: { path: 'src/pay.ts', kind: 'range', startLine: 1 } });
    const server = fakeDraftServer({ drafts: [held, onOtherFile] });
    await openSpec(server);

    await screen.findByText('This returns a number, not a payment.');
    expect(screen.queryByText('About the code.')).toBeNull();
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
    expect(document.querySelector('[data-vs-draft-origin="local"]')!.textContent).toContain('not sent yet');
    expect(document.querySelector('[data-vs-draft]')!.getAttribute('data-vs-draft-status')).toBe('draft');
  });

  it('offers no composer until a line is picked — a viewer has no idle buffer', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(document.querySelector('[data-vs-draft-origin="github"]')!.textContent).toContain('1 on GitHub · #42'),
    );
    expect(document.querySelector('[data-vs-draft-origin]')!.getAttribute('data-vs-draft-origin')).toBe('github');
    expect((screen.getByText('Open on GitHub') as HTMLAnchorElement).getAttribute('href')).toBe(
      'https://github.com/acme/docs/pull/42#discussion_r700123',
    );
    // Once it is on the pull request there is nothing left to publish or to discard here.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
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
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

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
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

    await waitFor(() => expect(document.querySelector('[data-vs-draft-notice="stale"]')).toBeTruthy());
    const notice = document.querySelector('[data-vs-draft-notice="stale"]') as HTMLElement;
    expect(notice.textContent).toContain('abc1234def5678');
    expect(notice.textContent).toContain('99ffee1122');
    // Not forced behind the reviewer's back: one call, and it carried no `force`.
    const attempts = server.calls.filter((c) => c.url.endsWith('/publish'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body).toEqual({});
    // And it is still an unsent draft — the refusal did not pretend anything went out.
    expect(document.querySelector('[data-vs-draft-origin="local"]')!.textContent).toContain('not sent yet');
    expect(document.querySelector('[data-vs-draft-origin="github"]')).toBeNull();
  });

  it('retries with force only when the reviewer asks for it', async () => {
    const server = staleServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Send anyway' }));

    await waitFor(() =>
      expect(document.querySelector('[data-vs-draft-origin="github"]')!.textContent).toContain('1 on GitHub · #42'),
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
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(document.querySelector('[data-vs-draft-notice="note"]')).toBeTruthy());
    expect(document.querySelector('[data-vs-draft-notice="note"]')!.textContent).toMatch(/already on the pull request/i);
    // Not rendered as a failure: the card flips to its GitHub identity, with the way there.
    expect(document.querySelector('[data-vs-draft-notice="error"]')).toBeNull();
    expect(document.querySelector('[data-vs-draft-origin="github"]')!.textContent).toContain('1 on GitHub · #42');
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
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(document.querySelector('[data-vs-draft]')).toBeNull());
  });
});

describe('R-13.18 — a held comment and a published one are told apart by a label', () => {
  /*
   * The label used to be a chip repeated on every card, which said the same sentence four
   * times on a file with four held comments. R-13.18 asks that a reviewer never infer a
   * comment's origin from the absence of a control; it does not ask that the sentence be
   * repeated. So the provenance is stated once per group, above the cards it covers, with
   * the send action attached to it — and each card still declares its own status in the
   * DOM, so nothing here is carried by position alone.
   */
  it('states provenance once per group, with the send action on the group that needs it', async () => {
    const server = fakeDraftServer({
      drafts: [
        draftRecord({ id: 'd-held0001', comment: 'still mine' }),
        draftRecord({
          id: 'd-sent0002',
          comment: 'already sent',
          status: 'published',
          published: { reviewCommentId: 700124, htmlUrl: '', ts: '2026-02-01T12:00:00Z' },
        }),
      ],
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    await waitFor(() => expect(screen.getByText('already sent')).toBeTruthy());
    const groups = Array.from(document.querySelectorAll('[data-vs-draft-origin]')) as HTMLElement[];
    expect(groups.map((g) => g.getAttribute('data-vs-draft-origin'))).toEqual(['local', 'github']);
    expect(groups[0]!.textContent).toContain('1 draft — not sent yet');
    expect(groups[1]!.textContent).toContain('1 on GitHub · #42');
    // The card is not left saying nothing: its own status is on it, for anything that
    // reads a card rather than the group above it.
    const cards = Array.from(document.querySelectorAll('[data-vs-draft]')) as HTMLElement[];
    expect(cards.map((c) => c.getAttribute('data-vs-draft-status'))).toEqual(['draft', 'published']);
  });

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
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    await waitFor(() => expect(screen.getByText('already sent')).toBeTruthy());
    // The published one has nothing to link to, and still says where it lives — under a
    // group header that names GitHub, not by having lost a button.
    expect(screen.queryByText('Open on GitHub')).toBeNull();
    expect(document.querySelector('[data-vs-draft-origin="github"]')!.textContent).toContain('on GitHub');
    // And the tally in the banner counts the two apart.
    expect(document.querySelector('[data-vs-draft-tally]')!.textContent).toBe('1 held locally · 1 on GitHub');
  });
});

/*
 * ONE ROW, NOT TWO (R-9.1 … R-9.4).
 *
 * `CollabApp`'s header said `← Files | Collaboration review | #10 · at bd4a496 · read-only`
 * and this surface said the number, the sha and the read-only warning again directly under
 * it. The number appeared twice, the sha appeared twice and "read-only" appeared twice.
 * The surviving row is this one, so the R-9 obligations are asserted here: the number, the
 * short sha OF THE MOUNTED TREE — which is not the pull request record's, they diverge on a
 * push — and read-only, stated once.
 */
describe('the review row carries the whole identity, once', () => {
  it('names the number, the mounted tree’s commit and read-only, from props alone', async () => {
    const moved = { pullNumber: 42, path: WORKTREE.path, headSha: 'f00dbee9999' };
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(<CollabPrReview pull={PULL} worktree={moved} onExit={vi.fn()} fetchImpl={impl} />);

    const row = await screen.findByTestId('vs-review-pull');
    expect(row.textContent).toContain('#42');
    // The mounted tree's, not `PULL.headSha` — the checkout stayed where it was mounted.
    expect(row.textContent).toContain('f00dbee');
    expect(row.textContent).not.toContain('abc1234');
  });

  /*
   * A reviewer reading a checkout could tell which pull request it was and which commit,
   * but not whose work it was, and had no route to the conversation — both facts were on
   * the record this row already renders from. Everything this surface does is local and
   * read-only, so the pull request itself is where the rest of the review happens.
   */
  it('names the author and links out to the pull request', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);

    const row = await screen.findByTestId('vs-review-pull');
    expect(row.textContent).toContain('reviewer-rita');

    // A new tab: the checkout on screen is state a navigation would cost the reviewer.
    const link = screen.getByRole('link', { name: /On GitHub/ });
    expect(link.getAttribute('href')).toBe(PULL.htmlUrl);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  /*
   * The listing says `unknown author` where GitHub gave no login, and this row is the
   * same fact on a different surface — a blank where a name goes reads as a bug.
   */
  it('says so when there is no author, rather than showing a gap', async () => {
    const { impl } = fakeCollabFetch(changedFiles([]));
    render(<CollabPrReview pull={{ ...PULL, author: '' }} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);

    const row = await screen.findByTestId('vs-review-pull');
    expect(row.textContent).toContain('unknown author');
  });

  it('says read-only exactly once on the surface', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    const { container } = render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);

    await screen.findByTestId('vs-review-pull');
    expect((container.textContent ?? '').match(/read-only/gi) ?? []).toHaveLength(1);
  });

  it('keeps a way back', async () => {
    const onExit = vi.fn();
    const { impl } = fakeCollabFetch(changedFiles([]));
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={onExit} fetchImpl={impl} />);

    fireEvent.click(await screen.findByRole('button', { name: '← Pull requests' }));
    expect(onExit).toHaveBeenCalled();
  });
});

/*
 * P4 — the title used to slide under the buttons beside it, because a flex child defaults
 * to `min-width: auto` and refuses to shrink below its content. The number leads the
 * string, so an ellipsis on the tail cannot eat it.
 */
describe('the review title truncates instead of running under the controls', () => {
  it('shrinks the title and never the number', async () => {
    const { impl } = fakeCollabFetch(changedFiles([]));
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);

    const heading = await screen.findByText(/#42 Rework the payment rules/);
    // The permission to shrink sits on the identity block — a flex child defaults to
    // `min-width: auto` — and the ellipsis sits on the line that may lose characters.
    expect(screen.getByTestId('vs-review-pull').style.minWidth).toMatch(/^0(px)?$/);
    expect(heading.style.textOverflow).toBe('ellipsis');
    expect(heading.style.overflow).toBe('hidden');
    // The number is the first thing in the string, so the ellipsis takes the title.
    expect((heading.textContent ?? '').startsWith('#42')).toBe(true);
    // And the controls beside it hold their size rather than being squeezed.
    expect((screen.getByRole('button', { name: 'Refresh files' }) as HTMLElement).style.flexShrink).toBe('0');
  });
});

/*
 * P1 — the `I` shortcut and the `Source · to comment` pill both worked and neither was
 * findable. The way in is a button now; the shortcut is a hint under it.
 */
describe('starting a comment does not take the document off the screen', () => {
  it('arms the panel and leaves the reader looking at the rendered document', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Refunds' })).toBeTruthy());

    fireEvent.click(await screen.findByRole('button', { name: 'Start commenting' }));

    // Armed — the offer is spent — and the document is still the thing on screen. The old
    // behaviour replaced it with a line-numbered source view at exactly this point.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start commenting' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Refunds' })).toBeTruthy();
    expect(document.querySelector('[data-line="1"]')).toBeNull();
  });
});

/*
 * P7 — `CHANGED FILES (1)` and `ALL FILES IN THE CHECKOUT` sat at the same weight, so a
 * reviewer's eye landed on files the pull request never touched. The changed files lead
 * and stay open; the checkout collapses into one line that says what it is for.
 */
describe('the changed files lead and the rest of the checkout stands down', () => {
  it('collapses the checkout behind one summary line, expandable in one click', async () => {
    mount();

    const toggle = await screen.findByRole('button', { name: /Rest of the checkout/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('3 files');
    expect(toggle.textContent).toContain('read for context, not under review');
    // Nothing of the tree is on screen while it is closed.
    expect(screen.queryByPlaceholderText('filter…')).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByPlaceholderText('filter…')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Rest of the checkout/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the changed files expanded and named as the review', async () => {
    mount();
    // No disclosure over them, and no click needed to see them.
    expect(await screen.findByRole('button', { name: /pay\.ts/ })).toBeTruthy();
  });

  it('counts a file’s comments on its row rather than marking it with a colour', async () => {
    const server = fakeDraftServer({
      drafts: [draftRecord({ id: 'd-aaaa1111' }), draftRecord({ id: 'd-bbbb2222', comment: 'and this' })],
    });
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    const badge = await waitFor(() => {
      const el = document.querySelector('[data-vs-file-comments="src/pay.ts"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    // The number is the message. A bare dot would be colour carrying meaning — and the
    // label is what gives the number a noun for anything reading the row aloud.
    expect(badge.textContent).toContain('2');
    expect(badge.getAttribute('aria-label')).toMatch(/comment/i);
    // The file with no comments carries no badge at all.
    expect(document.querySelector('[data-vs-file-comments="spec.md"]')).toBeNull();
  });
});

/*
 * Two things the panel says that were wrong for a review comment when it first mounted
 * here — both found by writing one in the browser, not by the suite.
 */
describe('the panel says true things about a review comment', () => {
  it('offers no "Apply via" workflow, because nothing applies a review comment locally', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start commenting' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start commenting' })).toBeNull());
    expect(screen.queryByText('Apply via')).toBeNull();
  });

  /* The label fell back to "(top)" — a heading nobody selected — on every draft. */
  it('names the block that was selected, not the document', () => {
    const source = reviewCommentPanelSource({
      path: 'spec.md',
      headSha: 'abc1234',
      drafts: [
        draftRecord({
          id: 'd-lbl00001',
          target: { path: 'spec.md', kind: 'range', startLine: 6, heading: 'Unit 1: Result capture' },
        }),
      ],
      hold: vi.fn(async () => true),
      publish: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    });

    expect(source.label(source.comments[0]!)).toContain('Unit 1: Result capture');
    expect(source.label(source.comments[0]!)).toContain('L6');
  });

  /* A block selection is a line range; that is the whole reason the source view could go. */
  it('turns a block selection into the line range a draft anchors to', async () => {
    const hold = vi.fn(async () => true);
    const source = reviewCommentPanelSource({
      path: 'spec.md',
      headSha: 'abc1234',
      drafts: [],
      hold,
      publish: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    });

    const block = (line: number, text: string) => {
      const el = document.createElement('p');
      el.textContent = text;
      return { line, anchor: el } as unknown as Parameters<typeof source.create>[0][number];
    };
    await source.create([block(6, 'Unit 1'), block(9, 'Why:')], 'Does this cover the handoff case?', 'visual-spec');

    expect(hold).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'spec.md', headSha: 'abc1234', startLine: 6, endLine: 9, heading: 'Unit 1' }),
    );
  });
});

/*
 * A pull request touching 26 files across a monorepo printed 26 copies of
 * `packages/visual-spec/…`, each ellipsised in the middle — so the part that differed,
 * the filename, was the part that got cut. Nesting spends the width on the leaves.
 */
describe('the changed files are a tree, not a column of truncated paths', () => {
  it('nests the paths under the folders that hold them, already open', async () => {
    const server = fakeDraftServer();
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={server.impl} />);

    const tree = await waitFor(() => {
      const el = document.querySelector('[data-vs-changed-tree]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });

    // The folder is a row of its own, and the leaf underneath it is named by its leaf.
    expect(within(tree).getByRole('button', { name: /src/ })).toBeTruthy();
    const leaf = within(tree).getByRole('button', { name: /pay\.ts/ });
    expect(leaf.textContent).toContain('pay.ts');
    // The full path is gone from the row — that was the thing being truncated.
    expect(leaf.textContent).not.toContain('src/pay.ts');
    // Open without a click: the changed set is what the reviewer came to see.
    expect(leaf.offsetParent === null && leaf.hidden).toBe(false);
  });

  it('builds the folders the paths imply, parents before children', () => {
    const entries = changedTreeEntries(['packages/ui/a.ts', 'packages/core/b.ts', 'README.md'], new Map());
    // Locale order, so `packages` precedes `README.md`. What matters for `buildTree` is
    // only that a folder precedes everything inside it.
    expect(entries.map((e) => `${e.type === 'dir' ? 'd' : 'f'} ${e.path}`)).toEqual([
      'd packages',
      'd packages/core',
      'f packages/core/b.ts',
      'd packages/ui',
      'f packages/ui/a.ts',
      'f README.md',
    ]);
  });

  /*
   * R-13.12 — a path the checkout does not have is a file the pull request deleted. It
   * still gets a row, because "this was removed" is part of the change.
   */
  it('keeps the checkout’s own entry where there is one, and invents a row where there is not', () => {
    const real: TreeEntry = { path: 'spec.md', name: 'spec.md', type: 'file', kind: 'markdown' };
    const entries = changedTreeEntries(['spec.md', 'gone.ts'], new Map([['spec.md', real]]));
    expect(entries.find((e) => e.path === 'spec.md')).toBe(real);
    expect(entries.find((e) => e.path === 'gone.ts')).toMatchObject({ type: 'file', name: 'gone.ts' });
  });
});

/*
 * `Send` and `Send all` posted to GitHub with no sign of it — the request can take
 * seconds, and a reviewer who saw nothing move pressed again. The guard matters as much
 * as the ring here: a second press mid-flight is a second comment.
 */
describe('sending a review comment shows that it is sending', () => {
  const held = draftRecord({ id: 'd-held0001', target: { path: 'spec.md', kind: 'range', startLine: 3 } });

  it('spins the row while the publish is in flight, and refuses a second press', async () => {
    const server = fakeDraftServer({ drafts: [held] });
    let publishes = 0;
    // The publish route never settles, so the in-flight state stays on screen to assert.
    const impl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/publish')) {
        publishes += 1;
        return new Promise<Response>(() => {});
      }
      return (server.impl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));

    const send = await screen.findByRole('button', { name: 'Send' });
    fireEvent.click(send);

    await waitFor(() => expect(send.querySelector('[data-vs-spinner]')).toBeTruthy());
    // Every action on the card is out of reach until it settles, Discard included.
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(send);
    expect(publishes).toBe(1);
  });
});

/*
 * Opening a checkout showed the heading "Changed files", the sentence under it, and then
 * blank space — for as long as GitHub took to answer. It read as a pull request that
 * changed nothing, on a surface where that is a real state with its own sentence.
 */
describe('the checkout says it is loading rather than looking empty', () => {
  /** A `fetch` where `/files` never settles; everything else answers normally. */
  const hangingFiles = () => {
    const drafts = { ok: true, status: 200, json: async () => ({ drafts: [] }) } as unknown as Response;
    return (async (url: string) => {
      if (url.endsWith('/files')) return new Promise<Response>(() => {});
      return drafts;
    }) as unknown as typeof fetch;
  };

  it('says what it is waiting for, in the column and in the pane', async () => {
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={hangingFiles()} />);

    const line = await screen.findByText('Reading what changed…');
    expect(line.querySelector('[data-vs-spinner]')).toBeTruthy();
    expect(screen.getByText('Opening the checkout…')).toBeTruthy();

    // `null` is "not answered yet"; the empty array is a different claim with its own words.
    expect(screen.queryByText('This pull request changes no files.')).toBeNull();
    // And no count is asserted before one has been produced.
    expect(screen.queryByText(/Changed files \(/)).toBeNull();
  });

  it('replaces both with the real answer once it lands', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /pay\.ts/ })).toBeTruthy());
    expect(screen.queryByText('Reading what changed…')).toBeNull();
    expect(screen.queryByText('Opening the checkout…')).toBeNull();
  });

  /* `0 files` while the walk runs is a number the walk has not produced. */
  it('counts the checkout out loud rather than claiming zero', async () => {
    invalidateTree();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(<CollabPrReview pull={PULL} worktree={WORKTREE} onExit={vi.fn()} fetchImpl={impl} />);

    const toggle = await screen.findByRole('button', { name: /Rest of the checkout/ });
    expect(toggle.textContent).toContain('counting files…');
    expect(toggle.textContent).not.toContain('0 files');
    expect(toggle.querySelector('[data-vs-spinner]')).toBeTruthy();
  });
});
