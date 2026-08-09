/**
 * collab-pr-review.tsx — reading a checked-out Pull Request (R-13.11, R-13.19).
 *
 * WHAT IT IS. The surface a reviewer lands on once `CollabPullsPanel` has mounted a
 * Pull Request. The changed files are the entry point, because that is what a review is
 * *about*; the whole checkout sits underneath them, because a change is rarely readable
 * without the files around it. Both halves are R-13.11, and it is one requirement rather
 * than two on purpose: a list of changed paths with no way out of it is a diff, not a
 * review.
 *
 * WHY IT BROWSES THROUGH `/__vs/tree` RATHER THAN A ROUTE OF ITS OWN. The checkout lives
 * at `<served>/.visual-spec/worktrees/pr-<n>` (R-13.5) — inside the directory the tree
 * walk already covers, and not ignored by it. So the files are already enumerable and
 * already readable, and the whole job here is to show that subtree under its own root.
 * A second listing route would be a second answer to a question `TreeStore` answers.
 *
 * READ-ONLY, AND NOT BY DISABLING THINGS (R-13.19). Three writes exist in the local file
 * surface — create, rename, and the editor's save — and none of them is rendered here.
 * `FileTree` is mounted with `readOnly`, which removes "+ New file" and the per-row
 * rename rather than greying them; the pane is `CodeView` / `MarkdownSurface`, both of
 * which are viewers with no buffer to save; and `GenericEditor`'s comment panel is
 * deliberately not mounted, because a comment on a checkout is R-13.13's *held* comment
 * with a head sha on it, which is a different record than the local sidecar's.
 *
 * That the checkout is detached (R-13.6) is the filesystem's half of the same promise.
 * This is the interface's half: there is nothing to click that writes *the code*.
 *
 * COMMENTING IS NOT EDITING (R-13.13 … R-13.18). A reviewer picks a line in `CodeView` —
 * the selection the viewer already reported — and writes a comment, which is **held**
 * under `.visual-spec/reviews/` and touches neither the checkout nor GitHub. Publishing is
 * a second, explicit act, per comment. Nothing here opens a buffer over the file, so the
 * read-only promise above is untouched: the only thing this surface writes is a comment.
 *
 * The two 409s are shown, not swallowed. `stale-draft` (R-13.14) names both shas and
 * offers to publish anyway — that is `force: true`, and it is the reviewer's call, never
 * this component's. `already-published` (R-13.17) is not an error for the reviewer at all:
 * the comment is on the pull request, so the drafts are re-read and the card flips to its
 * "On GitHub" chip with the link.
 *
 * R-13.18 IS A LABEL, NOT AN INFERENCE. Every comment card sits under a chip that says
 * where it lives — "draft — not sent yet" or "On GitHub · #n" — and the published chip
 * renders even when the permalink is missing. A reviewer must never have to read the
 * absence of a button. The word here is "draft", not "local": every comment on this
 * surface belongs on the pull request, and the only question a chip answers is whether it
 * has got there yet. "Local" is the sidecar panel's word for a different kind of comment
 * entirely — the reader's own notes, which are going nowhere.
 *
 * IT IMPORTS ONLY TYPES FROM `core/`. `worktree.ts` reads `node:fs/promises`; the one
 * thing needed from it here is the shape of a mounted worktree and the shape of its
 * path, and the path convention is re-declared below rather than imported.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { InspectOverlay, InspectorProvider } from '../core/app';
import { ActiveCommentProvider } from './active-comment';
import { CodeView, type LineSelection } from './code-view';
import { CommentPanel } from './comment-panel';
import { IndicatorLayer } from './indicator-layer';
import { BusyLabel, LoadingLine, Spinner } from './spinner';
import { reviewCommentPanelSource, reviewIndicatorTargets } from './review-comment-source';
import {
  type MountedWorktree,
  type PullRequestSummary,
  type ReviewDraft,
  type ReviewDraftInput,
  createCollabClient,
} from './collab-client';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
import { shortSha } from './collab-pulls-panel';
import { FileTree } from './file-tree';
import { MarkdownSurface } from './markdown-surface';
import { type TreeEntry, invalidateTree, rawUrl, useFile, useTree } from './use-tree';

export type CollabPrReviewProps = {
  pull: PullRequestSummary;
  worktree: MountedWorktree;
  /** Back to the list. The checkout is left mounted — leaving a review is not unmounting. */
  onExit: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Where the checkout sits, relative to the served directory (R-13.5).
 *
 * `core/collaboration/worktree.ts` owns this convention and computes the same string
 * from `WORKTREE_DIR`; it cannot be imported here because that module reaches
 * `node:fs/promises`. The two are pinned to each other by
 * `ui/collab-pr-review.test.tsx`, which asserts this against the path git reports.
 */
export function worktreePrefix(pullNumber: number): string {
  return `.visual-spec/worktrees/pr-${pullNumber}/`;
}

/**
 * The checkout's own tree: everything under the mount point, re-rooted so a reviewer
 * reads `src/auth.ts` rather than `.visual-spec/worktrees/pr-42/src/auth.ts`. The full
 * path is put back on before any read — see `checkoutPath`.
 */
export function entriesUnder(entries: TreeEntry[], prefix: string): TreeEntry[] {
  return entries
    .filter((e) => e.path.startsWith(prefix) && e.path.length > prefix.length)
    .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
}

/**
 * The changed paths as a tree, with the folders that hold them.
 *
 * WHY NOT THE FLAT LIST IT REPLACED. A pull request touching 26 files across a monorepo
 * printed 26 copies of `packages/visual-spec/…`, each ellipsised in the middle so the part
 * that differed — the filename — was the part that got cut. The reviewer could see which
 * repository the change was in and not which files it was in. Nesting spends the width on
 * the leaves instead, and the shape of the change becomes readable at a glance: four docs,
 * then a run of `core/vite/routes`, then the UI.
 *
 * THE ENTRIES ARE THE CHECKOUT'S OWN where the checkout has them, so a row opens exactly
 * the file the flat list opened and carries the `kind` the server detected. A path the
 * checkout does not have is a file the pull request deleted (R-13.12); it still gets a row,
 * because "this was removed" is part of the change, and clicking it reports that rather
 * than opening nothing.
 *
 * `buildTree` resolves each node's parent by path and needs the parent to exist, so the
 * directories are synthesised here rather than left to it.
 */
export function changedTreeEntries(paths: readonly string[], byPath: Map<string, TreeEntry>): TreeEntry[] {
  const out = new Map<string, TreeEntry>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (!out.has(dir)) out.set(dir, { path: dir, name: segments[i - 1]!, type: 'dir' });
    }
    out.set(path, byPath.get(path) ?? { path, name: segments[segments.length - 1]!, type: 'file', kind: 'text' });
  }
  // Sorted by path so parents precede children, which is what `buildTree` relies on.
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * What the last publish or discard attempt left on one card.
 *
 * `stale` is kept apart from `error` because it is the only one with an answer the
 * reviewer can give — R-13.14's `force` — and rendering it as an error would hide that.
 * `note` is for the outcomes that are not failures at all: a comment that was already
 * published, and a line-level comment GitHub accepted only against the file (R-7.13).
 */
type DraftNotice =
  | { kind: 'stale'; message: string; draftHeadSha: string; currentHeadSha: string }
  | { kind: 'error'; message: string }
  | { kind: 'note'; message: string };

export function CollabPrReview({ pull, worktree, onExit, fetchImpl }: CollabPrReviewProps) {
  const client = useMemo(() => createCollabClient(fetchImpl), [fetchImpl]);
  const prefix = worktreePrefix(pull.number);

  const [changed, setChanged] = useState<string[] | null>(null);
  const [changedError, setChangedError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TreeEntry | null>(null);
  const [filter, setFilter] = useState('');
  /** P7 — the rest of the checkout is context, so it starts out of the way. */
  const [restOpen, setRestOpen] = useState(false);
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, DraftNotice>>({});
  /** The pull request's own review conversation. `null` until the first read answers. */
  const [threads, setThreads] = useState<ReviewThreadRecord[] | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsBusy, setThreadsBusy] = useState(false);

  // The mount just wrote thousands of files into a directory whose walk is cached for
  // seconds on both sides. Without this the checkout is invisible until the TTL lapses,
  // which reads as an empty pull request.
  useEffect(() => {
    invalidateTree();
  }, [worktree.path]);
  const { entries, loading, reload } = useTree();

  useEffect(() => {
    let live = true;
    setChanged(null);
    setChangedError(null);
    void client.pullRequestFiles(pull.number).then((res) => {
      if (!live) return;
      // R-11.4 — the route's own sentence. The checkout is already usable when this
      // fails, so it costs the entry list and not the review.
      if (res.ok) setChanged(res.value.files);
      else {
        setChanged([]);
        setChangedError(res.message);
      }
    });
    return () => {
      live = false;
    };
  }, [client, pull.number]);

  /**
   * R-13.13 / R-13.17 — everything held for this pull request, published records
   * included. Re-read after every write rather than patched in place: the file on disk is
   * the only account of what has already gone out, and a second browser tab publishing the
   * same draft would make an optimistic copy here a lie.
   */
  const loadDrafts = useCallback(async () => {
    const res = await client.reviewDrafts(pull.number);
    if (res.ok) {
      setDrafts(res.value ?? []);
      setDraftsError(null);
    } else setDraftsError(res.message);
  }, [client, pull.number]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  /**
   * The pull request's review conversation — every thread on every changed file, replies
   * included — read once when the checkout opens and again whenever the reviewer asks.
   *
   * It is a separate read from the drafts and stays one. The drafts are a file on this
   * machine and cost nothing; this is a REST list plus a GraphQL read against GitHub, and
   * it is the one that can be slow, rate-limited, or refused. Folding the two together
   * would mean a failed conversation read taking the reviewer's own held comments off the
   * screen with it.
   *
   * Not polled. A review is read at human pace, and a page that re-reads GitHub on a timer
   * spends someone's rate limit to tell them nothing changed — `Refresh comments` is the
   * ask, and it says when it last answered.
   */
  const loadThreads = useCallback(async () => {
    setThreadsBusy(true);
    const res = await client.reviewComments(pull.number);
    if (res.ok) {
      setThreads(res.value ?? []);
      setThreadsError(null);
    } else {
      // The checkout and the drafts are untouched by this failing, so it costs the
      // conversation and not the review (R-11.4 — the route's own sentence, verbatim).
      setThreadsError(res.message);
    }
    setThreadsBusy(false);
  }, [client, pull.number]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const noticeFor = (id: string, notice: DraftNotice | null) =>
    setNotices((prev) => {
      const next = { ...prev };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });

  /** R-13.13 — hold the comment. Nothing reaches GitHub until someone presses Send. */
  const hold = async (input: ReviewDraftInput): Promise<boolean> => {
    const res = await client.holdReviewDraft(pull.number, input);
    if (!res.ok) {
      setDraftsError(res.message);
      return false;
    }
    setDraftsError(null);
    await loadDrafts();
    return true;
  };

  const publish = async (id: string, force?: boolean) => {
    const res = await client.publishReviewDraft(pull.number, id, force ? { force: true } : undefined);
    if (res.ok) {
      const { alreadyPublished, degraded } = res.value;
      noticeFor(
        id,
        degraded
          ? { kind: 'note', message: `Posted against the file rather than the line — ${degraded.reason}` }
          : alreadyPublished
            ? { kind: 'note', message: 'This comment was already on the pull request. Nothing was posted twice.' }
            : null,
      );
    } else if (res.kind === 'conflict' && res.reason === 'stale-draft') {
      // R-13.14 — both shas, and the choice. `force` is never sent on this attempt.
      noticeFor(id, {
        kind: 'stale',
        message: res.message,
        draftHeadSha: res.draftHeadSha ?? '(unknown)',
        currentHeadSha: res.currentHeadSha ?? '(unknown)',
      });
    } else noticeFor(id, { kind: 'error', message: res.message });
    await loadDrafts();
  };

  const discard = async (id: string) => {
    const res = await client.discardReviewDraft(pull.number, id);
    if (res.ok) noticeFor(id, null);
    else if (res.kind === 'conflict' && res.reason === 'already-published') {
      /*
       * R-13.17 — not the reviewer's error. The comment is on the pull request, and the
       * local record is what stops it going out twice, so it is kept. `loadDrafts` below
       * brings back the published record, and the card re-renders with its GitHub chip
       * and permalink — which is the only place the comment can actually be withdrawn.
       */
      noticeFor(id, {
        kind: 'note',
        message: 'Already on the pull request, so the local record is kept — it is what stops it being posted twice. Withdraw it on GitHub.',
      });
    } else noticeFor(id, { kind: 'error', message: res.message });
    await loadDrafts();
  };

  const heldCount = drafts.filter((d) => d.status === 'draft').length;
  /*
   * What is on the pull request is counted from the pull request, not from the local
   * outbox. `drafts.length - heldCount` counted the comments *this machine* had sent, so a
   * checkout that had never published said "0 on GitHub" over a conversation of a dozen.
   * `threads` is `null` until the first read answers; a count of 0 then is honest —
   * nothing is known yet — and the chip is hidden while there is nothing to say.
   */
  const threadCount = useMemo(() => {
    const onGitHub = new Set((threads ?? []).map((t) => t.github.reviewCommentId));
    // Union, not either one: the conversation read is the better answer and may not have
    // arrived (or may have failed), and a comment this machine published is on the pull
    // request whether or not GitHub has been asked about it yet.
    const published = drafts.filter((d) => d.published && !onGitHub.has(d.published.reviewCommentId));
    return onGitHub.size + published.length;
  }, [threads, drafts]);
  const replyCount = (threads ?? []).reduce((n, t) => n + t.replies.length, 0);

  const checkout = useMemo(() => entriesUnder(entries, prefix), [entries, prefix]);
  const byPath = useMemo(() => new Map(checkout.map((e) => [e.path, e])), [checkout]);
  const checkoutFiles = useMemo(() => checkout.filter((e) => e.type === 'file').length, [checkout]);
  const changedEntries = useMemo(() => changedTreeEntries(changed ?? [], byPath), [changed, byPath]);

  /**
   * How many review comments each file carries, for the count on its row.
   *
   * A count and not a dot: a dot says "something is here" only if you already know the
   * colour means that, and colour alone is not allowed to carry meaning. The number says
   * how much there is to read before you open it.
   */
  const commentsPerFile = useMemo(() => {
    const counts = new Map<string, number>();
    const onGitHub = new Set((threads ?? []).map((t) => t.github.reviewCommentId));
    // A published draft and its thread are one comment; counting both would tell the
    // reviewer a file has two things to read when it has one.
    for (const draft of drafts) {
      if (draft.published && onGitHub.has(draft.published.reviewCommentId)) continue;
      counts.set(draft.target.path, (counts.get(draft.target.path) ?? 0) + 1);
    }
    for (const thread of threads ?? []) {
      counts.set(thread.target.path, (counts.get(thread.target.path) ?? 0) + 1);
    }
    return counts;
  }, [drafts, threads]);

  /**
   * R-13.12 — the changed paths and the checkout must name the same commit. Both were
   * taken at the mount, and the head is re-read on every reload, so a changed file that
   * the checkout does not have is reported as such instead of opening nothing.
   */
  const open = (path: string) =>
    setSelected(byPath.get(path) ?? { path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file', kind: 'text' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/*
        * ONE ROW FOR THE WHOLE IDENTITY (R-9.1 … R-9.4).
        *
        * `CollabApp`'s header used to sit directly above this one saying `Collaboration
        * review` and then the number, the sha and "read-only" — all three of which this row
        * also said. Two rows, one subject, everything printed twice. This is the row that
        * survived, because it is the only one that can also say what the pull request is,
        * and `CollabApp` now renders no header of its own while a checkout is on screen.
        *
        * THE SHA IS THE MOUNTED TREE'S, not `pull.headSha`. They are the same at mount and
        * diverge the moment the pull request is pushed to, and the thing on screen is the
        * checkout — so naming the pull request's head here would be naming a commit the
        * reviewer is not reading. The branches on either side of the arrow are the pull
        * request's own, which is not R-9.2's prohibition: R-9.2 forbids naming a branch
        * *for the mounted tree*, which is detached (R-13.6) and on none. `· at <sha>` is
        * how the tree is named, and it is named as a commit.
        */}
      <div data-vs-pr-readonly style={banner}>
        <button type="button" onClick={onExit} style={backBtn}>
          ← Pull requests
        </button>
        {/*
          * WHO WROTE IT, AND HOW TO GET TO IT. The row named the pull request and the
          * commit but not the person, and offered no way to github.com — so a reviewer
          * reading a checkout could not tell whose work it was without going back to the
          * list, and could not reach the conversation at all. Both are on the pull request
          * record this component already holds; neither was being shown.
          *
          * TWO LINES, BECAUSE ONE COULD NOT HOLD IT. Number, title, author, both branches
          * and the sha on a single ellipsised line meant the tail — which is where the sha
          * lives — was the first thing cut on a narrow window. The identity leads on its
          * own line; the provenance sits under it, quieter, in the row's own monospace.
          *
          * P4 — `minWidth: 0` is what lets either line shrink at all: a flex child defaults
          * to `min-width: auto` and refuses to go below its own content. The number leads
          * line one so an ellipsis on the tail can only ever take the title.
          */}
        <span data-testid="vs-review-pull" data-vs-review-pull={pull.number} style={pullIdentity}>
          <strong style={identityLine} title={pull.title}>
            #{pull.number} {pull.title}
          </strong>
          <span style={identityMeta}>
            {pull.author || 'unknown author'} · {pull.headBranch} → {pull.baseBranch} · at{' '}
            {shortSha(worktree.headSha)}
          </span>
        </span>
        <span style={readOnlyChip}>Read-only checkout — no commit, push or merge</span>
        {(drafts.length > 0 || threadCount > 0) && (
          <span data-vs-draft-tally style={tallyChip}>
            {heldCount} held locally · {threadCount} on GitHub
            {replyCount > 0 ? ` · ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/*
          * The way out to the conversation. Everything this surface does is local and
          * read-only — nothing here comments, resolves or merges — so the pull request
          * itself is where the rest of the work happens, and it was reachable from the
          * list but not from inside a review. New tab, because the checkout on screen is
          * state a reviewer does not want to lose to a navigation.
          */}
        <a href={pull.htmlUrl} target="_blank" rel="noreferrer" style={ghLink}>
          On GitHub ↗
        </a>
        {/*
          * `reload()` re-walks the checkout — thousands of files on a real repository —
          * and the button gave no sign of it, so a reviewer waiting for a pushed commit to
          * appear pressed it repeatedly. `useTree`'s own `loading` is the truth here; this
          * button does not need a flag of its own.
          */}
        {/*
          * The conversation is read from GitHub, so it goes stale the moment somebody
          * replies. This is the ask — its own button next to `Refresh files`, because the
          * two refresh different things and a reviewer waiting for an answer to their
          * comment should not have to re-walk a checkout to get it.
          */}
        <button
          type="button"
          data-vs-refresh-comments
          onClick={() => void loadThreads()}
          disabled={threadsBusy}
          title="Re-read the pull request's comments and replies from GitHub"
          style={backBtn}
        >
          <BusyLabel busy={threadsBusy}>{threadsBusy ? 'Reading…' : 'Refresh comments'}</BusyLabel>
        </button>
        <button
          type="button"
          onClick={() => {
            invalidateTree();
            void reload();
          }}
          disabled={loading}
          style={backBtn}
        >
          <BusyLabel busy={loading}>{loading ? 'Refreshing…' : 'Refresh files'}</BusyLabel>
        </button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/*
          * R-13.11 IS ONE REQUIREMENT WITH A FRONT AND A BACK, AND THE SIDEBAR NOW SHOWS
          * WHICH IS WHICH. `CHANGED FILES (1)` and `ALL FILES IN THE CHECKOUT` were two
          * headings of equal weight, one of them over a whole repository — so a reviewer's
          * eye landed on files the pull request never touched. The changed files lead, are
          * heavier, and never collapse; the checkout keeps its half of R-13.11 behind one
          * line that says what it is for. It is a disclosure and not a removal: reading a
          * change means reading what it calls into, which was the second half's whole
          * argument and is unchanged.
          */}
        <nav style={sidebar}>
          <div style={leadHead}>
            Changed files{changed ? ` (${changed.length})` : ''}
          </div>
          <div style={leadNote}>What this pull request changes. This is what is under review.</div>
          {changedError && (
            <div data-vs-pr-changed-error style={errorLine}>
              {changedError}
            </div>
          )}
          {/*
            * The same component the checkout below uses, so the two halves of R-13.11 are
            * browsed the same way. `commentCounts` is what puts the review-comment count on
            * a row — the badge the flat list rendered by hand — and it is `FileTree`'s own
            * affordance, already used by the local sidebar.
            */}
          {/*
            * It takes the column's spare height rather than a fixed slice of it. A capped
            * box scrolled a 26-file tree inside 320px while the sidebar below it sat empty;
            * when the checkout disclosure is open the two share the space, which is the
            * only moment either of them has to give any up.
            */}
          {/*
            * WHILE `/files` IS IN FLIGHT THE COLUMN SAID NOTHING AT ALL — the heading, the
            * sentence under it, and then blank space where the tree would be, with the
            * checkout disclosure below it not yet rendered either. It read as a review of a
            * pull request that changed nothing, and stayed that way for as long as GitHub
            * took. `changed === null` is precisely "not answered yet"; the empty *array* is
            * the different claim, and it has its own sentence further down.
            */}
          {changed === null && !changedError && (
            <LoadingLine style={{ padding: '2px 12px 6px', fontSize: 12 }}>Reading what changed…</LoadingLine>
          )}
          <div data-vs-changed-tree style={{ flex: 1, minHeight: 0, padding: '0 6px 4px', overflow: 'auto' }}>
            <FileTree
              entries={changedEntries}
              current={selected?.path ?? ''}
              filter=""
              onPick={(entry) => open(entry.path)}
              commentCounts={commentsPerFile}
              readOnly
              defaultOpen
            />
          </div>
          {changed !== null && changed.length === 0 && !changedError && (
            <div style={emptyLine}>This pull request changes no files.</div>
          )}

          <button
            type="button"
            onClick={() => setRestOpen((v) => !v)}
            aria-expanded={restOpen}
            aria-controls="vs-checkout-rest"
            style={restToggle}
          >
            <span aria-hidden="true">{restOpen ? '▾' : '▸'}</span> Rest of the checkout ·{' '}
            {/*
              * The tree walk covers the whole checkout and is slow on a real repository.
              * `0 files` while it runs is a number the walk has not produced — a claim, not
              * a placeholder — so it waits and says it is counting.
              */}
            {loading ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, verticalAlign: 'middle' }}>
                <Spinner size={10} /> counting files…
              </span>
            ) : (
              `${checkoutFiles} files`
            )}{' '}
            — read for context, not under review
          </button>
          {restOpen && (
            <div id="vs-checkout-rest" style={restBody}>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" style={filterInput} />
              <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
                {loading ? (
                  <LoadingLine style={{ padding: '4px 12px', fontSize: 12 }} />
                ) : (
                  <FileTree entries={checkout} current={selected?.path ?? ''} filter={filter} onPick={setSelected} readOnly />
                )}
              </div>
            </div>
          )}
        </nav>

        {selected ? (
          <CheckoutFileView
            key={selected.path}
            entry={selected}
            prefix={prefix}
            headSha={worktree.headSha}
            drafts={drafts.filter((d) => d.target.path === selected.path)}
            threads={(threads ?? []).filter((t) => t.target.path === selected.path)}
            pullNumber={pull.number}
            notices={notices}
            error={draftsError}
            threadsError={threadsError}
            onHold={hold}
            onPublish={publish}
            onDiscard={discard}
          />
        ) : (
          <main style={centerMsg}>
            {/*
              * Not "pick a file" before there is a list to pick from — that sentence sends
              * the reader to a column that is still empty, and reads as the answer having
              * already arrived.
              */}
            {changed === null && !changedError ? (
              <LoadingLine>Opening the checkout…</LoadingLine>
            ) : (
              'Pick a changed file to start reading, or open any file in the checkout.'
            )}
          </main>
        )}
      </div>
    </div>
  );
}

/** The path `/__vs/tree/file` and `/__vs/raw` want: the checkout path, re-prefixed. */
export function checkoutPath(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

type CheckoutFileViewProps = {
  entry: TreeEntry;
  prefix: string;
  /** The commit the checkout is at — stamped on every comment held from this file. */
  headSha: string;
  /** This file's held and published comments, in creation order. */
  drafts: ReviewDraft[];
  /** This file's review threads as they are on the pull request, replies included. */
  threads: ReviewThreadRecord[];
  pullNumber: number;
  notices: Record<string, DraftNotice>;
  error: string | null;
  /** Why the conversation could not be read, when it could not. The file still opens. */
  threadsError: string | null;
  onHold: (input: ReviewDraftInput) => Promise<boolean>;
  onPublish: (id: string, force?: boolean) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
};

/**
 * The viewer. Deliberately the two existing read-only surfaces and nothing else — no
 * editor, no save, no local comment panel (R-13.19). `LineSelection` is what the code
 * viewer already reports, and it is what a held comment anchors to (R-13.13): picking a
 * line is reading, and the composer below writes a comment, never the file.
 */
function CheckoutFileView({ entry, prefix, headSha, drafts, threads, pullNumber, notices, error, threadsError, onHold, onPublish, onDiscard }: CheckoutFileViewProps) {
  const path = checkoutPath(prefix, entry.path);
  const { file, loading } = useFile(entry.type === 'dir' ? '' : path, entry.kind);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const content = file && 'content' in file ? file.content : undefined;
  /*
   * MARKDOWN IS READ RENDERED, AND COMMENTED ON RENDERED.
   *
   * An earlier revision solved "the rendered surface has no lines to anchor to" by
   * sending the reviewer to the raw source: `Start commenting` swapped the document for
   * `CodeView` and put a textarea underneath. It worked, and it was the wrong act — this
   * product teaches one way to comment (click the block you mean, write beside it), and a
   * reviewer who had learned it on their own files had to learn a second thing to do the
   * same job on someone else's. The premise was also false: `MarkdownSurface` stamps every
   * block with `data-vs-loc`, so a block selection IS a line range, which is exactly what
   * a draft anchors to. The source view was never carrying information the rendered one
   * lacks — it was only the view that happened to print line numbers.
   *
   * Code and everything else still go through `CodeView` and the line composer below,
   * because those files have no rendered form to click on.
   */
  const rendered = entry.kind === 'markdown';

  const held = drafts.filter((d) => d.status !== 'published');
  const sent = drafts.filter((d) => d.status === 'published');
  /**
   * The group's publish, which is the per-card one applied to each member in turn.
   *
   * Sequential and not `Promise.all`: each call re-reads the drafts afterwards (see
   * `loadDrafts`), and the 409s each one can return — stale, already published — are
   * per-comment answers the reviewer has to be able to read one at a time.
   */
  const publishHeld = async () => {
    for (const draft of held) await onPublish(draft.id);
  };

  /*
   * The panel's half of the rendered surface: this file's drafts, and what a new one does.
   * Built here rather than inside the source module because `onHold` / `onPublish` /
   * `onDiscard` are this component's props — the store lives one level up, with the pull
   * request, not with the file on screen.
   */
  const panelSource = useMemo(
    () =>
      reviewCommentPanelSource({
        path: entry.path,
        headSha,
        drafts,
        threads,
        pullNumber,
        hold: onHold,
        publish: onPublish,
        discard: onDiscard,
        notice: (id) => {
          const n = notices[id];
          if (!n) return null;
          return <DraftNoticeBox notice={n} onPublish={onPublish} draftId={id} />;
        },
      }),
    [entry.path, headSha, drafts, threads, pullNumber, onHold, onPublish, onDiscard, notices],
  );

  const body = (
    <main style={pane}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 36px 120px' }}>
        <div style={crumb}>
          {entry.type === 'dir' ? '📂 ' : ''}
          {entry.path}
          <span style={{ opacity: 0.7 }}> · read-only</span>
        </div>
        {entry.type === 'dir' ? (
          <div style={placeholder}>Folder — pick a file inside it.</div>
        ) : loading ? (
          <LoadingLine />
        ) : entry.kind === 'image' ? (
          <img src={rawUrl(path)} alt={entry.name} style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #e2e8f0' }} />
        ) : content == null ? (
          <div style={placeholder}>No preview for this file.</div>
        ) : rendered ? (
          <div style={mdWrap}>
            <MarkdownSurface source={content} />
          </div>
        ) : (
          <>
            <CodeView content={content} selection={selection} onSelect={setSelection} />
            <DraftComposer
              selection={selection}
              onCancel={() => setSelection(null)}
              onHold={async (comment) => {
                if (!selection) return false;
                const ok = await onHold({
                  path: entry.path,
                  comment,
                  headSha,
                  startLine: selection.startLine,
                  ...(selection.endLine !== selection.startLine ? { endLine: selection.endLine } : {}),
                  ...(selection.snippet ? { snippet: selection.snippet } : {}),
                });
                if (ok) setSelection(null);
                return ok;
              }}
            />
          </>
        )}
        {error && (
          <div data-vs-drafts-error style={{ ...errorLine, padding: '8px 0' }}>
            {error}
          </div>
        )}
        {/*
          * Said out loud rather than rendered as an empty panel. "No comments on this
          * file" and "we could not ask GitHub" look identical when the second one is
          * silent, and the reviewer would read the wrong one — the file that matters is
          * the one somebody has already objected to.
          */}
        {threadsError && (
          <div data-vs-threads-error style={{ ...errorLine, padding: '8px 0' }}>
            The pull request’s comments could not be read — {threadsError}
          </div>
        )}
        {/*
          * The below-document list is the CODE path's only home for its drafts. On a
          * rendered document `CommentPanel` beside it carries the same comments with the
          * same two acts, and printing them twice on one screen would make the two copies
          * look like two sets of comments.
          */}
        {!rendered && drafts.length > 0 && (
          /*
            * R-13.18, SAID ONCE PER GROUP INSTEAD OF ONCE PER CARD.
            *
            * The requirement is that a reviewer never infers a comment's origin from the
            * absence of a control — not that the sentence be repeated. Every card used to
            * carry its own "not sent yet" sentence, which on a file with four held comments
            * printed the same sentence four times and made the provenance read as noise.
            * It is one header per group now, with the send action attached to the group
            * that has something to send; each card still declares its own status in the
            * DOM (`data-vs-draft-status`), so nothing is carried by position alone, and the
            * published group renders whether or not any of its members has a permalink.
            */
          <section data-vs-draft-list style={{ marginTop: 16, display: 'grid', gap: 8 }}>
            <div style={sectionHead}>Review comments on this file</div>
            {held.length > 0 && (
              <div data-vs-draft-origin="local" style={groupHead}>
                <span style={localChip}>{`${held.length} draft${held.length === 1 ? '' : 's'} — not sent yet`}</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => void publishHeld()}
                  style={primaryBtn}
                  title="Post these to the pull request"
                >
                  {held.length === 1 ? 'Send the draft' : `Send all ${held.length}`}
                </button>
              </div>
            )}
            {held.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                notice={notices[draft.id] ?? null}
                onPublish={onPublish}
                onDiscard={onDiscard}
              />
            ))}
            {sent.length > 0 && (
              <div data-vs-draft-origin="github" style={groupHead}>
                <span style={githubChip}>
                  {sent.length} on GitHub · #{sent[0]!.pullNumber}
                </span>
              </div>
            )}
            {sent.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                notice={notices[draft.id] ?? null}
                onPublish={onPublish}
                onDiscard={onDiscard}
              />
            ))}
          </section>
        )}
      </div>
      {/*
        * The overlay hit-tests a click into a block selection, and the markers say which
        * blocks already carry one. Both are the local surface's own components, reading
        * `data-vs-loc` off the same rendered Markdown — R-6.6's one resolver, doing the
        * same job for a third kind of comment.
        */}
      {rendered && <InspectOverlay />}
      {rendered && <IndicatorLayer targets={reviewIndicatorTargets(entry.path, drafts, threads)} />}
    </main>
  );

  if (!rendered) return body;

  /*
   * `surfaceId` namespaces the inspector's selection, and a checkout's file is not the
   * local file of the same name — the reviewer may well have both open across a session.
   * The pull request number is what keeps the two apart.
   */
  return (
    <ActiveCommentProvider>
      <InspectorProvider key={`${prefix}:${entry.path}`} surfaceId={`review:${prefix}:${entry.path}`} pageIndex={0}>
        {body}
        <CommentPanel width={340} source={panelSource} />
      </InspectorProvider>
    </ActiveCommentProvider>
  );
}

/**
 * R-13.14's warning, and its override.
 *
 * Extracted from `DraftCard` because the rendered surface's comment panel shows the same
 * notice on the same draft, and a stale-head warning that appeared on one surface and not
 * the other would let a reviewer send a comment past a check they never saw.
 */
function DraftNoticeBox({
  notice,
  draftId,
  onPublish,
}: {
  notice: DraftNotice;
  draftId: string;
  onPublish: (id: string, force?: boolean) => Promise<void>;
}) {
  return (
    <div data-vs-draft-notice={notice.kind} style={notice.kind === 'error' ? noticeError : notice.kind === 'stale' ? noticeStale : noticeNote}>
      {notice.kind === 'stale' ? (
        <>
          <div>
            Written against <code>{notice.draftHeadSha}</code>; the pull request is now at{' '}
            <code>{notice.currentHeadSha}</code>. Sending it now would anchor it to whatever sits at that line today.
          </div>
          <button type="button" onClick={() => void onPublish(draftId, true)} style={{ ...primaryBtn, marginTop: 6 }}>
            Send anyway
          </button>
        </>
      ) : (
        notice.message
      )}
    </div>
  );
}

/**
 * Write a comment about the selected lines. It exists only while a selection does — there
 * is no idle textarea on a read-only surface, and nothing to type into until the reviewer
 * has said what they are talking about.
 */
function DraftComposer({
  selection,
  onHold,
  onCancel,
}: {
  selection: LineSelection | null;
  onHold: (comment: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!selection) {
    return <p style={{ ...emptyLine, padding: '8px 0' }}>Click a line to comment on it. Shift-click a second line for a range.</p>;
  }
  const range =
    selection.endLine === selection.startLine ? `line ${selection.startLine}` : `lines ${selection.startLine}–${selection.endLine}`;
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onHold(text.trim());
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div data-vs-draft-composer style={composer}>
      <div style={{ font: '12px system-ui', color: '#475569' }}>
        Commenting on <strong>{range}</strong> — held on this machine until you publish it.
      </div>
      <textarea
        aria-label="Review comment"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
        }}
        placeholder="Your review comment (⌘/Ctrl+Enter)…"
        style={composerText}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" onClick={onCancel} style={backBtn}>
          Cancel
        </button>
        <button type="button" disabled={!text.trim() || busy} onClick={submit} style={primaryBtn}>
          <BusyLabel busy={busy}>{busy ? 'Saving…' : 'Save draft'}</BusyLabel>
        </button>
      </div>
    </div>
  );
}

/** The line a held comment names, said the way the reviewer selected it. */
function anchorLabel(draft: ReviewDraft): string {
  const { target } = draft;
  if (target.kind === 'file' || typeof target.startLine !== 'number') return '(whole file)';
  return target.endLine ? `L${target.startLine}–${target.endLine}` : `L${target.startLine}`;
}

/**
 * One comment. Where it lives is stated by the group header above it (R-13.18) rather than
 * by a chip repeated on every card, and by `data-vs-draft-status` here.
 *
 * The grouping is driven by `status`, which is the record's own account of itself, and not
 * by whether a link or a button happens to be renderable — that was the original point of
 * the chip and it survives the move. A published comment whose permalink is missing still
 * sits under "on GitHub"; it simply has no link to offer.
 */
function DraftCard({
  draft,
  notice,
  onPublish,
  onDiscard,
}: {
  draft: ReviewDraft;
  notice: DraftNotice | null;
  onPublish: (id: string, force?: boolean) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
}) {
  const published = draft.status === 'published';
  return (
    <div data-vs-draft={draft.id} data-vs-draft-status={draft.status} style={draftCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ font: '11px ui-monospace, monospace', color: '#64748b' }}>{anchorLabel(draft)}</span>
        <span style={{ font: '11px ui-monospace, monospace', color: '#94a3b8' }}>at {draft.headSha.slice(0, 7)}</span>
      </div>
      <div style={{ margin: '6px 0', font: '13px system-ui', color: '#0f172a', overflowWrap: 'anywhere' }}>{draft.comment}</div>

      {notice && <DraftNoticeBox notice={notice} draftId={draft.id} onPublish={onPublish} />}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        {published ? (
          draft.published?.htmlUrl && (
            <a href={draft.published.htmlUrl} target="_blank" rel="noreferrer" style={linkBtn}>
              Open on GitHub
            </a>
          )
        ) : (
          <>
            {/*
              * Discard throws the comment away and Send puts it on the pull request, so they must not
              * look like the same kind of act. The destructive one wears the destructive
              * colour and names what it destroys for anything reading the accessible name.
              */}
            <button
              type="button"
              onClick={() => void onDiscard(draft.id)}
              title={`Discard the comment on ${anchorLabel(draft)} — it is not on GitHub, so this is the end of it`}
              style={dangerBtn}
            >
              Discard
            </button>
            <button type="button" onClick={() => void onPublish(draft.id)} style={primaryBtn}>
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// P4 — `nowrap`, deliberately: wrapping would push the identity onto a second line, which
// is the two-row problem this row exists to end. It truncates instead.
const banner: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap', padding: '10px 16px', borderBottom: '1px solid #e5e7eb', background: '#fffbeb', font: '13px system-ui', color: '#334155' };
/** P4 — the one element that may shrink, and the ellipsis can only reach the title. */
const pullIdentity: React.CSSProperties = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 };
const identityLine: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
/** Provenance, in the row's own monospace so the author and the sha line up as facts. */
const identityMeta: React.CSSProperties = { font: '11px ui-monospace, monospace', color: '#92766a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
/** A link, dressed as one: the two neighbours are buttons and this must not read as a third. */
const ghLink: React.CSSProperties = { flexShrink: 0, font: '12px system-ui, sans-serif', color: '#92400e', textDecoration: 'underline' };
const readOnlyChip: React.CSSProperties = { flexShrink: 0, font: '600 10px system-ui', padding: '2px 8px', borderRadius: 99, border: '1px solid #fcd34d', background: '#fef3c7', color: '#92400e' };
const backBtn: React.CSSProperties = { flexShrink: 0, font: '12px system-ui, sans-serif', padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#334155', cursor: 'pointer' };
const sidebar: React.CSSProperties = { width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #e5e7eb', background: 'white', overflow: 'hidden' };
const sectionHead: React.CSSProperties = { padding: '10px 12px 6px', font: '700 11px system-ui', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 };
/** P7 — the changed files lead, so their heading is the heavy one on the sidebar. */
const leadHead: React.CSSProperties = { padding: '12px 12px 2px', font: '700 13px system-ui', color: '#0f172a' };
const leadNote: React.CSSProperties = { padding: '0 12px 6px', font: '11px system-ui', color: '#64748b' };
/** The count, in violet, and never the colour on its own — the numeral is the message. */
/** The whole second half of R-13.11, folded into the line that says what it is for. */
const restToggle: React.CSSProperties = { flexShrink: 0, display: 'block', width: 'calc(100% - 12px)', margin: '10px 6px 0', textAlign: 'left', padding: '8px 8px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#f8fafc', color: '#64748b', font: '11px system-ui', lineHeight: 1.45, cursor: 'pointer' };
const restBody: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, paddingTop: 8 };
const filterInput: React.CSSProperties = { margin: '0 12px 6px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: '12px system-ui' };
const emptyLine: React.CSSProperties = { padding: '4px 12px', font: '12px system-ui', color: '#94a3b8' };
const errorLine: React.CSSProperties = { padding: '4px 12px', font: '12px system-ui', color: '#b91c1c' };
const pane: React.CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto', background: '#f8fafc' };
const crumb: React.CSSProperties = { font: '12px ui-monospace, monospace', color: '#64748b', marginBottom: 12 };
const mdWrap: React.CSSProperties = { background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 24px' };
const placeholder: React.CSSProperties = { padding: '48px 24px', textAlign: 'center', color: '#64748b', background: 'white', border: '1px dashed #cbd5e1', borderRadius: 12 };
const centerMsg: React.CSSProperties = { flex: 1, display: 'grid', placeItems: 'center', opacity: 0.6, font: '13px system-ui' };
const tallyChip: React.CSSProperties = { flexShrink: 0, font: '600 10px system-ui', padding: '2px 8px', borderRadius: 99, border: '1px solid #cbd5e1', background: 'white', color: '#475569' };
const composer: React.CSSProperties = { display: 'grid', gap: 6, marginTop: 10, padding: 10, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8 };
const composerText: React.CSSProperties = { width: '100%', height: 70, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: '13px system-ui', resize: 'vertical', boxSizing: 'border-box' };
const primaryBtn: React.CSSProperties = { padding: '4px 12px', border: '1px solid #2563eb', borderRadius: 4, background: '#2563eb', color: 'white', cursor: 'pointer', font: '12px system-ui' };
const linkBtn: React.CSSProperties = { padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#1d4ed8', font: '12px system-ui', textDecoration: 'none' };
const draftCard: React.CSSProperties = { padding: 10, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8 };
/** R-13.18 — one header per group, and both groups say a sentence rather than a colour. */
const groupHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 };
/** Destructive, and visibly not the same kind of thing as the button beside it. */
const dangerBtn: React.CSSProperties = { padding: '4px 12px', border: '1px solid #fecaca', borderRadius: 4, background: 'white', color: '#dc2626', cursor: 'pointer', font: '12px system-ui' };
const chipBase: React.CSSProperties = { font: '600 10px system-ui', padding: '2px 8px', borderRadius: 99, whiteSpace: 'nowrap' };
const localChip: React.CSSProperties = { ...chipBase, border: '1px solid #fcd34d', background: '#fef3c7', color: '#92400e' };
const githubChip: React.CSSProperties = { ...chipBase, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534' };
const noticeBase: React.CSSProperties = { margin: '0 0 6px', padding: 8, borderRadius: 6, font: '12px system-ui', lineHeight: 1.5 };
const noticeStale: React.CSSProperties = { ...noticeBase, border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e' };
const noticeError: React.CSSProperties = { ...noticeBase, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c' };
const noticeNote: React.CSSProperties = { ...noticeBase, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8' };
