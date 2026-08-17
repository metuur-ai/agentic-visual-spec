// @vitest-environment jsdom
/**
 * use-collab-pulls.test.tsx — one tab switch, one listing (R-A4.2 applied to R-7.10).
 *
 * The hook has registered `focus` **and** `visibilitychange` since Unit 7, and a browser
 * fires both on a single tab switch — so a switch has always cost two listings, against
 * the same core limit publish and sync spend. The amendment adds a second read cycle to
 * the same moment, which is what made the pre-existing double worth fixing rather than
 * tolerating. The assertion is therefore *exactly one*, not "at least one".
 *
 * What is *waiting* on the user is not read here; it lives in `use-awaiting-pulls.ts` and
 * is tested beside it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCollabPulls } from './use-collab-pulls';

const CONFIGURED = { available: true, login: 'ana', repo: { owner: 'acme', repo: 'docs', baseBranch: 'main' }, scopes: [] };

const PULLS = [
  { number: 41, title: 'Spec: retention', state: 'open', draft: false, headBranch: 'vs/doc-a', baseBranch: 'main', headSha: 'aaaaaaa1', htmlUrl: 'https://github.com/acme/docs/pull/41', author: 'bo', updatedAt: '2026-08-01T00:00:00.000Z' },
];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch(availability: unknown = CONFIGURED) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/__vs/collab') return jsonRes(availability);
    if (url.startsWith('/__vs/collab/pulls')) return jsonRes({ pulls: PULLS });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const listingReads = (impl: ReturnType<typeof installFetch>) =>
  impl.mock.calls.filter(([u]) => String(u) === '/__vs/collab/pulls?state=open').length;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mount the hook and wait for the first cycle — availability, then the listing. */
async function mounted(availability: unknown = CONFIGURED) {
  const impl = installFetch(availability);
  const { result } = renderHook(() => useCollabPulls());
  await waitFor(() => expect(result.current.configured).not.toBeNull());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { impl, result };
}

describe('when the listing is read (R-7.10 / R-A4.2)', () => {
  it('reads on mount', async () => {
    const { impl, result } = await mounted();

    expect(listingReads(impl)).toBe(1);
    expect(result.current.pulls).toEqual(PULLS);
  });

  it('costs one read per tab switch, though the switch fires two events', async () => {
    const { impl } = await mounted();

    // One tab switch, as the browser delivers it: both events, same tick, nothing awaited
    // between them. The second finds a read in flight and is swallowed.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(listingReads(impl)).toBe(2));
    expect(listingReads(impl)).toBe(2);
  });

  it('reads again on the next switch, once the first has landed', async () => {
    const { impl } = await mounted();

    for (const dispatch of [() => window.dispatchEvent(new Event('focus')), () => document.dispatchEvent(new Event('visibilitychange'))]) {
      await act(async () => {
        dispatch();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    // Coalescing collapses *overlapping* reads, not consecutive ones: a guard that never
    // cleared would look identical in the test above and leave the count frozen forever.
    await waitFor(() => expect(listingReads(impl)).toBe(3));
  });

  it('reads on no timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { impl } = await mounted();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(listingReads(impl)).toBe(1);
  });

  it('reads nothing where collaboration is not configured (R-7.2)', async () => {
    const { impl, result } = await mounted({ available: false, reason: 'not-configured', message: 'off' });

    expect(listingReads(impl)).toBe(0);
    expect(result.current.pulls).toBeNull();
  });
});
