/**
 * use-visited-files.ts — the markdown files opened in the viewer during this session
 * (R-8.37).
 *
 * WHY OPENING A FILE IS ENOUGH TO OFFER IT. A pull request is not always about what git
 * calls a change. An author reviewing three documents together wants all three on the
 * request even when two of them are untouched, and neither the sidecar (they left no
 * note) nor `git status` (they edited nothing) knows about those two. What does know is
 * that they went and looked at them. So a visit is a candidacy — and only a candidacy:
 * a visited file joins a pull request when it is ticked and never because it was seen
 * (R-8.35).
 *
 * IT IS SESSION MEMORY, DELIBERATELY. Nothing is persisted. A reload starts the list
 * empty, because "files I am working on together" is a claim about the sitting the
 * author is in, and a list that accumulated across days would end up being every file
 * in the repository, offered forever.
 *
 * Insertion-ordered rather than sorted: the caller sorts the union it builds, and the
 * order here only has to be stable so a re-render does not reshuffle checkboxes.
 */
import { useCallback, useSyncExternalStore } from 'react';

const EMPTY: readonly string[] = [];

const visited: string[] = [];
const watchers = new Set<() => void>();
let snapshot: readonly string[] = EMPTY;

/** Note that `path` was opened. Idempotent — the second visit changes nothing. */
export function recordVisit(path: string): void {
  if (path === '' || visited.includes(path)) return;
  visited.push(path);
  // A fresh array per change, the same one between changes: `useSyncExternalStore`
  // compares snapshots by identity and loops forever on a getter that allocates.
  snapshot = [...visited];
  for (const watch of watchers) watch();
}

/** Test seam: forget the session's visits. */
export function resetVisitedFiles(): void {
  visited.length = 0;
  snapshot = EMPTY;
  for (const watch of watchers) watch();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

export function useVisitedFiles(): readonly string[] {
  return useSyncExternalStore(
    useCallback(subscribe, []),
    () => snapshot,
    () => EMPTY,
  );
}
