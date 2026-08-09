// @vitest-environment jsdom
/**
 * git-branch-switch.test.tsx — changing branch from the chip (R-6.1, R-6.4 … R-6.7).
 *
 * The *disabled* half of R-6.2 is deliberately not here. It lives in
 * `ui/git-chip.test.tsx`, which runs Unit 3's own assertions against a server with the
 * flag off — "renders exactly as Unit 3 specifies" is a claim about Unit 3's
 * assertions, and re-stating them here would let the two copies drift apart while both
 * stayed green.
 *
 * Everything below drives `MainHeader`, for the reason the Unit 3 suite gives: these
 * are claims about a control the header has to actually render.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainHeader } from './main-header';

const REMOTE_GITHUB = {
  state: 'remote',
  branch: 'main',
  detached: false,
  owner: 'acme',
  repo: 'docs',
  host: 'github.com',
  url: 'git@github.com:acme/docs.git',
};

const LISTING = {
  local: [
    { name: 'main', current: true, ahead: 0, behind: 0 },
    { name: 'feature/x', current: false, ahead: 2, behind: 1 },
    { name: 'wip', current: false },
  ],
  // `release/2` is only on `origin`; `main` is on both and must not be listed twice.
  remote: ['main', 'release/2'],
};

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

type Server = {
  git?: unknown;
  /** `null` stands for a server with the flag off — the routes are absent (R-6.3). */
  listing?: unknown | null;
  checkout?: () => Response;
};

function installFetch(server: Server) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/git') return jsonRes(server.git ?? REMOTE_GITHUB);
    if (url === '/__vs/git/branches') {
      return server.listing === null ? jsonRes({ error: 'no route' }, 404) : jsonRes(server.listing ?? LISTING);
    }
    if (url === '/__vs/git/checkout') return (server.checkout ?? (() => jsonRes({ context: REMOTE_GITHUB })))();
    if (url === '/__vs/collab') {
      return jsonRes({ available: false, reason: 'not-configured', message: 'off', missingScopes: [] });
    }
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mounts the header and returns the switcher once the probe has answered. */
async function mountSwitcher(server: Server = {}): Promise<HTMLElement> {
  installFetch(server);
  render(<MainHeader file="docs/spec.md" />);
  return await screen.findByTestId('git-branch-switch');
}

const chipArea = () => screen.getByTestId('git-chip-area');

describe('the branch is a control where configuration enables one (R-6.1)', () => {
  it('opens the list of branches the server reported', async () => {
    const switcher = await mountSwitcher();
    expect(switcher.textContent).toContain('main');

    fireEvent.click(switcher);
    const menu = await screen.findByTestId('git-branch-menu');

    // Every local branch, plus the branch that exists only on `origin`.
    for (const name of ['main', 'feature/x', 'wip', 'release/2']) {
      expect(within(menu).getByTestId(`git-branch-${name}`)).toBeTruthy();
    }
    // `main` is on both and appears once — a second row for `origin/main` would offer
    // a "change" to the branch already checked out.
    expect(within(menu).getAllByTestId('git-branch-main')).toHaveLength(1);
    expect((within(menu).getByTestId('git-branch-main') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says a branch has no upstream rather than reporting it level with one', async () => {
    fireEvent.click(await mountSwitcher());
    const menu = await screen.findByTestId('git-branch-menu');
    // R-5.2's distinction, carried to the display: absent counts are not zero.
    expect(within(menu).getByTestId('git-branch-wip').textContent).toContain('no upstream');
    expect(within(menu).getByTestId('git-branch-feature/x').textContent).toContain('↑2');
    expect(within(menu).getByTestId('git-branch-feature/x').textContent).toContain('↓1');
  });
});

/*
 * R-6.4 — a detached HEAD's "branch" is a commit. R-3.9 already forbids presenting it
 * as a branch name; here it must also not be presented as somewhere to go back to,
 * because it is not a branch git would accept.
 */
describe('a detached HEAD (R-6.4)', () => {
  const DETACHED = { ...REMOTE_GITHUB, branch: 'a1b2c3d', detached: true };

  it('still says the sha is a detached HEAD, and never offers it as a branch', async () => {
    const switcher = await mountSwitcher({ git: DETACHED, listing: { local: [], remote: ['release/2'] } });
    expect(switcher.textContent).toContain('a1b2c3d');
    expect(switcher.textContent).toContain('detached HEAD');

    fireEvent.click(switcher);
    const menu = await screen.findByTestId('git-branch-menu');
    expect(within(menu).queryByTestId('git-branch-a1b2c3d')).toBeNull();
    expect(menu.textContent).not.toContain('a1b2c3d');
    // The branches that do exist are still reachable — a detached HEAD is the state
    // you most want to leave.
    expect(within(menu).getByTestId('git-branch-release/2')).toBeTruthy();
  });
});

describe('a refusal for uncommitted work (R-6.6)', () => {
  const DIRTY = () => jsonRes({ error: 'dirty', paths: ['docs/spec.md', 'notes/my notes.md'] }, 409);

  it('lists the paths the server reported', async () => {
    fireEvent.click(await mountSwitcher({ checkout: DIRTY }));
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    const refusal = await screen.findByTestId('git-branch-refusal');
    expect(refusal.textContent).toContain('docs/spec.md');
    expect(refusal.textContent).toContain('notes/my notes.md');
  });

  /*
   * The load-bearing assertion. The server refuses on any dirt because `git checkout`
   * silently carries an identical file onto the new branch, so a control here offering
   * to get past the refusal would hand back exactly the outcome the refusal exists to
   * prevent — and would do it with the user's consent to something they were not told.
   */
  it('offers nothing anywhere in the chip that would get past it', async () => {
    fireEvent.click(await mountSwitcher({ checkout: DIRTY }));
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));
    await screen.findByTestId('git-branch-refusal');

    const text = chipArea().textContent ?? '';
    expect(text).not.toMatch(/discard|stash|force|overwrite|anyway/i);
    for (const control of chipArea().querySelectorAll('button')) {
      expect(control.textContent ?? '').not.toMatch(/discard|stash|force|overwrite|anyway/i);
    }
  });

  it('leaves the branch where it was', async () => {
    fireEvent.click(await mountSwitcher({ checkout: DIRTY }));
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));
    await screen.findByTestId('git-branch-refusal');

    expect(screen.getByTestId('git-branch-switch').textContent).toContain('main');
  });
});

describe('a successful change (R-6.7)', () => {
  /*
   * The requirement is that the chip shows what the *server* read after the change,
   * not the name that was clicked. The two are made to disagree on purpose: git
   * resolves `release/2` into a tracking branch and the server reads the result back
   * (R-5.9), so a client composing its own answer would be wrong here — and would be
   * wrong invisibly, since the name it invented is the one the user just picked.
   */
  const AFTER = { ...REMOTE_GITHUB, branch: 'release/2' };

  it('displays the context the server returned, not the branch that was picked', async () => {
    const fetchMock = installFetch({ checkout: () => jsonRes({ context: AFTER }) });
    render(<MainHeader file="docs/spec.md" />);

    fireEvent.click(await screen.findByTestId('git-branch-switch'));
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    await waitFor(() => expect(screen.getByTestId('git-branch-switch').textContent).toContain('release/2'));
    // And it did not go back to `GET /__vs/git` to find that out: the answer was in
    // the response, and a second read could have caught a different change.
    const contextReads = fetchMock.mock.calls.filter(([u]) => String(u) === '/__vs/git');
    expect(contextReads).toHaveLength(1);
  });

  it('sends the branch that was picked, and closes the list', async () => {
    const fetchMock = installFetch({ checkout: () => jsonRes({ context: AFTER }) });
    render(<MainHeader file="docs/spec.md" />);

    fireEvent.click(await screen.findByTestId('git-branch-switch'));
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    await waitFor(() => expect(screen.queryByTestId('git-branch-menu')).toBeNull());
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/__vs/git/checkout') as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ branch: 'feature/x' });
  });
});

/*
 * R-6.5 at the seam. The dialog itself belongs to `ui/App.tsx` and is driven end to
 * end in `ui/branch-switch-app.test.tsx`; what this asserts is the half the header
 * owns — that it asks, and that nothing reaches git until the answer comes back.
 */
describe('the shell gets to interpose before the request (R-6.5)', () => {
  it('issues nothing while the confirmation is unresolved, and everything once it is', async () => {
    const fetchMock = installFetch({});
    let proceed: (() => void) | null = null;
    render(<MainHeader file="docs/spec.md" actions={{ confirmUnsaved: (run) => { proceed = run; } }} />);

    fireEvent.click(await screen.findByTestId('git-branch-switch'));
    fireEvent.click(await screen.findByTestId('git-branch-feature/x'));

    expect(proceed).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/__vs/git/checkout')).toEqual([]);

    (proceed as unknown as () => void)();
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/__vs/git/checkout')).toHaveLength(1),
    );
  });
});
