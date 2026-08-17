// @vitest-environment jsdom
/**
 * use-git-branches.test.tsx — the enablement probe (R-6.1, R-6.2, R-6.3).
 *
 * The listing read *is* the capability probe: R-6.3 leaves the branch routes absent
 * rather than present-and-403, so the only way to learn the flag is to ask for the
 * listing and see whether a route answers. That makes the probe's reading of each
 * status a requirement, not an implementation detail.
 *
 * 404 is the configured answer for "off", and the honest answer from a server older
 * than this client. Nothing else means that. In particular an *enabled* server whose
 * git call fails answers 500 (`core/vite/routes/git.ts`), and a probe that read any
 * `!ok` as "off" would make the switcher silently vanish for the rest of the session
 * — conditioning the control on git's health when R-6.1 conditions it on
 * configuration. So the three statuses are asserted separately, and the middle one is
 * asserted as "unchanged", which is a different claim from "off".
 *
 * `enabled` is three-valued and the hook is where that is visible: `null` (not yet
 * answered) and `false` (answered, off) render identically in the header by design
 * (R-6.2 forbids a control that appears a beat later), so a test that only drove the
 * header could not tell a 500 that left the probe unanswered from a 500 that
 * concluded the capability is absent. Both halves are here: the hook for the
 * distinction, the header for what the user sees.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitBranches } from './use-git-branches';
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

const LISTING = { local: [{ name: 'main', current: true }], remote: [] };

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/** Every route the header touches, with the branch listing's answer parameterised. */
function installFetch(listing: () => Response) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/git') return jsonRes(REMOTE_GITHUB);
    if (url === '/__vs/git/branches') return listing();
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

/** Mount the hook, wait for the probe to have been answered, and settle React. */
async function probe(listing: () => Response) {
  const fetchMock = installFetch(listing);
  const { result } = renderHook(() => useGitBranches());
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/__vs/git/branches')).toBe(true));
  // The response is resolved and every state update it produces has been applied, so
  // an `enabled` still `null` below is a settled answer rather than a race.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return result;
}

describe('the probe reads 404 as "the capability is absent" (R-6.2, R-6.3)', () => {
  it('concludes the routes are off, and holds no listing', async () => {
    const result = await probe(() => jsonRes({ error: 'no route: GET /__vs/git/branches' }, 404));

    expect(result.current.enabled).toBe(false);
    expect(result.current.listing).toBeNull();
  });

  it('renders the branch as text with no control at all', async () => {
    installFetch(() => jsonRes({ error: 'no route' }, 404));
    render(<MainHeader file="docs/spec.md" />);

    const chip = await screen.findByTestId('git-chip');
    await waitFor(() => expect(chip.textContent).toContain('main'));
    // Not a disabled control — no control (the R-6.2 claim `ui/git-chip.test.tsx`
    // makes against a server with the flag off, restated here for the probe's sake).
    expect(screen.queryByTestId('git-branch-switch')).toBeNull();
    expect(chip.querySelector('button')).toBeNull();
  });
});

describe('the probe reads any other failure as "no answer yet" (R-6.1)', () => {
  /*
   * The regression this exists to hold. An enabled server whose git call fails
   * answers 500 with the reason; a probe that treated that as "off" would remove the
   * switcher for a reason the user cannot see and cannot undo without a reload, and
   * would do it on a server where configuration says the capability exists.
   */
  for (const [label, res] of [
    ['500 from an enabled server whose git failed', () => jsonRes({ error: 'git-failed' }, 500)],
    ['503', () => jsonRes({ error: 'unavailable' }, 503)],
    ['400', () => jsonRes({ error: 'bad' }, 400)],
  ] as const) {
    it(`leaves the flag unchanged for a ${label}`, async () => {
      const result = await probe(res);

      // Unchanged, not off: the probe never learned the flag, which is the same thing
      // a read that never reached a route says.
      expect(result.current.enabled).toBeNull();
      expect(result.current.enabled).not.toBe(false);
      expect(result.current.listing).toBeNull();
    });
  }

  it('leaves the flag unchanged for a read that never reached a route', async () => {
    const result = await probe(() => {
      throw new TypeError('Failed to fetch');
    });

    expect(result.current.enabled).toBeNull();
  });

  it('does not change what the header shows either — the failure adds and removes nothing', async () => {
    installFetch(() => jsonRes({ error: 'git-failed' }, 500));
    render(<MainHeader file="docs/spec.md" />);

    const chip = await screen.findByTestId('git-chip');
    await waitFor(() => expect(chip.textContent).toContain('main'));
    // Unit 3's chip, exactly as it was before the probe answered: git's health moved
    // nothing on screen in either direction.
    expect(screen.queryByTestId('git-branch-switch')).toBeNull();
    expect(screen.queryByTestId('git-branch-menu')).toBeNull();
    expect(chip.textContent).toContain('acme/docs');
    // And no error took the chip's place (R-3.12's spirit, applied to the probe).
    expect(chip.textContent).not.toMatch(/git-failed|error|failed/i);
  });
});

describe('the probe reads a listing as "the capability is present" (R-6.1)', () => {
  it('concludes the routes are on and keeps the listing', async () => {
    const result = await probe(() => jsonRes(LISTING));

    expect(result.current.enabled).toBe(true);
    expect(result.current.listing).toEqual(LISTING);
  });

  it('renders the branch as a control', async () => {
    installFetch(() => jsonRes(LISTING));
    render(<MainHeader file="docs/spec.md" />);

    const control = await screen.findByTestId('git-branch-switch');
    expect(control.textContent).toContain('main');
  });
});
