/**
 * use-git-context.ts — the browser's read of `GET /__vs/git` (R-3.10 … R-3.12).
 *
 * THE TYPE IS REDECLARED, NOT IMPORTED. `core/git-context.ts` shells out through
 * `node:child_process`, so it must stay outside the browser bundle's import graph
 * (R-1.3). `import type` would be erased today and would survive exactly until
 * someone deletes the `type` keyword while "fixing" an import — which is not a
 * boundary, it is a convention. The repository already answered this question the
 * same way: `ui/use-tree.ts` redeclares `TreeEntry` and `FileKind` instead of
 * reaching into `tree-store.ts`. `ui/browser-safety.test.ts` names this module's
 * counterpart explicitly and fails if the edge is ever drawn.
 *
 * NOTE the shape of `local`: `url` is *absent*, not `undefined`, when there is no
 * `origin`. That distinction is the whole difference between R-3.4 ("no remote is
 * configured") and R-3.5 ("a remote exists but its URL was not recognised"), so
 * the chip tests `'url' in ctx` semantics via `ctx.url` being truthy and the
 * server is careful to omit the key.
 *
 * REFRESH IS AN EVENT, NOT A TIMER (R-3.11). The real scenario is: the user goes
 * to a terminal, switches branch, and comes back — and coming back *is* the focus
 * event. A timer would only win while someone stares at an untouched tab. This is
 * also the pattern the repository already ships and already tests
 * (`core/app/lib/use-comments.ts:56-57`).
 */
import { useEffect, useState } from 'react';

export type GitContext =
  | { state: 'none' }
  | { state: 'local'; branch: string; detached: boolean; url?: string }
  | {
      state: 'remote';
      branch: string;
      detached: boolean;
      owner: string;
      repo: string;
      host: string;
      url: string;
    };

/**
 * The current git context, or `null` while the first read is still in flight.
 *
 * `null` is a state of its own on purpose (R-3.2): the caller must be able to say
 * "nothing is known yet" rather than defaulting to `{ state: 'none' }`, which
 * would make the chip flash "not a git repo" and then correct itself — precisely
 * the confusion the three states exist to prevent.
 */
export function useGitContext(): GitContext | null {
  const [context, setContext] = useState<GitContext | null>(null);

  useEffect(() => {
    let live = true;

    // R-3.12: a failed read is swallowed. The previous value stays in state, so
    // the chip keeps showing the last thing that was actually true instead of
    // being replaced by an error the user can do nothing about.
    const read = () => {
      fetch('/__vs/git')
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          return res.json() as Promise<GitContext>;
        })
        .then((next) => {
          if (live) setContext(next);
        })
        .catch(() => {});
    };

    read(); // on mount (R-3.10)
    const onRefresh = () => read();
    window.addEventListener('focus', onRefresh);
    document.addEventListener('visibilitychange', onRefresh);
    return () => {
      live = false;
      window.removeEventListener('focus', onRefresh);
      document.removeEventListener('visibilitychange', onRefresh);
    };
  }, []);

  return context;
}

/**
 * The branch to show where a branch is the point — the header chip's branch slot
 * and the apply scope chooser (R-4.1). `null` means "no branch is known", which
 * covers both state `none` and the pre-first-read state (R-4.2); callers render
 * nothing at all in that case rather than a placeholder.
 */
export function branchOf(ctx: GitContext | null): string | null {
  if (!ctx || ctx.state === 'none') return null;
  return ctx.branch;
}
