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
 *
 * WHAT IS WAITING ON *YOU* IS TWO SECTIONS OF THIS LIST, NOT A SECOND LIST (R-A3.2). The
 * actions already here — resume, review the code, remove the checkout — are the ones a
 * counted pull request needs, and a parallel list would own its own copy of them and
 * drift. So the sections render above the groups, from the same `listRow` the groups
 * render, and the listing underneath stays whole and unfiltered (R-A3.6).
 *
 * THE JOIN ONTO THE LISTING CAN MISS, AND THAT IS NOT A BUG (R-A3.4 / R-A3.5). The counts
 * come from search, which pages at 30, and R-7.9 bounds the listing while deliberately not
 * bounding the count — so the two sets genuinely diverge. A search item carries a number, a
 * title and a URL and no branch or head commit, so a row the listing does not have is
 * rendered from those three fields with no checkout offered: a button built on a head
 * nobody fetched could only fail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MarkdownSurface } from './markdown-surface';
import { BusyLabel, LoadingLine } from './spinner';
import {
  type AwaitingItem,
  type AwaitingMention,
  type AwaitingSide,
  type MountedWorktree,
  type OpenedReview,
  type PullRequestListState,
  type PullRequestSummary,
  createCollabClient,
} from './collab-client';
import { useAwaitingPulls } from './use-awaiting-pulls';

export type CollabPullsPanelProps = {
  /**
   * Called once a Pull Request is open and ready to read. Both halves are handed over:
   * the summary is what the header names, and the review says where its files come from
   * (R-W1.5) and at which commit. Where a checkout supplies it, `worktree.path` is git's
   * own (R-13.8), never one recomputed here; where the host does, there is no path and
   * that is an ordinary review, not a lesser one.
   */
  onReview: (pull: PullRequestSummary, review: OpenedReview) => void;
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
  /**
   * Called when an `autoReview` could not be opened — the listing does not have that pull
   * request, or its mount failed. The caller is showing a focused "opening #n" surface on
   * the strength of the deep link, and this is what tells it to stop and show the list
   * instead. Never called on success: the review takes the screen.
   */
  onAutoReviewFailed?: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** One rendered block of rows. A null `title` is the flat list — see the note at the call. */
type PullGroup = { key: string; title: string | null; rows: PullRequestSummary[] };

/**
 * Split the listing into the reader's own pull requests and everyone else's.
 *
 * ORDER IS DELIBERATE: yours first. They are the ones you are waiting on an answer for,
 * and the ones whose comments are addressed to you.
 *
 * The comparison is case-insensitive because GitHub logins are, and a `Javierhbr` in the
 * snapshot against a `javierhbr` on the pull request would silently file the reader's own
 * work under someone else's — a wrong split being worse than no split at all.
 */
export function groupByOwner(pulls: readonly PullRequestSummary[], login: string | null): PullGroup[] {
  const flat: PullGroup[] = [{ key: 'all', title: null, rows: [...pulls] }];
  if (!login) return flat;
  const me = login.toLowerCase();
  const mine = pulls.filter((p) => (p.author ?? '').toLowerCase() === me);
  const theirs = pulls.filter((p) => (p.author ?? '').toLowerCase() !== me);
  if (mine.length === 0 || theirs.length === 0) return flat;
  return [
    { key: 'mine', title: 'Yours', rows: mine },
    { key: 'others', title: 'From others', rows: theirs },
  ];
}

/** A commit is named the way git names it in prose: the first seven characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * `action` as well as `pullNumber`, so the spinner lands on the button that was pressed.
 *
 * A row-wide busy flag put "Opening the review…" on the mount button when the reviewer had
 * pressed `Resume writing` next to it — the wrong control claiming the wait, and the
 * pressed one showing nothing at all. Every button on the row still disables together,
 * because they all act on the same checkout; only the signal is narrowed.
 */
type PullAction = 'resume' | 'mount' | 'unmount';
type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; pullNumber: number; action: PullAction }
  | { kind: 'error'; message: string };

export function CollabPullsPanel({ onReview, onResume, autoReview, onAutoReviewFailed, fetchImpl }: CollabPullsPanelProps) {
  const client = useMemo(() => createCollabClient(fetchImpl), [fetchImpl]);
  const [state, setState] = useState<PullRequestListState>('open');
  const [pulls, setPulls] = useState<PullRequestSummary[] | null>(null);
  const [mounted, setMounted] = useState<MountedWorktree[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  /** The signed-in login, or null while unknown — which is what turns the split off. */
  const [login, setLogin] = useState<string | null>(null);
  /**
   * The descriptions a reviewer has asked to read, keyed by pull number.
   *
   * A listing of titles answers "what is open" and not "what is this", and the second
   * question was costing a trip to github.com and back. It is a disclosure and not a
   * column: a body is unbounded prose, and printing every one of them would bury the
   * listing it belongs to. `undefined` is unopened, `null` is in flight, a string is the
   * answer — including `''`, which means the author wrote no description.
   */
  const [descriptions, setDescriptions] = useState<Record<number, string | null | undefined>>({});

  const toggleDescription = useCallback(
    async (pullNumber: number) => {
      // Second press closes it. The body is dropped with it — it is one cheap read, and
      // keeping it would mean showing a description that may since have been edited.
      if (descriptions[pullNumber] !== undefined) {
        setDescriptions((prev) => ({ ...prev, [pullNumber]: undefined }));
        return;
      }
      setDescriptions((prev) => ({ ...prev, [pullNumber]: null }));
      const res = await client.pullRequestDescription(pullNumber);
      setDescriptions((prev) => ({ ...prev, [pullNumber]: res.ok ? res.value : '' }));
      // R-11.4 — the server's own sentence, in the panel's one error line.
      if (!res.ok) setStatus({ kind: 'error', message: res.message });
    },
    [client, descriptions],
  );

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

  /*
   * Who is signed in, from the snapshot the whole collaboration UI already gates on.
   * It is read here rather than passed in because the panel is mounted from two places
   * (`CollabDrawer` and `CollabApp`'s landing page) and neither holds it; the route is
   * the same one `useCollabPulls` reads on mount, so this costs no GitHub traffic.
   */
  useEffect(() => {
    let live = true;
    void client.availability().then((res) => {
      // An unreadable snapshot costs the split and nothing else — the flat list below is
      // the same list, and a banner about it would be about a heading.
      if (live && res.ok && res.value.available) setLogin(res.value.login);
    });
    return () => {
      live = false;
    };
  }, [client]);

  const groups = useMemo(() => groupByOwner(pulls ?? [], login), [pulls, login]);

  /**
   * What is waiting on this reader, read from the store the header chips already read
   * (R-A3.1). Subscribed, not fetched: a second caller of `/pulls/awaiting` would double
   * the cost of every refresh of a route that spends a search budget of 30 a minute, and
   * the whole reason that value lives in a module store is that this panel and the header
   * are in different trees with nothing to prop-drill from.
   */
  const awaiting = useAwaitingPulls();

  /**
   * The listing, by number, so a section row can be the listing's own row (R-A3.3).
   *
   * Derived and never stored. `pulls` is state here and `awaiting` is state in the store;
   * a third copy synchronised by an effect would render one pass behind both of them, and
   * there is nothing in this join a render cannot recompute.
   */
  const listed = useMemo(() => new Map((pulls ?? []).map((p) => [p.number, p] as const)), [pulls]);

  /**
   * R-13.3 / R-13.7 — mount, then read. Re-mounting an already-checked-out PR is the
   * supported way to move it to a head that has since changed (R-13.12), so the button
   * is offered on a mounted row too; git moves the existing checkout rather than
   * recreating it, and the path the reviewer had stays valid.
   */
  const mount = useCallback(
    async (pull: PullRequestSummary): Promise<boolean> => {
      setStatus({ kind: 'busy', pullNumber: pull.number, action: 'mount' });
      const res = await client.mountPullRequest(pull.number);
      if (!res.ok) {
        setStatus({ kind: 'error', message: res.message });
        return false;
      }
      /*
       * A REVIEW WITH NO WORKTREE IS A REVIEW, NOT A REFUSAL (R-W1.3).
       *
       * The server answered, so the pull request is open and readable; `worktree` is
       * simply absent because the served directory is not a working tree it could check
       * out into, and the repository host is supplying the files instead. That used to be
       * reported here as an error — the honest placeholder while the surface knew only
       * about checkouts — and it is not one: nothing failed, and there is nothing for the
       * reviewer to go and fix.
       *
       * So the whole response is handed on as it stands. Which source it is goes with it
       * (R-W1.5), for the surface to say out loud; the path goes only when there is one.
       */
      const { source, headSha, worktree } = res.value;
      setStatus({ kind: 'idle' });
      await refreshMounted();
      onReview(pull, { source, headSha, ...(worktree ? { worktree } : {}) });
      return true;
    },
    [client, onReview, refreshMounted],
  );

  const autoReviewed = useRef(false);
  /**
   * A deep link is a request to read one pull request, so until it fails this panel is
   * that one pull request and not the listing.
   *
   * `?vspr=2` used to render the whole landing page — every open pull request, the
   * "open from a URL" form — with the checkout's only sign of life a spinner inside one
   * row of it. The reader asked for #2 and got a list of everything, then watched it
   * replace itself. The reads underneath are unchanged (the listing is what carries the
   * title, author and branches the review header names); what changed is that the page
   * now says which pull request it is opening.
   */
  const [autoPending, setAutoPending] = useState(autoReview !== undefined);
  useEffect(() => {
    if (autoReview === undefined || autoReviewed.current || pulls === null) return;
    const pull = pulls.find((p) => p.number === autoReview);
    if (!pull) {
      // Not in the listing: closed, merged, another repository, or the read failed. The
      // list — with whatever error it is carrying — is the honest next screen.
      setAutoPending(false);
      onAutoReviewFailed?.();
      return;
    }
    autoReviewed.current = true;
    void mount(pull).then((ok) => {
      if (ok) return;
      setAutoPending(false);
      onAutoReviewFailed?.();
    });
  }, [autoReview, pulls, mount, onAutoReviewFailed]);

  /**
   * R-7.7 — attach to the collaboration this pull request already carries. Same route,
   * same precedence on failure as everything else here: the server's own sentence, never
   * a rewritten one (R-11.4).
   */
  const resume = useCallback(
    async (pull: PullRequestSummary) => {
      const documentId = pull.documentId;
      if (!documentId) return;
      setStatus({ kind: 'busy', pullNumber: pull.number, action: 'resume' });
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
      setStatus({ kind: 'busy', pullNumber, action: 'unmount' });
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

  /**
   * Who wrote the mention and what it said (R-A3.7).
   *
   * This is the row's reason to exist. The ask was "not only on github.com", and a row
   * that says "you were mentioned" and links out has moved the trip rather than saved it —
   * the scan already held the comment body at the moment it matched, so the passage is
   * here for free. Absent on a mention found by search, which does not say who wrote it.
   */
  const mentionNote = (pullNumber: number, mention: AwaitingMention) => (
    <div data-vs-awaiting-mention={pullNumber} style={mentionBox}>
      <span style={mentionAuthor}>@{mention.author}</span> {mention.excerpt}
    </div>
  );

  /**
   * One row of the listing. `scope` distinguishes the copies: the same pull request can be
   * both in a section and in the groups below, and two elements cannot share the `id` the
   * description disclosure is addressed by.
   *
   * Called from the sections as well as from the groups, because R-A3.3 is precisely that a
   * counted pull request is not downgraded for having arrived through a different door.
   */
  const listRow = (pull: PullRequestSummary, scope: string, mention?: AwaitingMention) => {
    const worktree = mountedFor(pull.number);
    const busy = status.kind === 'busy' && status.pullNumber === pull.number;
    const running = (a: PullAction) => busy && status.kind === 'busy' && status.action === a;
    const descId = `vs-pr-desc-${scope}-${pull.number}`;
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
        {mention && mentionNote(pull.number, mention)}
        <div style={actions}>
          {pull.documentId ? (
            <button type="button" onClick={() => void resume(pull)} disabled={busy} style={primaryButton}>
              <BusyLabel busy={running('resume')}>{running('resume') ? 'Opening…' : 'Resume writing'}</BusyLabel>
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
            <BusyLabel busy={running('mount')}>{running('mount') ? 'Opening the review…' : 'Review the code'}</BusyLabel>
          </button>
          {worktree && (
            <button type="button" onClick={() => void unmount(pull.number)} disabled={busy} style={button}>
              <BusyLabel busy={running('unmount')}>{running('unmount') ? 'Removing…' : 'Remove checkout'}</BusyLabel>
            </button>
          )}
          <button
            type="button"
            onClick={() => void toggleDescription(pull.number)}
            aria-expanded={descriptions[pull.number] !== undefined}
            aria-controls={descId}
            style={button}
          >
            <BusyLabel busy={descriptions[pull.number] === null}>
              {descriptions[pull.number] !== undefined ? 'Hide description' : 'View description'}
            </BusyLabel>
          </button>
          <a href={pull.htmlUrl} target="_blank" rel="noreferrer" style={link}>
            On GitHub ↗
          </a>
        </div>
        {descriptions[pull.number] !== undefined && descriptions[pull.number] !== null && (
          <div id={descId} data-vs-pull-description={pull.number} style={descriptionBox}>
            {descriptions[pull.number] ? (
              /*
               * Rendered, not printed raw. A pull request body is Markdown, and this
               * product renders Markdown everywhere else — showing the source here
               * would make the one place a reviewer reads prose the one place it is
               * not readable.
               */
              <MarkdownSurface source={descriptions[pull.number] as string} />
            ) : (
              <span style={quietMark}>No description on this pull request.</span>
            )}
          </div>
        )}
      </li>
    );
  };

  /**
   * A pull request the listing does not have (R-A3.4 / R-A3.5).
   *
   * Number, title and a link out is everything search gave us, so it is everything shown.
   * No checkout: there is no branch and no head commit behind this row, and the sentence
   * beside it is there because a row with fewer controls than the one above it reads as
   * broken unless it says why.
   */
  const unlistedRow = (item: AwaitingItem) => (
    <li key={item.number} style={card} data-vs-awaiting-unlisted={item.number}>
      <div style={cardTitle}>
        <span style={{ color: '#64748b' }}>#{item.number}</span> {item.title}
      </div>
      {item.mention && mentionNote(item.number, item.mention)}
      <div style={actions}>
        <span style={quietMark}>
          Not among the pull requests listed below, so it cannot be checked out from here.
        </span>
        <a href={item.htmlUrl} target="_blank" rel="noreferrer" style={link}>
          On GitHub ↗
        </a>
      </div>
    </li>
  );

  /**
   * One titled section of the list (R-A3.1 / R-A3.2).
   *
   * A side that has never answered is `{ ok: false }` and renders nothing — the same rule
   * the chips follow, where an unknown count is absent rather than zero. An empty section
   * is dropped too: a heading over no rows is a claim that something is waiting.
   */
  const awaitingSection = (key: string, title: string, side: AwaitingSide | undefined) => {
    if (!side?.ok || side.items.length === 0) return null;
    return (
      <section key={key} data-vs-awaiting={key} style={{ display: 'contents' }}>
        <h3 style={groupHeading}>{title}</h3>
        {/*
          * R-A3.9 — the `Show` control above re-queries the *listing*; both counts are of
          * open pull requests by R-A1.7 and these sections never move. Said out loud only
          * when the two disagree, because a section that silently stayed put while the list
          * changed underneath it would look filtered by a control that never touched it.
          */}
        {state !== 'open' && (
          <p data-vs-awaiting-open-only={key} style={quietMark}>
            Open pull requests only — the “Show” setting above applies to the listing, not to this section.
          </p>
        )}
        {/*
          * R-A3.8 — the count is GitHub's own total (R-A2.10) and one search page is what
          * was retrieved. The gap is legitimate; unexplained it turns a bound into a lie.
          */}
        {side.items.length < side.total && (
          <p data-vs-awaiting-shortfall={key} style={quietMark}>
            Showing {side.items.length} of {side.total} — GitHub answers this query one page at a time.
          </p>
        )}
        <ul style={listReset}>
          {side.items.map((item) => {
            const pull = listed.get(item.number);
            return pull ? listRow(pull, `awaiting-${key}`, item.mention) : unlistedRow(item);
          })}
        </ul>
      </section>
    );
  };

  const sections = [
    awaitingSection('review', 'Waiting on your review', awaiting?.reviewRequested),
    awaitingSection('mentions', 'You were mentioned', awaiting?.mentioned),
  ];

  /**
   * The listing's own heading, and only once something is stacked above it.
   *
   * `groupByOwner` answers `title: null` for the undivided list, and that was right while
   * nothing preceded it — a heading over the only block is a label, not a division. With a
   * section above, the absence stops being neutral: found in the browser, the listing's
   * rows read as three more rows of "You were mentioned", because nothing on screen said
   * the mention section had ended. So the fallback appears exactly when a section did, and
   * the common case — nothing waiting on you, no sections — renders as it always has.
   *
   * Only the untitled group takes it. "Yours" and "From others" already divide, and a
   * heading above their heading would divide the same rows twice.
   */
  const listHeading = sections.some(Boolean)
    ? state === 'open'
      ? 'All open pull requests'
      : state === 'closed'
        ? 'All closed pull requests'
        : 'All pull requests'
    : null;

  if (autoPending) {
    return (
      <section data-vs-collab-pulls data-vs-opening={autoReview} style={wrap}>
        <h2 style={heading}>Opening #{autoReview}…</h2>
        <LoadingLine style={{ ...note, opacity: 1 }}>
          {pulls === null ? 'Finding the pull request…' : 'Checking it out beside your files, read-only…'}
        </LoadingLine>
      </section>
    );
  }

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

      {/*
        * R-A3.1 / R-A3.2 — the two sections, at the top of this list and not beside it.
        * Above the listing's own states on purpose: they are the answer to "what is waiting
        * on me", and they are still the answer while the listing is loading or empty.
        */}
      {sections}

      {pulls === null ? (
        <LoadingLine style={{ ...note, opacity: 1 }}>Loading pull requests…</LoadingLine>
      ) : pulls.length === 0 ? (
        <p style={note}>No {state === 'all' ? '' : `${state} `}pull requests.</p>
      ) : (
        /*
         * YOUR OWN PULL REQUESTS ARE A DIFFERENT JOB, SO THEY GET THEIR OWN SECTION.
         *
         * On someone else's pull request a reviewer reads and comments; on their own they
         * are watching what came back. One undifferentiated list made the reader do that
         * sorting by eye, matching a login against an author column on every row — and the
         * login is a fact the server already told us (`GET /__vs/collab`), so the list can
         * do it once instead.
         *
         * THE SPLIT ONLY APPEARS WHEN THERE IS SOMETHING TO SPLIT. Where the login is not
         * known (collaboration unconfigured, or the snapshot has not landed) or every row
         * falls on one side of the line, the list renders exactly as it did — flat, with no
         * heading. A section header over the only group is a label, not a division.
         *
         * R-A3.6 — unchanged by the sections above: every pull request the listing holds is
         * still here, in its group, with nothing removed for having been shown twice.
         */
        groups.map(({ key, title, rows }) => (
          <section key={key} data-vs-pull-group={key} style={{ display: 'contents' }}>
            {(title ?? listHeading) && <h3 style={groupHeading}>{title ?? listHeading}</h3>}
            <ul style={listReset}>{rows.map((pull) => listRow(pull, 'list'))}</ul>
          </section>
        ))
      )}
    </section>
  );
}

/** No fixed cap: the drawer decides how wide this is, and it grew for the descriptions. */
const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 12 };
const heading: React.CSSProperties = { font: '600 13px/1.4 system-ui, sans-serif', color: '#334155', margin: 0 };
const note: React.CSSProperties = { fontSize: 12, color: '#64748b', margin: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: '#64748b', width: 92, flexShrink: 0 };
const select: React.CSSProperties = { font: '12px system-ui, sans-serif', padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4 };
/** Quieter than the panel's `h2`: it divides the list, it does not retitle the panel. */
const groupHeading: React.CSSProperties = { font: '700 11px system-ui, sans-serif', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, margin: '6px 0 0' };
const listReset: React.CSSProperties ={ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 };
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
/**
 * The body, boxed and height-capped.
 *
 * A description can be a page long, and an uncapped one would push every row below it out
 * of the drawer — so the listing stays navigable and the prose scrolls inside its own box.
 */
const descriptionBox: React.CSSProperties = {
  marginTop: 8,
  padding: '2px 12px',
  maxHeight: 260,
  overflow: 'auto',
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  background: '#f8fafc',
  font: '13px system-ui, sans-serif',
};
const quietMark: React.CSSProperties = { font: '11px system-ui, sans-serif', color: '#94a3b8', fontStyle: 'italic' };
/**
 * The mention, quoted on the row (R-A3.7).
 *
 * Set apart with a rule down the side the way a quotation is, because it is somebody
 * else's words inside the row and not the row's own metadata. The excerpt is a passage
 * and can be long, so it wraps rather than being clipped — the point is to read it here.
 */
const mentionBox: React.CSSProperties = {
  marginTop: 6,
  padding: '4px 8px',
  borderLeft: '2px solid #ddd6fe',
  background: '#faf5ff',
  borderRadius: 3,
  font: '12px/1.5 system-ui, sans-serif',
  color: '#475569',
  whiteSpace: 'pre-wrap',
};
const mentionAuthor: React.CSSProperties = { font: '600 12px system-ui, sans-serif', color: '#6d28d9' };
