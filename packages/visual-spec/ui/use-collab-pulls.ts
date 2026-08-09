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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
      void client.pullRequests('open').then((res) => {
        // R-7.11 — a failure writes nothing, so the previous count survives it.
        if (live && res.ok) setPulls(res.value);
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
