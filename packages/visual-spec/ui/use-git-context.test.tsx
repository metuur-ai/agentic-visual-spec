// @vitest-environment jsdom
/**
 * use-git-context.test.tsx — the refresh contract (R-3.10 … R-3.12).
 *
 * The load-bearing assertion here is a NEGATIVE one: no timer. R-3.11 forbids
 * polling outright, and a stray `setInterval` is invisible in any test that only
 * counts fetches after events — it looks identical to a correct implementation
 * until the tab sits idle. So the timer test advances fake timers by five minutes
 * and asserts the fetch count has not moved.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchOf, useGitContext } from './use-git-context';

const REMOTE = {
  state: 'remote',
  branch: 'main',
  detached: false,
  owner: 'acme',
  repo: 'docs',
  host: 'github.com',
  url: 'https://github.com/acme/docs.git',
} as const;

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** A fetch stub that answers `/__vs/git` and throws on anything else. */
function installFetch(bodies: unknown[] | (() => Promise<Response>)) {
  const queue = Array.isArray(bodies) ? [...bodies] : null;
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== '/__vs/git') throw new Error(`unexpected fetch: ${url}`);
    if (!queue) return (bodies as () => Promise<Response>)();
    return jsonRes(queue.length > 1 ? queue.shift() : queue[0]);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useGitContext — when it reads (R-3.10)', () => {
  it('reads once on mount and asserts nothing before the answer arrives (R-3.2)', async () => {
    const fetchMock = installFetch([REMOTE]);
    const { result } = renderHook(() => useGitContext());

    // The very first render, before any promise settles.
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).toEqual(REMOTE));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/__vs/git');
  });

  it('reads again on window focus and on document visibilitychange', async () => {
    const fetchMock = installFetch([REMOTE]);
    renderHook(() => useGitContext());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Each event is its own read, not a debounced pair.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('picks up a branch change on the next focus', async () => {
    const fetchMock = installFetch([REMOTE, { ...REMOTE, branch: 'feature/x' }]);
    const { result } = renderHook(() => useGitContext());
    await waitFor(() => expect(result.current).toEqual(REMOTE));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect((result.current as { branch: string }).branch).toBe('feature/x'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops listening once unmounted', async () => {
    const fetchMock = installFetch([REMOTE]);
    const { unmount } = renderHook(() => useGitContext());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useGitContext — no timer (R-3.11)', () => {
  it('issues no further read while time passes and nothing happens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = installFetch([REMOTE]);
    const { result } = renderHook(() => useGitContext());
    await waitFor(() => expect(result.current).toEqual(REMOTE));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Five minutes of an untouched tab: every polling interval anyone would
    // plausibly have written has fired many times over by now.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useGitContext — a failed read keeps the last known state (R-3.12)', () => {
  it('retains the previous context when a refresh rejects', async () => {
    let attempt = 0;
    const impl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return jsonRes(REMOTE);
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', impl);

    const { result } = renderHook(() => useGitContext());
    await waitFor(() => expect(result.current).toEqual(REMOTE));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(2));
    expect(result.current).toEqual(REMOTE); // not null, not an error state
  });

  it('retains the previous context when a refresh answers non-OK', async () => {
    let attempt = 0;
    const impl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return jsonRes(REMOTE);
      return { ok: false, status: 404, json: async () => ({ error: 'no route' }) } as Response;
    });
    vi.stubGlobal('fetch', impl);

    const { result } = renderHook(() => useGitContext());
    await waitFor(() => expect(result.current).toEqual(REMOTE));

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(2));
    expect(result.current).toEqual(REMOTE);
  });

  it('stays null when the very first read fails — it invents no state', async () => {
    const impl = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', impl);

    const { result } = renderHook(() => useGitContext());
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });
});

describe('branchOf', () => {
  it('is null where no branch is known (R-4.2)', () => {
    expect(branchOf(null)).toBeNull();
    expect(branchOf({ state: 'none' })).toBeNull();
  });

  it('is the branch for both repository states', () => {
    expect(branchOf(REMOTE)).toBe('main');
    expect(branchOf({ state: 'local', branch: 'wip', detached: false })).toBe('wip');
  });
});
