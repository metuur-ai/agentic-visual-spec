/**
 * use-changed-files.ts — the working tree's uncommitted paths, read from
 * `GET /__vs/git/changed` (R-8.36).
 *
 * WHY IT READS ONLY WHILE `active`. The one caller is the "Start collaboration" popover,
 * and the answer is only ever looked at while that popover is open. Reading on every
 * header mount would spawn a `git status` per file the user clicks in the tree, to
 * populate a list nobody is looking at.
 *
 * WHY IT RE-READS. The defect this exists for is "I edited a file and it was not in the
 * list": a `git status` taken when the app booted is wrong the moment anyone saves. So
 * the read happens when the popover opens — which is the moment that matters, because
 * the list is about to be shown — and again on `vs:source-changed` (the editor just
 * wrote to disk) and on focus, for the edits made in a real editor outside this tab.
 *
 * A failed read is an empty list, not an error on screen. The picker degrades to the
 * candidates it had before this existed (the commented files), and the author can still
 * start the pull request — a repository with no git, or a `git` that could not be run,
 * is not a reason to block a collaboration.
 */
import { useEffect, useState } from 'react';

const EMPTY: string[] = [];

export function useChangedFiles(active: boolean): string[] {
  const [paths, setPaths] = useState<string[]>(EMPTY);

  useEffect(() => {
    if (!active) return;
    let live = true;

    const read = () => {
      void fetch('/__vs/git/changed')
        .then((res) => (res.ok ? (res.json() as Promise<{ paths?: unknown }>) : { paths: EMPTY }))
        .catch(() => ({ paths: EMPTY }))
        .then((body) => {
          if (!live) return;
          const next = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : EMPTY;
          // Same paths, same array identity — a re-read that found nothing new must not
          // re-render the list the author is currently ticking boxes in.
          setPaths((prev) => (prev.length === next.length && prev.every((p, i) => p === next[i]) ? prev : next));
        });
    };

    read();
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') read();
    };
    window.addEventListener('vs:source-changed', read);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      live = false;
      window.removeEventListener('vs:source-changed', read);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [active]);

  return paths;
}
