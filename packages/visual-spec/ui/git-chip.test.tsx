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

/**
 * Hover a chip and wait for its tooltip.
 *
 * The delay is real (`TOOLTIP_DELAY_MS`), so this polls rather than asserting on the next
 * tick — `findByRole` outlasts it comfortably, and using the real delay keeps the test
 * honest about the fact that there is one.
 */
async function hover(el: HTMLElement): Promise<HTMLElement> {
  fireEvent.mouseEnter(el);
  return await screen.findByRole('tooltip');
}

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
    // The URL is disclosed on hover — the chip's own tooltip now, not the browser's
    // `title`. What R-3.5 requires is that the URL be reachable, not which layer shows it.
    expect((await hover(screen.getByTestId('git-repo-chip'))).textContent).toContain(url);
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
    // R-3.9 — the sha is labelled in the visible text, so the tooltip is a second
    // statement of it rather than the only one.
    expect(chip.textContent).toContain('detached');
    expect((await hover(within(chip).getByText(/detached HEAD/))).textContent).toContain('detached HEAD');
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

    expect(branch.style.maxWidth).toBe('200px');
    // The label truncates inside the button, so the ▾ is not clipped away with it —
    // a dropdown whose only affordance is the arrow must keep the arrow.
    // The pill is [glyph, label, caret]; the label is the only part allowed to give way.
    const [, label, caret] = [...branch.children] as HTMLElement[];
    expect(label.textContent).toContain('spike/a-very-long-branch-name');
    expect(label.style.textOverflow).toBe('ellipsis');
    expect(caret.textContent).toBe('▾');
    expect(caret.style.flexShrink).toBe('0');
  });
});

/*
 * Three pills, and the tooltip that makes truncation survivable.
 *
 * Truncating is only acceptable because the full value stays *available*. It used to be
 * available through `title` — a ~1s browser delay, no styling, and unreachable by
 * keyboard on a plain span. These pin the replacement: the full string on hover and on
 * focus, and described to assistive tech rather than merely drawn.
 */
describe('the repository, the branch and the count are separate chips', () => {
  const LONG_REMOTE = {
    ...REMOTE_GITHUB,
    owner: 'metuur-ai',
    repo: 'visual-spec-collaboration-test',
    branch: 'spike/anchor-test',
    url: 'git@github.com:metuur-ai/visual-spec-collaboration-test.git',
  };

  function installSplit(git: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/__vs/git') return jsonRes(git);
        if (url === '/__vs/git/branches') return jsonRes({ branches: ['main'], current: 'spike/anchor-test' });
        if (url === '/__vs/collab') return jsonRes({ available: true, login: 'x', repo: { owner: 'metuur-ai', repo: 'visual-spec-collaboration-test' } });
        if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [{ number: 1, title: 't', state: 'open', draft: false, headBranch: 'b', baseBranch: 'main', headSha: 'a', htmlUrl: '', author: 'x', documentId: null }] });
        if (url.startsWith('/__vs/comments')) return jsonRes([OPEN_COMMENT]);
        if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it('renders them as three pills rather than one', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);

    const repo = await screen.findByTestId('git-repo-chip');
    const branch = await screen.findByTestId('git-branch-switch');
    const count = await screen.findByTestId('git-pull-count');

    // Separate boxes: neither contains the other, so neither can eat the other's width.
    expect(repo.contains(branch)).toBe(false);
    expect(branch.contains(count)).toBe(false);
    expect(repo.contains(count)).toBe(false);
    // And each is a pill in its own right.
    for (const pill of [repo, branch, count]) expect(pill.style.borderRadius).toBe('999px');
  });

  it('still reads as one git statement, so the group keeps the chip’s identity', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);
    const group = await screen.findByTestId('git-chip');

    await waitFor(() => expect(group.textContent).toContain('metuur-ai/visual-spec-collaboration-test'));
    expect(group.textContent).toContain('spike/anchor-test');
    expect(group.textContent).toContain('1 open');
  });

  it('reveals the full repository and origin URL on hover', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);

    const tip = await hover(await screen.findByTestId('git-repo-chip'));
    expect(tip.textContent).toContain('metuur-ai/visual-spec-collaboration-test');
    expect(tip.textContent).toContain('git@github.com:metuur-ai/visual-spec-collaboration-test.git');
  });

  /* A truncated branch is exactly what a keyboard user needs, and the switcher is focusable. */
  it('reveals the branch on focus, without waiting for a hover delay', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);

    fireEvent.focus(await screen.findByTestId('git-branch-switch'));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('spike/anchor-test');
  });

  it('describes the chip to assistive tech rather than only drawing it', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);

    const branch = await screen.findByTestId('git-branch-switch');
    fireEvent.focus(branch);
    const tip = screen.getByRole('tooltip');
    const described = branch.closest('[aria-describedby]') as HTMLElement;
    expect(described.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('hides again on leave, and on Escape', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);

    const repo = await screen.findByTestId('git-repo-chip');
    await hover(repo);
    fireEvent.mouseLeave(repo);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    const branch = screen.getByTestId('git-branch-switch');
    fireEvent.focus(branch);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(branch, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  /* Nothing shows before the pointer settles, or the row would strobe on the way past. */
  it('does not appear on the instant the pointer crosses a chip', async () => {
    installSplit(LONG_REMOTE);
    render(<MainHeader file="docs/spec.md" />);

    const repo = await screen.findByTestId('git-repo-chip');
    fireEvent.mouseEnter(repo);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(repo);
    // And a crossing that ended still leaves nothing behind once the delay elapses.
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

/*
 * Clicking a chip is not a request to be told what it is.
 *
 * Two of these chips open a popover directly beneath themselves, and the bubble sat on
 * top of it — explaining a control the user had already used, over the answer they had
 * just asked for. The subtlety is the event order: mousedown → focus → click, so hiding
 * on mousedown alone let the focus handler put it straight back up.
 */
describe('the tooltip gets out of the way when the chip is used', () => {
  function installOne(git: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/__vs/git') return jsonRes(git);
        if (url === '/__vs/git/branches') return jsonRes({ branches: ['main'], current: 'main' });
        if (url === '/__vs/collab') return jsonRes({ available: true, login: 'x', repo: { owner: 'acme', repo: 'docs' } });
        if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
        if (url.startsWith('/__vs/comments')) return jsonRes([OPEN_COMMENT]);
        if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it('closes on press and stays closed through the focus that follows it', async () => {
    installOne(REMOTE_GITHUB);
    render(<MainHeader file="docs/spec.md" />);

    const branch = await screen.findByTestId('git-branch-switch');
    await hover(branch);

    // The real sequence a browser sends on a click.
    fireEvent.mouseDown(branch);
    fireEvent.focus(branch);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  /* And a genuine keyboard focus, arriving with no pointer press, still shows it. */
  it('still shows on a keyboard focus that did not follow a press', async () => {
    installOne(REMOTE_GITHUB);
    render(<MainHeader file="docs/spec.md" />);

    const branch = await screen.findByTestId('git-branch-switch');
    fireEvent.mouseDown(branch);
    fireEvent.focus(branch);
    fireEvent.blur(branch);

    fireEvent.focus(branch);
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });
});

/*
 * The GitHub mark says "GitHub", so it may only appear where that is true.
 *
 * R-3.7 / R-3.8 keep owner, repository and branch host-independent — only the *link* is
 * GitHub-specific — and a brand mark is a stronger claim than a link, not a weaker one.
 * Stamping it on every remote would tell a GitLab user their repository is on GitHub,
 * which is the one thing the `remote` state is careful not to say.
 */
describe('the repository chip wears GitHub’s mark only where the host is GitHub', () => {
  const markOf = (chip: HTMLElement) => chip.querySelector('svg[viewBox="0 0 16 16"]');

  it('shows the mark for a github.com origin', async () => {
    await mountChip(REMOTE_GITHUB);
    const chip = await screen.findByTestId('git-repo-chip');
    expect(markOf(chip)).toBeTruthy();
  });

  it('shows the generic link glyph for a recognised non-GitHub host', async () => {
    await mountChip({
      state: 'remote',
      branch: 'main',
      detached: false,
      owner: 'acme',
      repo: 'docs',
      host: 'gitlab.com',
      url: 'git@gitlab.com:acme/docs.git',
    });
    const chip = await screen.findByTestId('git-repo-chip');

    expect(markOf(chip)).toBeNull();
    // The repository is still named — the host changes the glyph, never the facts.
    expect(chip.textContent).toContain('acme/docs');
    expect(chip.querySelector('svg')).toBeTruthy();
  });

  /* A brand mark is not ours to restyle: official path, inheriting the chip's tone. */
  it('renders the mark as GitHub ships it, tinted by the chip rather than recoloured', async () => {
    await mountChip(REMOTE_GITHUB);
    const mark = markOf(await screen.findByTestId('git-repo-chip')) as SVGElement;

    expect(mark.getAttribute('fill')).toBe('currentColor');
    expect(mark.getAttribute('viewBox')).toBe('0 0 16 16');
    // Decorative: the repository name beside it already carries the meaning.
    expect(mark.getAttribute('aria-hidden')).toBe('true');
  });
});

/*
 * The brand row's shrink contract.
 *
 * Splitting one chip into three made this row wider than it had ever been, and the chip
 * area was `flex-shrink: 0` — fine for one narrow pill, an overflow for three. A
 * no-shrink item in a row that has run out of width does not truncate; it spills out of
 * the brand block and paints over the toolbar beside it.
 *
 * jsdom has no layout, so what is pinned here is the rule that decides the outcome: the
 * path yields fastest, the chips yield, "Change…" never does. `flex-wrap` was tried as
 * an alternative and is worse — flexbox wraps on hypothetical size and shrinks only
 * afterwards, so the chips took a row of their own and "Change…" a third.
 */
describe('the brand row yields the served path before the git chips', () => {
  it('lets the chip area shrink rather than overflow the brand block', async () => {
    await mountChip(REMOTE_GITHUB);
    const area = screen.getByTestId('git-chip-area');

    expect(area.style.flexShrink).not.toBe('0');
    expect(area.style.minWidth).toBe('0');
  });

  it('makes the path yield faster than the chips', async () => {
    await mountChip(REMOTE_GITHUB);
    const area = screen.getByTestId('git-chip-area');
    const row = area.parentElement as HTMLElement;
    const [path] = [...row.children] as HTMLElement[];

    expect(Number(path.style.flexShrink)).toBeGreaterThan(Number(area.style.flexShrink || 1));
  });

  /*
   * The group clips rather than paints outside itself. The count pill cannot shrink, so
   * an over-subscribed row leaves the group's children wider than its box — and without
   * this they render over "Change…" next door: a button drawn under a chip, still at its
   * own coordinates, still clickable, and unreadable.
   */
  it('clips its own chips instead of painting over its neighbour', async () => {
    await mountChip(REMOTE_GITHUB);
    expect(screen.getByTestId('git-chip').style.overflow).toBe('hidden');
  });

  /*
   * The tooltip wrapper is the flex item, not the chip. Left shrinkable around a
   * non-shrinking child it absorbed the whole deficit and let the child overflow it —
   * the count was clipped to "3 o" while the repository chip beside it sat at a
   * comfortable width, never having been asked to give anything up.
   */
  it('does not let the count’s wrapper absorb the row’s deficit', async () => {
    // Needs collaboration configured — `mountChip`'s server reports it off, so there is
    // no count pill there to reason about.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/__vs/git') return jsonRes(REMOTE_GITHUB);
        if (url === '/__vs/git/branches') return ({ ok: false, status: 404, json: async () => ({ error: 'no route' }) } as Response);
        if (url === '/__vs/collab') return jsonRes({ available: true, login: 'x', repo: { owner: 'acme', repo: 'docs' } });
        if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: [] });
        if (url.startsWith('/__vs/comments')) return jsonRes([OPEN_COMMENT]);
        if (url === '/__vs/source/root') return jsonRes({ root: '/repo' });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<MainHeader file="docs/spec.md" />);
    const count = await screen.findByTestId('git-pull-count');
    const wrapper = count.parentElement?.parentElement as HTMLElement;

    expect(count.style.flexShrink).toBe('0');
    expect(wrapper.style.flexShrink).toBe('0');
  });

  /* The row is one line. Wrapping is what produced the three-row header. */
  it('keeps the row on one line', async () => {
    await mountChip(REMOTE_GITHUB);
    const row = screen.getByTestId('git-chip-area').parentElement as HTMLElement;
    expect(row.style.flexWrap === '' || row.style.flexWrap === 'nowrap').toBe(true);
  });
});
