/**
 * collab-pulls-panel.tsx — choosing a Pull Request to read (R-13.1, R-13.2, R-13.3).
 *
 * `CollabOpenPanel` next door is the *document* entry: it wants a PR reference the
 * reviewer already has and a document id printed in the PR body. This one answers the
 * question that comes before it — "what is there to review?" — by listing the
 * repository's Pull Requests and mounting the one that is picked.
 *
 * LISTING IS A READ (R-13.2). The route gates on `read`, so a credential with no write
 * access lists exactly what an author's does. Nothing here checks `canPublish` before
 * offering a row, because nothing here writes to GitHub: mounting puts a detached
 * checkout in the user's own working directory and stops.
 *
 * THE FOUR MOUNT FAILURES STAY FOUR (R-13.9). "not a git repository", "no origin
 * remote", "the ref could not be fetched" and "git refused the checkout" are four
 * different things for the reviewer to go and do. The server writes one sentence for
 * each and this renders it verbatim, the same rule `CollabOpenPanel` follows for
 * R-11.4 — a shared "could not mount" would be the only wrong answer available.
 *
 * IT NEVER TALKS TO GITHUB. Both calls go to `/__vs/collab/pulls*`; there is no token
 * in the browser to have.
 *
 * IT IS THE LANDING PAGE NOW, NOT THE THIRD SECTION OF IT. `CollabOpenPanel` used to lead
 * the surface with a form asking for a pull request URL *and* a document id typed by
 * hand — while this list, underneath it, already held both for every open pull request.
 * Since the server resolves `documentId` from the pull request body (R-7.4) it arrives on
 * `PullRequestSummary`, so a row that has one offers to resume writing it (R-7.7, through
 * `POST /__vs/collab/open`, the route the header chip already uses) as well as to read the
 * code. A row that has none offers only the read, AND SAYS SO: the listing is every open
 * pull request (R-7.3), so a row with fewer buttons than the one above it has to explain
 * itself or it reads as broken.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type MountedWorktree,
  type PullRequestListState,
  type PullRequestSummary,
  createCollabClient,
} from './collab-client';

export type CollabPullsPanelProps = {
  /**
   * Called once a Pull Request is checked out and ready to read. Both halves are
   * handed over: the summary is what the header names, the worktree is where the files
   * are — and it is git's own path (R-13.8), never one recomputed here.
   */
  onReview: (pull: PullRequestSummary, worktree: MountedWorktree) => void;
  /**
   * R-7.7 — called with the document id once `POST /__vs/collab/open` has accepted, for a
   * row whose pull request carries one. The id is the server's (R-7.4/R-7.5); nothing here
   * parses a pull request body, and nothing here could — the body is not in this process.
   */
  onResume?: (documentId: string) => void;
  /**
   * R-7.8 — a pull request the caller has already chosen, checked out as soon as the
   * listing confirms it is there. Exactly one attempt: a mount that failed leaves its
   * error on screen and the button beside it, which is where a retry belongs. Repeating
   * it on every render would be a loop against git and against GitHub.
   */
  autoReview?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** A commit is named the way git names it in prose: the first seven characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

type Status = { kind: 'idle' } | { kind: 'busy'; pullNumber: number } | { kind: 'error'; message: string };

export function CollabPullsPanel({ onReview, onResume, autoReview, fetchImpl }: CollabPullsPanelProps) {
  const client = useMemo(() => createCollabClient(fetchImpl), [fetchImpl]);
  const [state, setState] = useState<PullRequestListState>('open');
  const [pulls, setPulls] = useState<PullRequestSummary[] | null>(null);
  const [mounted, setMounted] = useState<MountedWorktree[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    let live = true;
    setPulls(null);
    void client.pullRequests(state).then((res) => {
      if (!live) return;
      // R-11.4's rule, applied to this family: the route's own sentence, or `fetch`'s
      // when the route was never reached. Nothing is rewritten into "could not list".
      if (res.ok) setPulls(res.value);
      else {
        setPulls([]);
        setStatus({ kind: 'error', message: res.message });
      }
    });
    return () => {
      live = false;
    };
  }, [client, state]);

  const refreshMounted = useCallback(async () => {
    const res = await client.mountedPullRequests();
    // A failure here is not worth a banner: it costs the "already checked out" hint and
    // nothing else, and the mount button below still works. The list stays as it was.
    if (res.ok) setMounted(res.value);
  }, [client]);

  useEffect(() => {
    void refreshMounted();
  }, [refreshMounted]);

  const mountedFor = (pullNumber: number): MountedWorktree | undefined =>
    mounted.find((w) => w.pullNumber === pullNumber);

  /**
   * R-13.3 / R-13.7 — mount, then read. Re-mounting an already-checked-out PR is the
   * supported way to move it to a head that has since changed (R-13.12), so the button
   * is offered on a mounted row too; git moves the existing checkout rather than
   * recreating it, and the path the reviewer had stays valid.
   */
  const mount = useCallback(
    async (pull: PullRequestSummary) => {
      setStatus({ kind: 'busy', pullNumber: pull.number });
      const res = await client.mountPullRequest(pull.number);
      if (!res.ok) {
        setStatus({ kind: 'error', message: res.message });
        return;
      }
      setStatus({ kind: 'idle' });
      await refreshMounted();
      onReview(pull, res.value.worktree);
    },
    [client, onReview, refreshMounted],
  );

  const autoReviewed = useRef(false);
  useEffect(() => {
    if (autoReview === undefined || autoReviewed.current || pulls === null) return;
    const pull = pulls.find((p) => p.number === autoReview);
    if (!pull) return;
    autoReviewed.current = true;
    void mount(pull);
  }, [autoReview, pulls, mount]);

  /**
   * R-7.7 — attach to the collaboration this pull request already carries. Same route,
   * same precedence on failure as everything else here: the server's own sentence, never
   * a rewritten one (R-11.4).
   */
  const resume = useCallback(
    async (pull: PullRequestSummary) => {
      const documentId = pull.documentId;
      if (!documentId) return;
      setStatus({ kind: 'busy', pullNumber: pull.number });
      const res = await client.open({ documentId, pullNumber: pull.number });
      if (!res.ok) {
        setStatus({ kind: 'error', message: res.message });
        return;
      }
      setStatus({ kind: 'idle' });
      onResume?.(documentId);
    },
    [client, onResume],
  );

  const unmount = useCallback(
    async (pullNumber: number) => {
      setStatus({ kind: 'busy', pullNumber });
      const res = await client.unmountPullRequest(pullNumber);
      if (!res.ok) {
        setStatus({ kind: 'error', message: res.message });
        return;
      }
      setStatus({ kind: 'idle' });
      await refreshMounted();
    },
    [client, refreshMounted],
  );

  return (
    <section data-vs-collab-pulls style={wrap}>
      <h2 style={heading}>Open collaborations</h2>
      <p style={note}>
        Every open pull request in this repository. One with a visual-spec document can be picked up where it was left;
        any of them can be checked out beside your files, detached at its head, as a read-only view — nothing here
        commits, pushes or merges.
      </p>

      <label style={row}>
        <span style={label}>Show</span>
        <select
          aria-label="Pull request state"
          value={state}
          onChange={(e) => setState(e.target.value as PullRequestListState)}
          style={select}
        >
          {/*
            * "Open only" rather than "Open": `App.test.tsx` reaches the reviewer's
            * Open *button* by its text, and a one-word option beside it makes that
            * query ambiguous. The longer label is also the more accurate one.
            */}
          <option value="open">Open only</option>
          <option value="closed">Closed only</option>
          <option value="all">All states</option>
        </select>
      </label>

      {status.kind === 'error' && (
        <p data-vs-collab-pulls-status style={error}>
          {status.message}
        </p>
      )}

      {pulls === null ? (
        <p style={note}>Loading pull requests…</p>
      ) : pulls.length === 0 ? (
        <p style={note}>No {state === 'all' ? '' : `${state} `}pull requests.</p>
      ) : (
        <ul style={listReset}>
          {pulls.map((pull) => {
            const worktree = mountedFor(pull.number);
            const busy = status.kind === 'busy' && status.pullNumber === pull.number;
            return (
              <li key={pull.number} style={card} data-vs-pull={pull.number}>
                <div style={cardTitle}>
                  <span style={{ color: '#64748b' }}>#{pull.number}</span> {pull.title}
                  {pull.draft && <span style={badge}>draft</span>}
                  {worktree && <span style={mountedBadge}>checked out · {shortSha(worktree.headSha)}</span>}
                </div>
                <div style={meta}>
                  {pull.author || 'unknown author'} · {pull.headBranch} → {pull.baseBranch} · {shortSha(pull.headSha)} ·{' '}
                  {pull.state}
                </div>
                <div style={actions}>
                  {pull.documentId ? (
                    <button type="button" onClick={() => void resume(pull)} disabled={busy} style={primaryButton}>
                      Resume writing
                    </button>
                  ) : (
                    /*
                      * The listing is unfiltered (R-7.3), so most rows will not carry a
                      * document. Saying which ones do not is what keeps a row with one
                      * button from reading as a row whose other button failed to render.
                      */
                    <span data-vs-pull-nodoc style={quietMark} title="No visual-spec document is named in this pull request’s body, so there is nothing to resume writing.">
                      no document
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void mount(pull)}
                    disabled={busy}
                    style={pull.documentId ? button : primaryButton}
                  >
                    {busy ? 'Checking out…' : 'Review the code'}
                  </button>
                  {worktree && (
                    <button type="button" onClick={() => void unmount(pull.number)} disabled={busy} style={button}>
                      Remove checkout
                    </button>
                  )}
                  <a href={pull.htmlUrl} target="_blank" rel="noreferrer" style={link}>
                    On GitHub ↗
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, maxWidth: 720 };
const heading: React.CSSProperties = { font: '600 13px/1.4 system-ui, sans-serif', color: '#334155', margin: 0 };
const note: React.CSSProperties = { fontSize: 12, color: '#64748b', margin: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: '#64748b', width: 92, flexShrink: 0 };
const select: React.CSSProperties = { font: '12px system-ui, sans-serif', padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4 };
const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const card: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, background: 'white' };
const cardTitle: React.CSSProperties = { font: '600 13px system-ui, sans-serif', color: '#334155', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const meta: React.CSSProperties = { font: '11px ui-monospace, monospace', color: '#94a3b8', marginTop: 3 };
const actions: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 };
const button: React.CSSProperties = { font: '12px system-ui, sans-serif', padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#334155', cursor: 'pointer' };
const primaryButton: React.CSSProperties = { ...button, border: '1px solid #7c3aed', background: '#7c3aed', color: 'white' };
const link: React.CSSProperties = { font: '11px system-ui, sans-serif', color: '#7c3aed', textDecoration: 'none' };
const badge: React.CSSProperties = { font: '10px system-ui, sans-serif', padding: '1px 6px', borderRadius: 99, background: '#f1f5f9', color: '#64748b' };
const mountedBadge: React.CSSProperties = { font: '10px ui-monospace, monospace', padding: '1px 6px', borderRadius: 99, background: '#ecfdf5', color: '#047857' };
const error: React.CSSProperties = { fontSize: 12, color: '#b91c1c', margin: 0 };
/** Quiet, and still a sentence: why this row offers less than the one above it. */
const quietMark: React.CSSProperties = { font: '11px system-ui, sans-serif', color: '#94a3b8', fontStyle: 'italic' };
