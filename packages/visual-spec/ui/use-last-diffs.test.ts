// @vitest-environment jsdom
/**
 * use-last-diffs.test.ts — the retention rule, which is the whole point of this store.
 *
 * The apply reducer already had a per-run list of patches and it was not enough: it
 * resets on the next run, so applying a second comment erased the first one's comparison.
 * What is pinned here is the difference — a patch survives a later run against a
 * *different* file, and is replaced by a later run against the same one.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordDiff, resetLastDiffs, useLastDiff } from './use-last-diffs';

beforeEach(() => {
  resetLastDiffs();
});

describe('retention is per file, not per run', () => {
  it('keeps a file’s patch when a later run touches a different file', () => {
    const a = renderHook(() => useLastDiff('a.md'));
    act(() => {
      recordDiff({ path: 'a.md', patch: '@@ -1 +1 @@\n-one\n+two\n' });
      recordDiff({ path: 'b.md', patch: '@@ -1 +1 @@\n-three\n+four\n' });
    });

    // The run that wrote b.md did not take a.md's "before" with it.
    expect(a.result.current?.patch).toContain('+two');
    expect(renderHook(() => useLastDiff('b.md')).result.current?.patch).toContain('+four');
  });

  it('replaces a file’s patch when a later run touches it again', () => {
    const { result } = renderHook(() => useLastDiff('a.md'));
    act(() => {
      recordDiff({ path: 'a.md', patch: 'first' });
    });
    act(() => {
      recordDiff({ path: 'a.md', patch: 'second' });
    });

    // The older "before" describes text no longer on disk; showing it would be the
    // misleading preview this feature exists to remove.
    expect(result.current?.patch).toBe('second');
  });

  it('holds the same object for a repeated patch, so a replayed frame is not a change', () => {
    const { result } = renderHook(() => useLastDiff('a.md'));
    act(() => {
      recordDiff({ path: 'a.md', patch: 'same' });
    });
    const first = result.current;

    act(() => {
      recordDiff({ path: 'a.md', patch: 'same' });
    });
    // Identity, not equality: `useSyncExternalStore` compares snapshots by reference and
    // would loop on a getter that allocated a fresh object per read.
    expect(result.current).toBe(first);
  });

  it('reports nothing for a file Claude has not written to', () => {
    const { result } = renderHook(() => useLastDiff('untouched.md'));
    expect(result.current).toBeUndefined();
  });

  it('refuses an empty path or an empty patch', () => {
    const { result } = renderHook(() => useLastDiff('a.md'));
    act(() => {
      recordDiff({ path: '', patch: 'x' });
      recordDiff({ path: 'a.md', patch: '' });
    });
    expect(result.current).toBeUndefined();
  });
});
