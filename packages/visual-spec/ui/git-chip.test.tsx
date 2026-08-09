// @vitest-environment jsdom
/**
 * git-chip.test.tsx — the header's git context chip and the branch at the point
 * of apply (R-3.1 … R-3.9, R-4.1 … R-4.3).
 *
 * Driven through `MainHeader` and `BrandHeader` rather than the chip in isolation:
 * R-3.1 is a claim about where the chip *is* — beside the served path, in both
 * headers — and a test that mounted the chip directly would hold whether or not
 * either header ever rendered it.
 *
 * THIS SUITE IS ALSO R-6.2's, AND THAT IS WHY IT WAS NOT COPIED. Everything below
 * runs against a server with `git.allowCheckout` off (`/__vs/git/branches` answers
 * 404) and collaboration unconfigured — the default posture of both. R-6.2 says the
 * chip must then render *exactly as Unit 3 specifies*, so the honest test of it is
 * Unit 3's own assertions still passing, not a second set of assertions written
 * beside them that could drift. A regression in the default path fails here.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRecord } from '../core/editing/comment-doc';
import { BrandHeader, MainHeader } from './main-header';

const OPEN_COMMENT = {
  id: 'c-1',
  workflow: 'visual-spec',
  target: { path: 'docs/spec.md', kind: 'range', startLine: 3, heading: 'The Spec' },
  comment: 'needs a citation',
  status: 'open',
  ts: '2026-08-08T00:00:00.000Z',
  replies: [],
} as unknown as CommentRecord;

const REMOTE_GITHUB = {
  state: 'remote',
  branch: 'main',
  detached: false,
  owner: 'acme',
  repo: 'docs',
  host: 'github.com',
  url: 'git@github.com:acme/docs.git',
};

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** `PENDING` stands for a read that never comes back — the pre-first-read state. */
const PENDING = Symbol('pending');

function installFetch(git: unknown) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/git') {
      if (git === PENDING) return new Promise<Response>(() => {}); // never settles
      return jsonRes(git);
    }
    // R-6.3 — with the flag off the branch routes do not exist. This is the answer a
    // default server gives, and every assertion in this file is made against it.
    if (url === '/__vs/git/branches') return { ok: false, status: 404, json: async () => ({ error: 'no route' }) } as Response;
    // Likewise collaboration: no block configured, so no count and — R-7.2 — no
    // request for one. `unexpectedPulls` below is what asserts the second half.
    if (url === '/__vs/collab') {
      return jsonRes({ available: false, reason: 'not-configured', message: 'Collaboration is not configured.', missingScopes: [] });
    }
    if (url.startsWith('/__vs/comments')) return jsonRes([OPEN_COMMENT]);
    if (url === '/__vs/source/root') return jsonRes({ root: '/repo/docs' });
    if (url === '/__vs/apply/start') return jsonRes({ ok: true });
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Renders the main header over a given git context and hands back the chip. */
async function mountChip(git: unknown): Promise<HTMLElement> {
  installFetch(git);
  render(<MainHeader file="docs/spec.md" />);
  return await screen.findByTestId('git-chip');
}

describe('the chip is in both headers, beside the served path (R-3.1)', () => {
  it('renders in the main header', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    expect(chip).toBeTruthy();
  });

  it('renders in the empty-state BrandHeader too', async () => {
    installFetch(REMOTE_GITHUB);
    render(<BrandHeader />);
    const chip = await screen.findByTestId('git-chip');
    await waitFor(() => expect(chip.textContent).toContain('acme/docs'));
  });

  it('sits next to the path button, not somewhere else in the bar', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    // The path button and the chip share one row: the directory and the branch
    // checked out in it are the same fact. The chip's immediate parent is the
    // positioned wrapper its popovers hang off, so the row is one step further out.
    const row = (chip.closest('[data-testid="git-chip-area"]') as HTMLElement).parentElement as HTMLElement;
    expect(within(row).getByText('/repo/docs')).toBeTruthy();
  });
});

describe('before the first read completes (R-3.2)', () => {
  it('asserts none of the three states', async () => {
    const chip = await mountChip(PENDING);
    const text = chip.textContent ?? '';
    expect(text).not.toContain('not a git repo');
    expect(text).not.toContain('no remote');
    expect(text).not.toContain('unrecognised remote');
    expect(text.trim()).toBe('');
    // No repository link either — nothing has been established to link to.
    expect(chip.querySelector('a')).toBeNull();
  });
});

describe('state none (R-3.3)', () => {
  it('says it is not a git repository, and names no branch or repository', async () => {
    const chip = await mountChip({ state: 'none' });
    await waitFor(() => expect(chip.textContent).toContain('not a git repo'));
    expect(chip.textContent).not.toContain('/');
    expect(chip.querySelector('a')).toBeNull();
    expect(chip.querySelector('svg')).toBeTruthy(); // the "not a repository" icon
  });
});

describe('state local (R-3.4 / R-3.5)', () => {
  it('without a URL: the branch, and that no remote is configured', async () => {
    const chip = await mountChip({ state: 'local', branch: 'wip/thing', detached: false });
    await waitFor(() => expect(chip.textContent).toContain('wip/thing'));
    expect(chip.textContent).toContain('no remote');
    expect(chip.textContent).not.toContain('unrecognised');
  });

  it('with a URL: the branch, "unrecognised remote", and the raw URL on hover', async () => {
    const url = 'ssh://build-host:2222/acme/docs.git';
    const chip = await mountChip({ state: 'local', branch: 'main', detached: false, url });
    await waitFor(() => expect(chip.textContent).toContain('unrecognised remote'));
    expect(chip.textContent).toContain('main');
    expect(chip.getAttribute('title')).toContain(url);
  });

  /*
   * The specific lie this state exists to prevent. An `origin` the parser did not
   * recognise is still an origin the user can see in their own git config; saying
   * "no remote" there denies something true.
   */
  it('with a URL, never renders the words of the no-remote case', async () => {
    const chip = await mountChip({ state: 'local', branch: 'main', detached: false, url: 'ssh://h:2222/a/b.git' });
    await waitFor(() => expect(chip.textContent).toContain('unrecognised remote'));
    expect(chip.textContent).not.toContain('no remote');
    expect(chip.textContent).not.toMatch(/\bno remote\b/i);
  });
});

describe('state remote (R-3.6 … R-3.8)', () => {
  it('shows owner/repo and the branch', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    await waitFor(() => expect(chip.textContent).toContain('acme/docs'));
    expect(chip.textContent).toContain('main');
    expect(chip.textContent).not.toContain('no remote');
  });

  it('on github.com the repository name is a new-tab link with rel="noopener noreferrer" (R-3.7)', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    const link = await waitFor(() => {
      const a = chip.querySelector('a');
      if (!a) throw new Error('no anchor yet');
      return a;
    });
    expect(link.textContent).toBe('acme/docs');
    expect(link.getAttribute('href')).toBe('https://github.com/acme/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('on any other host the facts are still shown, but as text (R-3.8)', async () => {
    const chip = await mountChip({
      state: 'remote',
      branch: 'main',
      detached: false,
      owner: 'acme',
      repo: 'docs',
      host: 'gitlab.com',
      url: 'https://gitlab.com/acme/docs.git',
    });
    await waitFor(() => expect(chip.textContent).toContain('acme/docs'));
    expect(chip.textContent).toContain('main'); // host-independent facts survive
    expect(chip.querySelector('a')).toBeNull();
  });
});

describe('a detached HEAD is presented as one (R-3.9)', () => {
  it('shows the sha and labels it detached rather than passing it off as a branch', async () => {
    const chip = await mountChip({
      state: 'remote',
      branch: 'a1b2c3d',
      detached: true,
      owner: 'acme',
      repo: 'docs',
      host: 'github.com',
      url: 'https://github.com/acme/docs.git',
    });
    await waitFor(() => expect(chip.textContent).toContain('a1b2c3d'));
    expect(chip.textContent).toContain('detached');
    expect(within(chip).getByTitle('detached HEAD')).toBeTruthy();
  });

  it('a named branch carries no detached label', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    await waitFor(() => expect(chip.textContent).toContain('main'));
    expect(chip.textContent).not.toContain('detached');
  });
});

/*
 * What the default server does NOT add to the chip. Both halves are the same claim:
 * a capability that configuration has not granted is absent, not present-and-refusing.
 */
describe('with neither capability configured (R-6.2 / R-7.2)', () => {
  it('renders the branch as text, with no control to open a branch list', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    await waitFor(() => expect(chip.textContent).toContain('main'));
    // Not a *disabled* control — no control. A disabled one advertises a capability
    // the user cannot have and cannot be told how to get.
    expect(screen.queryByTestId('git-branch-switch')).toBeNull();
    expect(chip.querySelector('button')).toBeNull();
    expect(screen.queryByTestId('git-branch-menu')).toBeNull();
  });

  it('displays no pull request count, and asks for none', async () => {
    const chip = await mountChip(REMOTE_GITHUB);
    await waitFor(() => expect(chip.textContent).toContain('acme/docs'));
    // Wait for availability to have answered — before it does, "no request was made"
    // is true of any implementation, including one that is about to make it.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/__vs/collab')).toBe(true));

    expect(screen.queryByTestId('git-pull-count')).toBeNull();
    // R-7.2's second half, which an absent element cannot demonstrate: the listing was
    // never requested, so an unconfigured server is not being asked about a repository
    // it was never given.
    const pullReads = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).startsWith('/__vs/collab/pulls'));
    expect(pullReads).toEqual([]);
  });
});

/*
 * R-4.1 is the requirement that makes the whole feature true rather than merely
 * stated: the failure being fixed is "comment, run apply, and the edits land on
 * whichever branch happened to be checked out", and that decision is made in the
 * scope chooser, not in the header corner.
 */
describe('the branch at the point of apply (R-4.1 / R-4.2)', () => {
  async function openScopeChooser(git: unknown) {
    installFetch(git);
    render(<MainHeader file="docs/spec.md" />);
    // Wait until the cart has the open comment, otherwise Apply is disabled.
    const applyBtn = await screen.findByTitle(/Apply the open comments/);
    await waitFor(() => expect((applyBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(applyBtn);
    return await screen.findByText('Apply comments…');
  }

  it('shows the active branch before any scope is picked', async () => {
    await openScopeChooser(REMOTE_GITHUB);
    const branch = await screen.findByTestId('scope-branch');
    expect(branch.textContent).toContain('main');
    // Before any scope has been chosen — all three scope rows are still on screen.
    expect(screen.getByText('Whole workspace')).toBeTruthy();
  });

  /*
   * R-4.3. The same lie R-3.9 forbids in the chip, forbidden at the point where it
   * costs something: `on a1b2c3d` reads as a branch called `a1b2c3d`, and the user
   * is about to let an agent write files against it.
   */
  it('presents a detached HEAD as detached, not as a branch name (R-4.3)', async () => {
    await openScopeChooser({
      state: 'remote',
      branch: 'a1b2c3d',
      detached: true,
      owner: 'acme',
      repo: 'docs',
      host: 'github.com',
      url: 'https://github.com/acme/docs.git',
    });
    const branch = await screen.findByTestId('scope-branch');
    const text = branch.textContent ?? '';
    expect(text).toContain('a1b2c3d'); // the sha is still the useful fact
    expect(text).toContain('detached HEAD');
    expect(branch.getAttribute('title')).toContain('detached HEAD');
    // The exact misreading: the sha standing alone where a branch name would be.
    expect(text.replace(/\s+/g, ' ').trim()).not.toBe('on a1b2c3d');
  });

  it('a named branch is still shown bare, with no detached label (R-4.3)', async () => {
    await openScopeChooser(REMOTE_GITHUB);
    const branch = await screen.findByTestId('scope-branch');
    expect((branch.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('on main');
    expect(branch.textContent).not.toContain('detached');
  });

  it('shows no branch for state none, and every scope button still runs (R-4.2)', async () => {
    await openScopeChooser({ state: 'none' });
    expect(screen.queryByTestId('scope-branch')).toBeNull();

    for (const label of [/Whole workspace/, /This file/, /Pick comments/]) {
      const btn = screen.getByText(label).closest('button') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    }
    const whole = screen.getByText('Whole workspace').closest('button') as HTMLButtonElement;
    fireEvent.click(whole);
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/__vs/apply/start')).toBe(true),
    );
  });

  it('shows no branch before the first read completes, and does not block the run (R-4.2)', async () => {
    await openScopeChooser(PENDING);
    expect(screen.queryByTestId('scope-branch')).toBeNull();

    for (const label of [/Whole workspace/, /This file/, /Pick comments/]) {
      const btn = screen.getByText(label).closest('button') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    }
    fireEvent.click(screen.getByText(/This file/).closest('button') as HTMLButtonElement);
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/__vs/apply/start')).toBe(true),
    );
  });
});

/*
 * What survives when the chip runs out of room.
 *
 * The defect: `metuur-ai/visual-spec-collaboration-test · spike/anchor-test · 3 open`
 * rendered the repository in full and clipped the branch AND the count off the chip's
 * right edge. Both were in the accessibility tree and neither was on screen — so the
 * count, which is a button, was a control that existed and could not be pressed, on
 * exactly the repositories whose names are long enough to hide it.
 *
 * jsdom performs no layout, so no assertion here can prove pixels. What it CAN pin is
 * the rule that decides the outcome: which children are allowed to give way, and which
 * are not. That is the part that was never stated and therefore never held.
 */
describe('the chip sacrifices the repository name, never the branch or the count', () => {
  const LONG = {
    ...REMOTE_GITHUB,
    owner: 'metuur-ai',
    repo: 'visual-spec-collaboration-test',
    branch: 'spike/anchor-test',
  };

  /** Collaboration configured, so the count renders and can be reasoned about. */
  function installWithPulls(git: unknown, pulls: number) {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/__vs/git') return jsonRes(git);
      if (url === '/__vs/git/branches') return jsonRes({ branches: ['main', 'spike/anchor-test'], current: 'spike/anchor-test' });
      if (url === '/__vs/collab') {
        return jsonRes({ available: true, login: 'javierhbr', repo: { owner: 'metuur-ai', repo: 'visual-spec-collaboration-test' } });
      }
      if (url.startsWith('/__vs/collab/pulls')) {
        return jsonRes({ pulls: Array.from({ length: pulls }, (_, i) => ({ number: i + 1, title: `pr ${i}`, state: 'open', draft: false, headBranch: 'b', baseBranch: 'main', headSha: 'a', htmlUrl: '', author: 'x', documentId: null })) });
      }
      if (url.startsWith('/__vs/comments')) return jsonRes([OPEN_COMMENT]);
      if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', impl);
  }

  it('lets the repository name truncate', async () => {
    installWithPulls(LONG, 3);
    render(<MainHeader file="docs/spec.md" />);
    const repo = await screen.findByText('metuur-ai/visual-spec-collaboration-test');

    expect(repo.style.textOverflow).toBe('ellipsis');
    expect(repo.style.overflow).toBe('hidden');
    // Without `min-width: 0` a flex item refuses to shrink below its content, which is
    // what let the name push everything after it past the chip's clipped edge.
    expect(repo.style.minWidth).toBe('0');
  });

  it('never lets the pull request count shrink', async () => {
    installWithPulls(LONG, 3);
    render(<MainHeader file="docs/spec.md" />);
    const count = await screen.findByTestId('git-pull-count');

    expect(count.textContent).toBe('3 open');
    expect(count.style.flexShrink).toBe('0');
    expect(count.style.whiteSpace).toBe('nowrap');
  });

  /*
   * The branch keeps its own ceiling, so a long BRANCH cannot do to the count what the
   * long repository name was doing — the fix has to hold from either direction.
   */
  it('caps the branch so it cannot crowd the count out either', async () => {
    installWithPulls({ ...LONG, branch: 'spike/a-very-long-branch-name-someone-actually-used' }, 3);
    render(<MainHeader file="docs/spec.md" />);
    const branch = await screen.findByTestId('git-branch-switch');

    expect(branch.style.maxWidth).toBe('160px');
    // The label truncates inside the button, so the ▾ is not clipped away with it —
    // a dropdown whose only affordance is the arrow must keep the arrow.
    const [label, caret] = [...branch.children] as HTMLElement[];
    expect(label.style.textOverflow).toBe('ellipsis');
    expect(caret.textContent).toBe('▾');
    expect(caret.style.flexShrink).toBe('0');
  });
});
