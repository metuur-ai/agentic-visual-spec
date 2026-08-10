// @vitest-environment jsdom
/**
 * collab-pr-review.test.tsx — reading a pull request (R-13.11, R-13.19, R-W1.3, R-W1.4).
 *
 * ONE FAKE, FOR ONE BOUNDARY. Every read this surface makes is a `/__vs/collab/pulls/:n/*`
 * call, and all of them are injected into the component (`fetchImpl`). The global `fetch`
 * is stubbed to *throw*: the surface used to browse the served directory through
 * `/__vs/tree`, and a review that still reached for it would be a review that only works
 * where a checkout happens to be on disk. Nothing here touches a server, a git repository
 * or a disk.
 *
 * The read-only suite matters most: R-13.19 is a promise about what the interface does
 * *not* offer, and the only way to keep such a promise under refactoring is to assert the
 * absence.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '../core/collaboration/review-drafts';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
import type { ReviewEntry } from '../core/collaboration/review-source';
import { CollabPrReview, changedTreeEntries } from './collab-pr-review';
import { reviewCommentPanelSource } from './review-comment-source';
import type { TreeEntry } from './use-tree';

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

/**
 * The review as `CollabPullsPanel` hands it over. `source` is the label R-W1.5 requires the
 * surface to report; the host-sourced counterpart is built inline where it is asserted on.
 */
/** R-W4.5 — the repository the review reads from, which the server resolves and reports. */
const REPO = { owner: 'acme', repo: 'docs' };
const REVIEW = { source: 'checkout' as const, headSha: WORKTREE.headSha, repo: REPO, worktree: WORKTREE };

/**
 * The pull request's tree, one directory at a time — which is the only shape a
 * `ReviewSource` answers in, and therefore the only shape `/pulls/:n/tree` serves. A
 * directory that is not a key here is one the review cannot read.
 */
const DIRECTORIES: Record<string, ReviewEntry[]> = {
  '': [
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'vendor', path: 'vendor', kind: 'directory' },
    { name: 'spec.md', path: 'spec.md', kind: 'file' },
  ],
  src: [
    { name: 'pay.ts', path: 'src/pay.ts', kind: 'file' },
    { name: 'util.ts', path: 'src/util.ts', kind: 'file' },
  ],
  vendor: [{ name: 'huge.ts', path: 'vendor/huge.ts', kind: 'file' }],
};

/** The bytes at the pinned commit, repo-relative — no worktree prefix on any of them. */
const CONTENT: Record<string, string> = {
  'src/pay.ts': 'export const pay = () => 1;\n',
  'src/util.ts': 'export const util = () => 2;\n',
  'spec.md': '# Refunds\n\nWithin five business days.\n',
  'vendor/huge.ts': 'export const huge = 3;\n',
};

const reply = (status: number, json: unknown) =>
  ({ ok: status < 400, status, json: async () => json }) as unknown as Response;

/**
 * The two review reads, answered as the routes answer them. Shared by every fake below,
 * because they are the surface's whole read path now and no test can avoid them.
 *
 * Returns `undefined` for a URL that is not one of the two, so a caller can add its own
 * routes in front of it.
 */
function reviewRead(url: string): Response | undefined {
  const tree = /^\/__vs\/collab\/pulls\/42\/tree\?path=(.*)$/.exec(url);
  if (tree) {
    const path = decodeURIComponent(tree[1] as string);
    const entries = DIRECTORIES[path];
    if (!entries) return reply(404, { error: 'That path could not be read at this commit.', reason: 'not-readable' });
    return reply(200, { pullNumber: 42, headSha: PULL.headSha, path, entries });
  }
  const raw = /^\/__vs\/collab\/pulls\/42\/raw\?path=(.*)$/.exec(url);
  if (raw) {
    const path = decodeURIComponent(raw[1] as string);
    const text = CONTENT[path];
    if (text === undefined) {
      return reply(404, { error: 'That path could not be read at this commit.', reason: 'not-readable' });
    }
    return reply(200, { pullNumber: 42, headSha: PULL.headSha, path, text });
  }
  return undefined;
}

/** The collaboration routes this surface calls, with `reply` standing in for `/files`. */
function fakeCollabFetch(reply: { ok: boolean; status: number; json: unknown }) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    const read = reviewRead(url);
    if (read) return read;
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

/**
 * R-W1.4, asserted as an absence. The served directory's routes are not this surface's to
 * call: a review that reached for `/__vs/tree` would read files only where a checkout is
 * on disk, which is precisely the failure this feature exists to end. Anything that goes
 * to the global `fetch` fails the test that made it.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      throw new Error(`the review surface must read through the pull request routes, not: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = (reply = changedFiles(['src/pay.ts'])) => {
  const { impl, calls } = fakeCollabFetch(reply);
  render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);
  return calls;
};

/*
 * R-W1.3 / R-W1.4 — THE STORY'S OWN CHECK, and the assertion that failed before it.
 *
 * A review supplied by the host has nothing on this disk: no worktree, no path, no served
 * subtree to walk. It opened, named its source and listed its changed files, and then said
 * "No preview for this file." for every one of them, which is SC-1 unmet. Nothing below
 * mentions a source — the reads are the same reads — and that is the point: the two cases
 * are the same test run twice with a different label on the review.
 */
describe('R-W1.3 / R-W1.4 — the files open from either source, through one read path', () => {
  const HOST = { source: 'host' as const, headSha: PULL.headSha, repo: REPO };

  const openReview = (review: { source: 'host' | 'checkout'; headSha: string; repo: { owner: string; repo: string } }) => {
    const { impl, calls } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(<CollabPrReview pull={PULL} review={review} onExit={vi.fn()} fetchImpl={impl} />);
    return calls;
  };

  it('reads a changed file with no checkout on disk', async () => {
    const calls = openReview(HOST);
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    expect(await screen.findByText(/export const pay/)).toBeTruthy();
    // Through the pull request's own route, at the pinned commit — not through the served
    // directory, and not under a worktree prefix.
    expect(calls).toContain('/__vs/collab/pulls/42/raw?path=src%2Fpay.ts');
    expect(calls.some((c) => c.includes('worktrees'))).toBe(false);
  });

  it('reads a file the pull request did not change, by expanding into the tree (R-W2.2)', async () => {
    openReview(HOST);
    fireEvent.click(await screen.findByRole('button', { name: /Rest of the files/ }));
    fireEvent.click(await screen.findByRole('button', { name: /src$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /util\.ts/ }));

    expect(await screen.findByText(/export const util/)).toBeTruthy();
  });

  it('reads the same way from a checkout, with the same result', async () => {
    const calls = openReview({ source: 'checkout', headSha: PULL.headSha, repo: REPO });
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    expect(await screen.findByText(/export const pay/)).toBeTruthy();
    expect(calls).toContain('/__vs/collab/pulls/42/raw?path=src%2Fpay.ts');
  });

  /*
   * THE REASON THE TREE IS NOT WALKED. `listDirectory` answers one directory per call, so
   * a full walk is one round trip per directory in the repository — and on the host source
   * each of those is a round trip to GitHub. A folder nobody opened must cost nothing.
   */
  it('reads one directory per folder opened, and nothing for the folders left shut', async () => {
    const calls = openReview(HOST);
    fireEvent.click(await screen.findByRole('button', { name: /Rest of the files/ }));
    // The root, and only the root, until someone opens something.
    await screen.findByRole('button', { name: /vendor$/ });
    const listings = () => calls.filter((c) => c.includes('/tree?path='));
    expect(listings()).toEqual(['/__vs/collab/pulls/42/tree?path=']);

    fireEvent.click(screen.getByRole('button', { name: /src$/ }));
    await screen.findByRole('button', { name: /util\.ts/ });

    // One more listing, for the folder that was opened. `vendor` sat beside it and was
    // never read.
    expect(listings()).toEqual(['/__vs/collab/pulls/42/tree?path=', '/__vs/collab/pulls/42/tree?path=src']);
    expect(calls.some((c) => c.includes('vendor'))).toBe(false);
  });

  /*
   * R-13.12 / R-W2.7 — a changed path that is not in the tree at this commit is a file the
   * pull request deleted. The read says what to do about it; "No preview for this file"
   * said nothing at all, and used to be the answer for every file on a host-sourced review.
   */
  it('gives the route’s own sentence when a changed path cannot be read', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/gone.ts']));
    render(<CollabPrReview pull={PULL} review={HOST} onExit={vi.fn()} fetchImpl={impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /gone\.ts/ }));

    expect(await screen.findByText(/could not be read at this commit/)).toBeTruthy();
    expect(screen.queryByText('No preview for this file.')).toBeNull();
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
 * The rest of the tree is behind a disclosure, so every test that reaches a file the pull
 * request did not touch has to open it first — which is the point: the changed files are
 * what a reviewer lands on.
 */
/**
 * The rest-of-the-tree pane, queried on its own. The changed-files tree above it holds a
 * `src` folder too — they are two views of one tree — so a bare query would find both.
 */
const restPane = () => within(document.getElementById('vs-checkout-rest') as HTMLElement);

async function openTheRest(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Rest of the files/ }));
  await waitFor(() => expect(restPane().getByRole('button', { name: /vendor$/ })).toBeTruthy());
}

/** Open a folder in that pane and wait for the directory it holds to arrive. */
async function expandFolder(name: RegExp, until: RegExp): Promise<void> {
  fireEvent.click(restPane().getByRole('button', { name }));
  await restPane().findByRole('button', { name: until });
}

describe('R-13.11 — any other file in the tree can be opened', () => {
  it('browses the whole tree, not only the changed subset', async () => {
    mount();
    await openTheRest();
    // Folders open one at a time, because that is what the source can answer.
    await expandFolder(/src$/, /util\.ts/);

    fireEvent.click(screen.getByRole('button', { name: /util\.ts/ }));

    await waitFor(() => expect(screen.getByText(/export const util/)).toBeTruthy());
  });
});

describe('R-13.19 — a checkout is a review surface, not a workspace', () => {
  it('states that it is read-only, and names the commit being read', async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/Read-only —/)).toBeTruthy());
    expect(screen.getByText(/Read-only —/).textContent).toContain('no commit, push or merge');
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
    await expandFolder(/src$/, /util\.ts/);

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
type ServerState = { drafts: ReviewDraft[]; threads: ReviewThreadRecord[] };

/** One review thread as `GET /pulls/:n/comments` projects it. */
const threadRecord = (over: Partial<ReviewThreadRecord> = {}): ReviewThreadRecord => ({
  id: 'c-0000002b',
  workflow: 'visual-spec',
  target: { path: 'spec.md', kind: 'range', startLine: 3 },
  comment: 'test comments 003',
  status: 'open',
  ts: '2026-02-01T09:00:00Z',
  github: {
    reviewCommentId: 43,
    isOutdated: false,
    htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r43',
    user: 'javierhbr',
    updatedAt: '2026-02-01T09:00:00Z',
  },
  replies: [],
  ...over,
});

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
  threads?: ReviewThreadRecord[];
  publish?: (id: string, body: Record<string, unknown>, state: ServerState) => Reply;
  del?: (id: string, state: ServerState) => Reply;
} = {}) {
  const state: ServerState = { drafts: opts.drafts ?? [], threads: opts.threads ?? [] };
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const reply = (r: Reply) =>
    ({ ok: r.status < 400, status: r.status, json: async () => r.json }) as unknown as Response;

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });

    // The two reads every review makes, whichever source supplies it.
    const read = reviewRead(url);
    if (read) return read;

    // `spec.md` is changed too, so the Markdown path is reachable from the entry point
    // a reviewer actually starts at rather than only by walking the tree.
    if (url.endsWith('/files')) return reply({ status: 200, json: changedFiles(['src/pay.ts', 'spec.md']).json });
    if (url === '/__vs/collab/pulls/42/comments' && method === 'GET') {
      return reply({ status: 200, json: { pullNumber: 42, threads: state.threads } });
    }
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
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
    render(<CollabPrReview pull={PULL} review={{ source: 'checkout' as const, headSha: moved.headSha, repo: REPO, worktree: moved }} onExit={vi.fn()} fetchImpl={impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);

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
    render(<CollabPrReview pull={{ ...PULL, author: '' }} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);

    const row = await screen.findByTestId('vs-review-pull');
    expect(row.textContent).toContain('unknown author');
  });

  /*
   * R-W4.5 — the repository, on screen for as long as the review is.
   *
   * Until stories 3.1 and 4.1 there was one repository a review could possibly be of, so
   * `#42` was the whole identity and naming the repository would have been noise. Now a
   * pasted link reaches any repository the credential can read, and #42 exists in most of
   * them — so a review of the wrong one is a plausible diff that reads correctly for
   * twenty minutes. The repository leads the identity line for that reason: it is the
   * first thing on the row and the row never scrolls.
   */
  it('names the repository the review reads from, ahead of the number (R-W4.5)', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(
      <CollabPrReview
        pull={PULL}
        review={{ ...REVIEW, repo: { owner: 'facebook', repo: 'react' } }}
        onExit={vi.fn()}
        fetchImpl={impl}
      />,
    );

    const row = await screen.findByTestId('vs-review-pull');
    expect(row.textContent).toContain('facebook/react#42');
    expect(row.querySelector('[data-vs-review-repo]')?.getAttribute('data-vs-review-repo')).toBe('facebook/react');
  });

  /*
   * The half that makes it a defence rather than a decoration. `pull.htmlUrl` is where the
   * repository is *also* written down, and it is the listing's answer — so a row that read
   * it from there would agree with itself while the review served somebody else's bytes.
   * The fixture below is exactly that disagreement, and the row must side with the review.
   */
  it('names the repository the review came from, not the one the listing named', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(
      <CollabPrReview
        pull={{ ...PULL, htmlUrl: 'https://github.com/acme/docs/pull/42' }}
        review={{ ...REVIEW, repo: { owner: 'other', repo: 'tools' } }}
        onExit={vi.fn()}
        fetchImpl={impl}
      />,
    );

    const row = await screen.findByTestId('vs-review-pull');
    expect(row.textContent).toContain('other/tools#42');
    expect(row.textContent).not.toContain('acme/docs');
  });

  /*
   * "At all times" is the requirement, and the two sources are the two ways a review can
   * exist. A host-sourced review has no checkout to read a repository off, which is
   * precisely why the server reports it rather than the browser deriving it.
   */
  it('names it from either source (R-W4.5)', async () => {
    for (const review of [REVIEW, { source: 'host' as const, headSha: PULL.headSha, repo: REPO }]) {
      const { impl } = fakeCollabFetch(changedFiles([]));
      const { unmount } = render(<CollabPrReview pull={PULL} review={review} onExit={vi.fn()} fetchImpl={impl} />);
      const row = await screen.findByTestId('vs-review-pull');
      expect(row.textContent, review.source).toContain('acme/docs#42');
      unmount();
    }
  });

  it('says read-only exactly once on the surface', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    const { container } = render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);

    await screen.findByTestId('vs-review-pull');
    expect((container.textContent ?? '').match(/read-only/gi) ?? []).toHaveLength(1);
  });

  it('keeps a way back', async () => {
    const onExit = vi.fn();
    const { impl } = fakeCollabFetch(changedFiles([]));
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={onExit} fetchImpl={impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);

    const heading = await screen.findByText(/#42 Rework the payment rules/);
    // The permission to shrink sits on the identity block — a flex child defaults to
    // `min-width: auto` — and the ellipsis sits on the line that may lose characters.
    expect(screen.getByTestId('vs-review-pull').style.minWidth).toMatch(/^0(px)?$/);
    expect(heading.style.textOverflow).toBe('ellipsis');
    expect(heading.style.overflow).toBe('hidden');
    // The identity is the first thing in the string, so the ellipsis takes the title.
    // R-W4.5 put the repository at the head of it — same argument, one place further
    // left: what leads cannot be the thing an ellipsis eats.
    expect((heading.textContent ?? '').startsWith('acme/docs#42')).toBe(true);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
describe('the changed files lead and the rest of the tree stands down', () => {
  it('collapses the tree behind one summary line, expandable in one click', async () => {
    mount();

    const toggle = await screen.findByRole('button', { name: /Rest of the files/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('read for context, not under review');
    /*
     * NO FILE COUNT. The line used to say `3 files`, from the full walk. A tree read one
     * directory at a time has not counted anything, and a number of the rows that happen
     * to be loaded would be a count of what the reviewer has already clicked.
     */
    expect(toggle.textContent).not.toMatch(/\d+ files/);
    // Nothing of the tree is on screen while it is closed.
    expect(screen.queryByRole('button', { name: /vendor$/ })).toBeNull();

    fireEvent.click(toggle);

    expect(await screen.findByRole('button', { name: /vendor$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rest of the files/ }).getAttribute('aria-expanded')).toBe('true');
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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
      pullNumber: 7,
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
      pullNumber: 7,
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

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

    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);
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
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={hangingFiles()} />);

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

  /* A folder that is still being read looks exactly like an empty one, and the two are
   * opposite things to a reviewer — so an open folder with nothing in it yet says so. */
  it('says a directory is being read rather than showing it as empty', async () => {
    const impl = vi.fn(async (url: string) => {
      if (url.includes('/tree?path=src')) return new Promise<Response>(() => {});
      const read = reviewRead(url);
      if (read) return read;
      const files = changedFiles(['src/pay.ts']);
      return { ok: files.ok, status: files.status, json: async () => files.json } as unknown as Response;
    });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl as unknown as typeof fetch} />);

    await openTheRest();
    fireEvent.click(screen.getByRole('button', { name: /src$/ }));

    const line = await screen.findByText('Reading src…');
    expect(line.querySelector('[data-vs-spinner]')).toBeTruthy();
  });
});

/* ================================================================== *
 * The pull request's own conversation — every comment, and its replies
 * ================================================================== */
/*
 * The bug: the panel listed `/pulls/:n/drafts` and nothing else — what THIS machine had
 * written. A reply left on github.com, and any comment by anybody else, was invisible,
 * and no amount of refreshing helped because nothing on the page had ever asked GitHub.
 */
describe('the review shows the pull request’s comments and replies', () => {
  const withReplies = threadRecord({
    replies: [
      { id: 44, body: 'reply comment 003 -A', user: 'javierhbr', createdAt: '2026-02-01T09:01:00Z', htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r44' },
    ],
  });

  it('reads them when the checkout opens, without being asked', async () => {
    const server = fakeDraftServer({ threads: [withReplies] });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));

    expect(await screen.findByText('test comments 003')).toBeTruthy();
    // The reply is the whole point: it exists only on GitHub and nothing local knows it.
    expect(await screen.findByText('reply comment 003 -A')).toBeTruthy();
    expect(server.calls.some((c) => c.url === '/__vs/collab/pulls/42/comments')).toBe(true);
  });

  it('says who wrote a reply and when, so a thread reads as a conversation', async () => {
    const server = fakeDraftServer({ threads: [withReplies] });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));

    const reply = await screen.findByText('reply comment 003 -A');
    const card = reply.closest('[data-vs-reply]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('javierhbr');
    expect(card!.textContent).toContain('2026-02-01');
  });

  it('picks up a new reply when the reviewer presses Refresh comments', async () => {
    const server = fakeDraftServer({ threads: [threadRecord()] });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));
    await screen.findByText('test comments 003');
    expect(screen.queryByText('answered while you were reading')).toBeNull();

    // Somebody answers on github.com. Nothing on this page could know without asking.
    server.state.threads = [
      threadRecord({
        replies: [{ id: 45, body: 'answered while you were reading', user: 'octocat', createdAt: '2026-02-01T09:05:00Z', htmlUrl: 'https://x' }],
      }),
    ];
    fireEvent.click(screen.getByRole('button', { name: /Refresh comments/ }));

    expect(await screen.findByText('answered while you were reading')).toBeTruthy();
  });

  it('counts what is on the pull request, not what this machine happened to send', async () => {
    const server = fakeDraftServer({ threads: [withReplies, threadRecord({ id: 'c-0000002d', github: { ...threadRecord().github, reviewCommentId: 45 } })] });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);

    const tally = await waitFor(() => {
      const el = document.querySelector('[data-vs-draft-tally]');
      expect(el?.textContent).toContain('2 on GitHub');
      return el!;
    });
    expect(tally.textContent).toContain('1 reply');
  });

  it('shows a comment this machine published once, not twice', async () => {
    // The published draft and the thread are the same comment seen from two sides.
    const published = draftRecord({
      id: 'd-pub00001',
      status: 'published',
      target: { path: 'spec.md', kind: 'range', startLine: 3 },
      comment: 'test comments 003',
      published: { reviewCommentId: 43, htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r43', ts: '2026-02-01T09:00:00Z' },
    });
    const server = fakeDraftServer({ drafts: [published], threads: [withReplies] });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={server.impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));

    await screen.findByText('reply comment 003 -A');
    expect(screen.getAllByText('test comments 003')).toHaveLength(1);
  });

  it('says the conversation could not be read rather than showing an empty panel', async () => {
    const impl = (async (url: string) => {
      if (url.endsWith('/comments')) return { ok: false, status: 502, json: async () => ({ error: 'gh is unreachable' }) } as unknown as Response;
      if (url.endsWith('/files')) return { ok: true, status: 200, json: async () => changedFiles(['spec.md']).json } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ drafts: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl} />);
    fireEvent.click(await screen.findByRole('button', { name: /spec\.md/ }));

    await waitFor(() => expect(document.querySelector('[data-vs-threads-error]')?.textContent).toContain('gh is unreachable'));
  });
});

/* ================================================================== *
 * Which source is supplying the review, and what that costs the reader
 * ================================================================== */

describe('R-W1.5 — the review says where its files come from', () => {
  /*
   * Both configurations, because a label that only ever appears on one of them tells the
   * reviewer nothing: "no chip" would have to be read as the other case, which is exactly
   * the inference the requirement exists to remove.
   *
   * The assertions are on the sentence, not only on the attribute. The word `checkout` in
   * a data attribute is for tests; what the reviewer needs is the consequence — whether
   * opening a file will cost them a round trip — and that is what is asserted.
   */
  it('says the files are already here when a checkout supplies them', async () => {
    mount();
    const chip = await waitFor(() => document.querySelector('[data-vs-review-source]')!);
    expect(chip.getAttribute('data-vs-review-source')).toBe('checkout');
    expect(chip.textContent).toMatch(/on this machine/i);
    expect(chip.textContent).toMatch(/without the network/i);
  });

  it('says every file costs a request when the host supplies them', async () => {
    const { impl } = fakeCollabFetch(changedFiles(['src/pay.ts']));
    render(
      <CollabPrReview
        pull={PULL}
        review={{ source: 'host', headSha: PULL.headSha, repo: REPO }}
        onExit={vi.fn()}
        fetchImpl={impl}
      />,
    );
    const chip = await waitFor(() => document.querySelector('[data-vs-review-source]')!);
    expect(chip.getAttribute('data-vs-review-source')).toBe('host');
    expect(chip.textContent).toMatch(/from GitHub/i);
    expect(chip.textContent).toMatch(/needs the network/i);
  });

  /*
   * The commit is the review's, not the checkout's. It used to be read off `worktree`,
   * which made the one fact every held comment is stamped with unavailable to a review
   * that has no working copy.
   */
  it('names the pinned commit whether or not there is a checkout', async () => {
    const { impl } = fakeCollabFetch(changedFiles([]));
    render(
      <CollabPrReview pull={PULL} review={{ source: 'host', headSha: PULL.headSha, repo: REPO }} onExit={vi.fn()} fetchImpl={impl} />,
    );
    expect(await screen.findByText(/at abc1234/)).toBeTruthy();
  });
});

describe('R-W2.8 — a read that outlasts a glance says so', () => {
  it('shows progress while a file read is in flight, and clears it when the bytes land', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const impl = vi.fn(async (url: string) => {
      if (url.includes('/raw?path=')) await held;
      const read = reviewRead(url);
      if (read) return read;
      const files = changedFiles(['src/pay.ts']);
      return { ok: files.ok, status: files.status, json: async () => files.json } as unknown as Response;
    });
    render(<CollabPrReview pull={PULL} review={REVIEW} onExit={vi.fn()} fetchImpl={impl as unknown as typeof fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));

    // Not immediately: a read that returns in a few milliseconds — every read from a
    // checkout on this disk — must not paint an indicator and take it away again.
    expect(document.querySelector('[data-vs-reading]')).toBeNull();

    await waitFor(() => expect(document.querySelector('[data-vs-reading]')).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText(/Reading pay\.ts…/)).toBeTruthy();
    // The ring, not only the word — the whole point of the shared component.
    expect(document.querySelector('[data-vs-reading] [data-vs-spinner]')).toBeTruthy();
    // And nothing claims the file is unreadable while it is still being read.
    expect(screen.queryByText('No preview for this file.')).toBeNull();

    release();
    await waitFor(() => expect(document.querySelector('[data-vs-reading]')).toBeNull());
    expect(screen.getByText(/export const pay/)).toBeTruthy();
  });

  it('says nothing at all for a read that answers straight away', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /pay\.ts/ }));
    await screen.findByText(/export const pay/);
    expect(document.querySelector('[data-vs-reading]')).toBeNull();
  });
});
