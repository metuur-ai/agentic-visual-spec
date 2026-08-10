/**
 * use-collab-pulls.ts — the open pull requests behind the header chip's count
 * (R-7.1 … R-7.3, R-7.10, R-7.11).
 *
 * AVAILABILITY IS READ FIRST, AND THAT IS THE POINT. R-7.2 forbids *requesting* the
 * count where collaboration is not configured, not merely displaying it — asking a
 * repository that was never named, on every mount and every focus, is a rate limit
 * spent on an answer nobody can use. `GET /__vs/collab` is the snapshot the rest of
 * the collaboration UI already gates on, and an unconfigured server answers it
 * without touching GitHub at all.
 *
 * THE COUNT IS UNFILTERED (R-7.3). Every open pull request, so the number agrees with
 * the one github.com shows on the same repository. Which of them carry a collaboration
 * document is a distinction the *list* draws (R-7.6), never the count — a count that
 * silently omitted the others would disagree with GitHub and be read as a bug in this
 * tool rather than as the filter it was.
 *
 * THE REFRESH EVENTS ARE R-3.10's, DELIBERATELY THE SAME ONES. The scenario is
 * identical — the user leaves for github.com or a terminal and comes back — and R-7.10
 * restates the no-timer rule rather than inheriting it because here it is also a rate
 * limit: a poll against a repository is a poll against somebody's API quota.
 *
 * R-7.11: a failed read leaves the last known count on screen. It reuses this file's
 * one piece of state by simply not writing to it, which is why there is no error field
 * — nothing renders one, and a field nothing renders is a field somebody will render.
 *
 * THE READ IS COALESCED (R-A4.2). `focus` and `visibilitychange` both fire on a single
 * tab switch, so the two listeners below have always cost two listings — a read still in
 * flight now swallows the second event. That is de-duplication and not a timer, so
 * R-7.10 stands.
 *
 * WHAT IS *WAITING* ON THE USER IS NOT HERE. `GET /pulls/awaiting` is read by
 * `use-awaiting-pulls.ts`, because its two readers — the header chips and the panel's
 * sections — sit in different trees with no common ancestor short of `App`. A copy per
 * caller is what that module exists to avoid; see its header.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CollabAvailabilitySnapshot, type PullRequestSummary, createCollabClient } from './collab-client';

/** The configured repository, as `GET /__vs/collab` reports it. */
export type ConfiguredRepo = { owner: string; repo: string };

export type CollabPulls = {
  /**
   * `null` until availability answers, `false` where collaboration is off (R-7.2).
   * Three-valued for the reason `useGitBranches`'s `enabled` is: a count that appears
   * a beat after the chip has settled reads as the chip correcting itself.
   */
  configured: boolean | null;
  /** The repository the count belongs to — what R-8.1 names when it is not `origin`. */
  repo: ConfiguredRepo | null;
  /** Every open pull request. `null` until the first read lands. */
  pulls: PullRequestSummary[] | null;
  /**
   * R-7.7 — attach to a collaboration through the route that already does it,
   * `POST /__vs/collab/open`. `documentId` is the one the server resolved from the
   * pull request body (R-7.4); this file neither parses a body nor could (R-7.5).
   */
  resume: (documentId: string, pullNumber: number) => Promise<boolean>;
};

export function useCollabPulls(fetchImpl?: typeof fetch): CollabPulls {
  const client = useMemo(() => createCollabClient(fetchImpl), [fetchImpl]);
  const [availability, setAvailability] = useState<CollabAvailabilitySnapshot | null>(null);
  const [pulls, setPulls] = useState<PullRequestSummary[] | null>(null);
  /**
   * R-A4.2's whole implementation. A ref and not state: the second event has to be
   * refused *within the same tick* the first was accepted in, and a state write would
   * not be visible until the next render.
   */
  const reading = useRef(false);

  useEffect(() => {
    let live = true;
    void client.availability().then((res) => {
      if (live && res.ok) setAvailability(res.value);
    });
    return () => {
      live = false;
    };
  }, [client]);

  const configured = availability === null ? null : availability.available;

  useEffect(() => {
    if (configured !== true) return; // R-7.2 — nothing is requested
    let live = true;

    const read = () => {
      if (reading.current) return; // R-A4.2 — one tab switch, one read
      reading.current = true;

      // `finally` and not `then`: the flag has to be cleared even if this rejects for a
      // reason the client did not turn into a result, or one throw would wedge the hook
      // into never reading again.
      void client
        .pullRequests('open')
        .then((res) => {
          // R-7.11 — a failure writes nothing, so the previous count survives it.
          if (live && res.ok) setPulls(res.value);
        })
        .finally(() => {
          reading.current = false;
        });
    };

    read(); // on mount (R-7.10)
    const onRefresh = () => read();
    window.addEventListener('focus', onRefresh);
    document.addEventListener('visibilitychange', onRefresh);
    return () => {
      live = false;
      window.removeEventListener('focus', onRefresh);
      document.removeEventListener('visibilitychange', onRefresh);
    };
  }, [client, configured]);

  const resume = useCallback(
    async (documentId: string, pullNumber: number): Promise<boolean> => {
      const res = await client.open({ documentId, pullNumber });
      return res.ok;
    },
    [client],
  );

  const repo = availability?.available ? { owner: availability.repo.owner, repo: availability.repo.repo } : null;

  return { configured, repo, pulls, resume };
}
