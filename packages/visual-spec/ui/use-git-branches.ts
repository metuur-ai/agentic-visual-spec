/**
 * use-git-branches.ts — the browser's half of `GET /__vs/git/branches` and
 * `POST /__vs/git/checkout` (R-6.1 … R-6.7).
 *
 * THE LISTING READ *IS* THE CAPABILITY PROBE. R-6.3 leaves both routes absent rather
 * than present-and-403 when `git.allowCheckout` is off, so there is nothing to ask
 * about the flag — the only way to learn it is to ask for the listing and see whether
 * a route answers. That is why `enabled` is derived from the read instead of from a
 * config route: a config route would be a second answer to a question the routes
 * already answer, and it could disagree with them.
 *
 * `enabled` IS THREE-VALUED. `null` means the probe has not come back, and the chip
 * must render as Unit 3 shipped it while that is true — not as a control that appears
 * a moment later. R-6.2's "indistinguishable from absent" is a claim about what the
 * user sees, and a control that flickers into existence fails it as surely as a
 * disabled one.
 *
 * THE TYPES ARE REDECLARED, NOT IMPORTED, for the reason `use-git-context.ts` spells
 * out at length: `core/git-branches.ts` reaches `node:child_process` through the same
 * executor seam, and `ui/browser-safety.test.ts` names it explicitly.
 *
 * NO TIMER, AND NO FOCUS REFRESH EITHER. Unlike the context (R-3.10) the listing has
 * no requirement to re-read, and a branch list that is one branch stale costs the user
 * a menu that does not offer a branch they just created. The listing is re-read after
 * a successful change, because that one is guaranteed to have moved.
 */
import { useCallback, useEffect, useState } from 'react';
import { type GitContext, publishGitContext } from './use-git-context';

/** `core/git-branches.ts`'s `LocalBranch`, redeclared. */
export type LocalBranch = {
  name: string;
  current: boolean;
  /** Absent where no upstream exists — a different claim from `0`. */
  ahead?: number;
  behind?: number;
};

export type BranchListing = { local: LocalBranch[]; remote: string[] };

/**
 * What a change attempt resolved to. `dirty` is its own arm rather than a message,
 * because R-6.6 has to render the paths and must not offer a way past them — a
 * failure reduced to a string could do neither.
 */
export type CheckoutOutcome =
  | { ok: true; context: GitContext }
  | { ok: false; kind: 'dirty'; paths: string[] }
  | { ok: false; kind: 'failed'; message: string };

export type GitBranches = {
  /** `null` until the probe answers; `false` where the routes are absent (R-6.3). */
  enabled: boolean | null;
  listing: BranchListing | null;
  checkout: (branch: string) => Promise<CheckoutOutcome>;
};

/** The route answers `{ error, paths? }`; anything else is a transport that broke. */
type CheckoutErrorBody = { error?: string; paths?: string[] };

export function useGitBranches(): GitBranches {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [listing, setListing] = useState<BranchListing | null>(null);

  const read = useCallback(() => {
    fetch('/__vs/git/branches')
      .then(async (res) => {
        // 404 is the configured answer for "off" (R-6.3) and the honest answer for a
        // server older than this client; both mean the same thing to a client that
        // behaves. Nothing else does. Treating any `!ok` as "off" would hide the
        // control whenever git itself failed — a 500 from an enabled server — which
        // contradicts R-6.1, where the control is conditioned on configuration and
        // not on git's health. Any other status leaves `enabled` where it was, the
        // same thing the `catch` below does with a read that never reached a route.
        if (res.status === 404) {
          setEnabled(false);
          return;
        }
        if (!res.ok) return;
        setEnabled(true);
        setListing((await res.json()) as BranchListing);
      })
      // A read that never reached a route says nothing about the flag, so it leaves
      // `enabled` where it was rather than claiming the capability is absent.
      .catch(() => {});
  }, []);

  useEffect(() => {
    read();
  }, [read]);

  const checkout = useCallback(
    async (branch: string): Promise<CheckoutOutcome> => {
      let res: Response;
      try {
        res = await fetch('/__vs/git/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ branch }),
        });
      } catch (err) {
        return { ok: false, kind: 'failed', message: (err as Error).message };
      }
      const body = (await res.json().catch(() => ({}))) as CheckoutErrorBody & { context?: GitContext };

      if (res.ok && body.context) {
        // R-5.9 / R-6.7 — the context the server read *after* the change is adopted as
        // it stands. Composing one from the branch the user picked would be the client
        // inferring the result, and it would be wrong for every checkout git did
        // something other than the obvious thing with.
        publishGitContext(body.context);
        read(); // `current` moved, and the branch that was only on `origin` is now local
        return { ok: true, context: body.context };
      }
      if (res.status === 409 && body.error === 'dirty') {
        return { ok: false, kind: 'dirty', paths: body.paths ?? [] };
      }
      return { ok: false, kind: 'failed', message: body.error ?? `${res.status}` };
    },
    [read],
  );

  return { enabled, listing, checkout };
}
