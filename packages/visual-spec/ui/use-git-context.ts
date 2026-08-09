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
 *
 * THERE IS A THIRD WAY IN, ADDED BY R-6.7: `publishGitContext`. When the branch is
 * changed from the header, the checkout route answers with the context git reported
 * *after* the change (R-5.9), and that answer is authoritative — re-reading
 * `GET /__vs/git` to learn what the server has just told us would be a second, later,
 * possibly different answer to a settled question. It arrives as a window event
 * rather than as a returned setter so this hook keeps one state and one source of
 * truth; the repository already moves cross-component facts this way
 * (`vs:comments-changed`, `vs:source-changed` in `ui/main-header.tsx`).
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

/** Carries a `GitContext` the server has just reported. `detail` is that context. */
const ADOPT_EVENT = 'vs:git-context';

/**
 * Hand every mounted `useGitContext` a context the server just returned (R-6.7).
 *
 * Deliberately not a re-fetch: the caller already holds the server's answer, and
 * asking again would let a change made elsewhere land between the two reads and be
 * displayed as the outcome of *this* one.
 */
export function publishGitContext(next: GitContext): void {
  window.dispatchEvent(new CustomEvent(ADOPT_EVENT, { detail: next }));
}

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
    // R-6.7 — a context the server returned from a change it just made, adopted
    // without a read of its own.
    const onAdopt = (e: Event) => {
      if (live) setContext((e as CustomEvent<GitContext>).detail);
    };
    window.addEventListener('focus', onRefresh);
    document.addEventListener('visibilitychange', onRefresh);
    window.addEventListener(ADOPT_EVENT, onAdopt);
    return () => {
      live = false;
      window.removeEventListener('focus', onRefresh);
      document.removeEventListener('visibilitychange', onRefresh);
      window.removeEventListener(ADOPT_EVENT, onAdopt);
    };
  }, []);

  return context;
}

/**
 * The branch NAME alone, for callers that need nothing else. `null` means "no
 * branch is known", covering both state `none` and the pre-first-read state
 * (R-4.2); callers render nothing at all in that case rather than a placeholder.
 *
 * The two surfaces that show a HEAD — the header chip and the apply scope chooser
 * — deliberately do NOT use this: they read the context itself, because R-3.9 and
 * R-4.3 make `detached` part of what they must say, and a bare string cannot
 * carry it.
 */
export function branchOf(ctx: GitContext | null): string | null {
  if (!ctx || ctx.state === 'none') return null;
  return ctx.branch;
}
