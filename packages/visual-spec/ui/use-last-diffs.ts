/**
 * use-last-diffs.ts — the most recent patch Claude wrote to each file, kept per file
 * rather than per run.
 *
 * WHY NOT `state.diffs`. The apply reducer already collects the run's patches, but it
 * starts every run from `APPLY_INIT`, so the moment a second comment is applied the first
 * one's comparison is gone. That is the right shape for the popover, which reports on the
 * run in front of you, and the wrong shape for the question the sidebar asks — "what did
 * this file say before Claude touched it?" — which outlives the run that answered it.
 *
 * KEYED BY FILE, LAST WRITE WINS. A run that touches A does not erase the entry for B,
 * because the reader is asking about a file, not about a sitting. Two runs against the
 * same file do overwrite: the older patch describes a "before" that no longer exists on
 * disk, and showing it would be the misleading preview this feature was built to kill.
 *
 * SESSION MEMORY, DELIBERATELY — same reasoning as `use-visited-files.ts`. A reload starts
 * empty. Persisting would mean promising a "before" for text the user has since edited by
 * hand, which is a promise this store has no way to keep.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type LastDiff = { path: string; patch: string; truncated?: boolean };

const byPath = new Map<string, LastDiff>();
const watchers = new Set<() => void>();

/**
 * Remember `patch` as the latest comparison for `path`. Idempotent: re-recording an
 * identical patch keeps the existing object, so `useSyncExternalStore` sees a stable
 * snapshot and subscribers do not re-render on a repeated `diff` frame.
 */
export function recordDiff(entry: LastDiff): void {
  if (entry.path === '' || entry.patch === '') return;
  const prev = byPath.get(entry.path);
  if (prev && prev.patch === entry.patch && prev.truncated === entry.truncated) return;
  byPath.set(entry.path, entry);
  for (const watch of watchers) watch();
}

/** Test seam: forget the session's patches. */
export function resetLastDiffs(): void {
  if (byPath.size === 0) return;
  byPath.clear();
  for (const watch of watchers) watch();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/** The latest patch for `path`, or `undefined` if Claude has not written to it here. */
export function useLastDiff(path: string): LastDiff | undefined {
  return useSyncExternalStore(
    useCallback(subscribe, []),
    () => byPath.get(path),
    () => undefined,
  );
}
