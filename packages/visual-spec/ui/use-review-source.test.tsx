// @vitest-environment jsdom
/**
 * use-review-source.test.tsx — a 200 that is not the agreed shape is a read that failed.
 *
 * WHY THIS IS WORTH A TEST OF ITS OWN. `CollabClient.call` casts the parsed body to the
 * route's type without looking at it, so "the request succeeded" and "the body is what
 * the route promised" are not the same fact. A proxy interstitial, a dev-server HTML
 * fallback, or a route that changes shape all arrive at this module as `res.ok` with
 * nothing to read. Before the guard, mapping that body threw a TypeError inside a React
 * state updater, and with no error boundary above the reviewing surface the reviewer got
 * a blank page — no folder, no file, no cause, nothing to retry.
 *
 * That is the exact outcome R-11.4 and R-W2.7's failure taxonomy exist to prevent: a read
 * that cannot be completed must say which kind of failure it was, in words. So the
 * assertion here is not "it does not throw" — it is that a malformed body comes out of
 * the module's *existing* error path, the same one a 404 or a missing credential uses.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CollabClient } from './collab-client';
import type { TreeEntry } from './use-tree';
import { useReviewFile, useReviewTree } from './use-review-source';

/**
 * A client whose routes answer 200 with whatever body the test hands it.
 *
 * Built once per test and never inside the render callback: `load` is memoised on the
 * client, so a fresh client on every render would re-run the mount effect forever.
 */
function clientAnswering(body: unknown): CollabClient {
  return {
    pullRequestTree: vi.fn(async () => ({ ok: true, value: body })),
    pullRequestFile: vi.fn(async () => ({ ok: true, value: body })),
  } as unknown as CollabClient;
}

const FILE: TreeEntry = { path: 'src/pay.ts', name: 'pay.ts', type: 'file', kind: 'code' };

describe('R-11.4 / R-W2.7 — a listing that is not a listing is reported, not rendered', () => {
  // The shape the route promises, minus the one field the tree reads. This is what a
  // route rename or a fixture that drifted actually looks like from here.
  it('says the folder could not be read when the body carries no entries', async () => {
    const client = clientAnswering({ pullNumber: 42, headSha: 'abc', path: '' });
    const { result } = renderHook(() => useReviewTree(client, 42));

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toMatch(/could not be read/i);
    // And the surface is still standing: an empty tree that says why, not a crash.
    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  // What an interstitial or an HTML fallback that happens to parse as JSON looks like:
  // not an object at all, so even reaching for `.entries` is on thin ice.
  it('says the folder could not be read when the body is not an object', async () => {
    const client = clientAnswering('<!doctype html>');
    const { result } = renderHook(() => useReviewTree(client, 42));

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toMatch(/could not be read/i);
  });

  /*
   * The forgetting matters as much as the sentence. Every other failed listing deletes the
   * path from `asked` so that closing the folder and opening it again is a retry; a
   * malformed body must not be the one failure that leaves a branch permanently dead.
   */
  it('lets the reviewer ask for the same folder again', async () => {
    const client = clientAnswering({ pullNumber: 42, headSha: 'abc', path: '' });
    const { result } = renderHook(() => useReviewTree(client, 42));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    await act(async () => result.current.expand(''));
    expect(vi.mocked(client.pullRequestTree)).toHaveBeenCalledTimes(2);
  });
});

describe('R-11.4 / R-W2.7 — a file body with no text is a read that failed', () => {
  it('says the file could not be read rather than opening an empty viewer', async () => {
    const client = clientAnswering({ pullNumber: 42, headSha: 'abc', path: FILE.path });
    const { result } = renderHook(() => useReviewFile(client, 42, FILE));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/could not be read/i);
    // Not `undefined` dressed as a string and handed to the code viewer.
    expect(result.current.text).toBeNull();
  });
});
