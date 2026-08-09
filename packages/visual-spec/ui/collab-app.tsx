/**
 * collab-app.tsx — task U-1, mounts the collaboration surface App.tsx swaps to.
 *
 * SCOPE. The reviewer half of the round trip. A reviewer pastes a PR reference +
 * document id (`CollabOpenPanel`), the Markdown on the Pull Request branch renders
 * through the shared `MarkdownSurface` (R-7.3), and the real `CommentPanel` runs beside
 * it: read, create, reply. Authoring and publish are the author's surface, not this one.
 *
 * WHY THIS IS ITS OWN TOP-LEVEL ROUTE, NOT A `TreeEntry`. App.tsx's `selected` is a
 * `TreeEntry` enumerated by `ui/use-tree.ts` from the local file tree; a collaboration
 * document has no such entry. Faking one would feed it through `isMarkdown`, which
 * assumes local-file semantics. So App.tsx swaps its whole shell for this component
 * instead of stretching `selected`/`mode` to cover a second kind of thing.
 *
 * WHY THE REVIEW SURFACE IS THE MARKDOWN SURFACE (R-7.3 / R-6.6). It stamps every
 * rendered block with `data-vs-loc`, which is the position a review comment is anchored
 * by (R-0.3), so the shared resolver locates a collaborative comment exactly as it
 * locates a local one. Rendering it any other way would need a second resolver, and the
 * two would disagree the first time a block moved.
 *
 * An earlier revision hand-rolled a read-only comment list here, on the reasoning that
 * `CommentPanel` calls `useInspector()` and would drag in comment creation. Creation is
 * now wanted, and `InspectorProvider` turns out to be document-agnostic — it needs only
 * a `surfaceId` — so the real panel is mounted and the parallel list is gone.
 *
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InspectOverlay, InspectorProvider } from '../core/app';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
// From the pure module, not `failure-states`: that one reaches `cache-lifecycle` and
// `node:fs/promises`, which the browser bundle cannot resolve.
import { deriveReadiness, type ReadinessVerdict } from '../core/collaboration/readiness';
import { buildApplyPrompt } from '../core/editing/apply-prompt';
import type { CommentRecord } from '../core/editing/comment-doc';
import { collabCommentPanelSource, collabIndicatorTargets } from './collab-comment-source';
import type { MountedWorktree, PullRequestSummary } from './collab-client';
import { CollabEditor, type CollabEditorHandle } from './collab-editor';
import { CollabOpenPanel } from './collab-open-panel';
import { CollabPrReview } from './collab-pr-review';
import { CollabPullsPanel, shortSha } from './collab-pulls-panel';
import { ActiveCommentProvider } from './active-comment';
import { BusyLabel, LoadingLine } from './spinner';
import { CommentPanel, type CommentPanelSource } from './comment-panel';
import { IndicatorLayer } from './indicator-layer';
import { MarkdownSurface } from './markdown-surface';
import { useCollabDocument } from './use-collab-document';

/**
 * WHY THE TWO MODES ARE A TOGGLE AND NOT ONE SURFACE.
 *
 * Comments are anchored to rendered blocks by `data-vs-loc`, and the source editor shows
 * Markdown text rather than rendered blocks — so a panel mounted beside it would have
 * nothing to point at. The author edits in one mode and works comments in the other: the
 * same document, two views of it.
 */
type PaneMode = 'review' | 'edit';

/**
 * The open document, kept in the URL rather than only in memory.
 *
 * It was `useState` alone, so any reload — F5, a crashed tab, the dev server restarting —
 * lost it, and the only route back to the document was `open`, which refreshes from the
 * branch. That is fine for a stale copy and catastrophic while an agent's applied changes
 * are still unpublished, since they live nowhere else. The refusal in `open` (R-11.7) is
 * what makes that safe; this is what makes it rare, by not forcing the trip in the first
 * place.
 */
const DOCUMENT_PARAM = 'vsdoc';

/**
 * The pull request being *read*, kept in the URL for the same reason `vsdoc` is.
 *
 * The original note here argued a checkout needed no such treatment: "remounting it is one
 * click and no loss". Both halves stopped being true. The way in is now the sidebar, the
 * drawer and a row — not one click — and a reviewer arrives at a reload holding review
 * drafts, a scrolled file tree and an open document, all of which a bounce to the file
 * view throws away. The checkout itself is still cheap to rebuild, which is exactly why
 * restoring it is safe: `mount` moves the existing worktree rather than recreating it
 * (R-13.12), so the recovery costs one idempotent call.
 *
 * It stores the NUMBER and not the worktree. The worktree is a path and a sha that git
 * owns and can move between one load and the next; the number is the only part of a review
 * that is stable, and re-mounting is what turns it back into the rest.
 */
const PULL_PARAM = 'vspr';

function documentFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(DOCUMENT_PARAM);
}

function rememberInUrl(documentId: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (documentId) url.searchParams.set(DOCUMENT_PARAM, documentId);
  else url.searchParams.delete(DOCUMENT_PARAM);
  window.history.replaceState(null, '', url);
}

function rememberPullInUrl(pullNumber: number | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (pullNumber !== null) url.searchParams.set(PULL_PARAM, String(pullNumber));
  else url.searchParams.delete(PULL_PARAM);
  window.history.replaceState(null, '', url);
}

/**
 * Forget whatever the URL was reopening.
 *
 * `← Files` is a statement that the reviewer is done with this surface, and leaving the
 * parameters behind would make the next reload drag them back to it. The document pane
 * clears `vsdoc` through `setDocumentId(null)` on its own paths; this covers the exits
 * that go around it, which is every one that leaves the surface entirely.
 */
export function clearCollabUrl(): void {
  rememberInUrl(null);
  rememberPullInUrl(null);
}

/**
 * What a cold load should reopen, read off the URL — or `null` for the file view.
 *
 * `App.tsx` calls this for its initial state, because the decision to be on the
 * collaboration surface at all is its own; `CollabApp` then reads `vsdoc` again for the
 * document. The document wins over the pull request: a document open on a pull request is
 * the more specific place to be, and is the one that can hold unpublished work.
 */
export function intentFromUrl(): CollabIntent | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const documentId = params.get(DOCUMENT_PARAM);
  if (documentId) return { documentId };
  const raw = params.get(PULL_PARAM);
  const pull = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(pull) && pull > 0 ? { reviewPull: pull } : null;
}

/**
 * The Pull Request whose code is being read (Unit 13), if any.
 *
 * Held here and not in the URL, unlike `documentId`. The reason `documentId` is in the
 * URL is that a document can carry unpublished local work that only `open` could refetch;
 * a checkout carries none — it is a detached copy of a commit, and remounting it is one
 * click and no loss. So the cheaper state is the honest one.
 */
type PullReview = { pull: PullRequestSummary; worktree: MountedWorktree };

/**
 * The surface's own header, and — R-9.1 — which pull request is on screen.
 *
 * An earlier draft made the *main* header mode-aware instead. `ui/App.tsx` returns this
 * component early, so that header is not rendered during a review at all and the draft's
 * premise was false. The number and the commit come from `pullReview`, which this
 * component already holds, so nothing is read and no state crosses a surface boundary
 * (R-9.4).
 *
 * NO BRANCH IS NAMED (R-9.2), the pull request's head branch included. The tree on screen
 * is checked out `--detach` at a commit (R-13.6) and is on no branch; naming one would
 * describe something other than the thing being displayed. The commit is the worktree's
 * own `headSha`, not the pull request record's, for the same reason — they diverge the
 * moment the pull request is pushed to while the checkout stays where it was mounted.
 *
 * IT STANDS DOWN WHILE A PULL REQUEST IS UNDER REVIEW. This header and `CollabPrReview`'s
 * own banner both said the number, both said the sha and both said "read-only", stacked
 * one on top of the other. Two rows about one subject is not two pieces of information.
 * `CollabApp` renders only one of them, and the survivor is the review banner, because it
 * is the row that can also say *what* the pull request is. R-9.1 … R-9.4 move with it and
 * are asserted there; the `review` prop stays because those obligations are this
 * component's contract wherever it is the row on screen, and dropping it would leave the
 * requirement expressed nowhere as a component boundary.
 */
export function CollabHeader({ onExit, review }: { onExit: () => void; review: PullReview | null }) {
  return (
    <header style={bar}>
      <button type="button" onClick={onExit} style={backBtn}>
        ← Files
      </button>
      <span style={title}>Collaboration review</span>
      {review && (
        <span data-testid="vs-review-pull" data-vs-review-pull={review.pull.number} style={reviewChip}>
          #{review.pull.number} · at {shortSha(review.worktree.headSha)} · read-only
        </span>
      )}
    </header>
  );
}

/**
 * Where to land when the surface opens, for a caller that already knows (R-7.7 / R-7.8).
 *
 * The header's pull request list has both answers in hand — the document id the server
 * resolved, or the pull request number to check out — and sending the user to the entry
 * panels to find the same row a second time is the "full-surface swap you have to know
 * exists" that Unit 7 exists to remove. An empty intent is the sidebar link, which
 * knows nothing more.
 *
 * A `review` is a pull request the caller has ALREADY checked out — `CollabDrawer` runs
 * the same mount button the landing page ran, so by the time the drawer closes git has
 * done the work and the worktree is in hand. It is carried rather than reduced to
 * `reviewPull` because that arm re-runs the mount route: a second checkout of a commit
 * that is already on disk, and a visible pause between clicking and reading.
 */
export type CollabIntent = {
  documentId?: string;
  reviewPull?: number;
  review?: { pull: PullRequestSummary; worktree: MountedWorktree };
};

export function CollabApp({ onExit, initial }: { onExit: () => void; initial?: CollabIntent }) {
  // The URL still wins where no intent named a document: a reload during a review must
  // come back to the same document, and that is what `vsdoc` is for.
  const [documentId, setDocumentIdState] = useState<string | null>(() => initial?.documentId ?? documentFromUrl());
  const [pullReview, setPullReview] = useState<PullReview | null>(() => initial?.review ?? null);
  /** True while `?vspr=n` has neither opened its review nor been reported unopenable. */
  const [deepLinkPending, setDeepLinkPending] = useState(initial?.reviewPull !== undefined);
  const setDocumentId = useCallback((id: string | null) => {
    setDocumentIdState(id);
    rememberInUrl(id);
  }, []);

  // An intent-opened document is in state but not yet in the URL, so a reload would
  // lose it — the one thing `vsdoc` exists to prevent.
  const opened = initial?.documentId;
  useEffect(() => {
    if (opened) rememberInUrl(opened);
  }, [opened]);

  // The same contract for the checkout: whichever pull request is on screen is the one the
  // URL names, and leaving the review takes it back out.
  const reviewedPull = pullReview?.pull.number ?? null;
  useEffect(() => {
    rememberPullInUrl(reviewedPull);
  }, [reviewedPull]);

  // P5 — one row, not two. While a checkout is on screen `CollabPrReview` renders the row
  // that carries the number, the mounted commit and the read-only statement (R-9.1 …
  // R-9.4) *and* names the pull request, so this header would only repeat it.
  const reviewing = !documentId && pullReview !== null;

  return (
    <>
      {/* A document is not a pull request review, so the header claims none while one is open. */}
      {!reviewing && <CollabHeader onExit={onExit} review={null} />}
      {documentId ? (
        <CollabDocumentPane documentId={documentId} />
      ) : pullReview ? (
        <CollabPrReview
          key={pullReview.pull.number}
          pull={pullReview.pull}
          worktree={pullReview.worktree}
          /*
           * Where "back" goes depends on where the reviewer came from, and the button says
           * `← Pull requests` either way — so both arms have to land on a list. A checkout
           * handed in by `CollabDrawer` was picked from a panel this component does not
           * own, so it hands the exit up and `App.tsx` reopens the drawer; one picked from
           * the landing page below returns to it here.
           */
          onExit={initial?.review ? onExit : () => setPullReview(null)}
        />
      ) : (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {/*
            * Two entries, and they answer different questions — but they no longer answer
            * them in the wrong order. `CollabOpenPanel` used to lead, asking for a pull
            * request URL and a document id typed by hand; `CollabPullsPanel` came third and
            * already had both, for every open pull request, as buttons. Since the server
            * resolves `documentId` from the pull request body (R-7.4), the list is the
            * primary path and the form is the fallback for a pull request that is not in
            * this repository's listing.
            *
            * R-7.8 — a pull request named by the header is checked out through the panel's
            * own mount path rather than through a second one written here. It is the same
            * button the reviewer would have pressed, pressed for them.
            */}
          <CollabPullsPanel
            onReview={(pull, worktree) => setPullReview({ pull, worktree })}
            onResume={setDocumentId}
            {...(initial?.reviewPull !== undefined ? { autoReview: initial.reviewPull } : {})}
            onAutoReviewFailed={() => setDeepLinkPending(false)}
          />
          {/*
            * The rest of the landing page is withheld while a deep link is still opening.
            * `?vspr=2` names one pull request; a list of every other one, and a form for
            * opening a third, are answers to questions the URL did not ask — and the panel
            * above is already saying which one it is fetching. Both come back the moment
            * the deep link fails, because then the list IS the next thing to do.
            */}
          {!deepLinkPending && (
            <>
              <hr style={sectionRule} />
              <CollabOpenPanel onOpened={setDocumentId} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function CollabDocumentPane({ documentId }: { documentId: string }) {
  const { document, fullDocument, comments, loading, error, addComment, replyToComment, reload, publish } =
    useCollabDocument(documentId);
  // The rendered document, for layout only: anchor resolution finds the markdown surface
  // by `[data-inspector-root]`, which is inside this element and stable across renders —
  // whereas `docRoot.current` is null on the first one.
  const docRoot = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<PaneMode>('review');
  const editor = useRef<CollabEditorHandle | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Non-null while a publish is staged and awaiting the author's confirmation. */
  const [staged, setStaged] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  /**
   * R-8.15 / R-8.25 — unresolved threads block publishing, and so do threads whose
   * resolution GitHub could not tell us (R-8.26 — nothing local may declare Ready).
   * `deriveLifecycleState` also decides `merged` / `closed` / `conflicted`, but those arms
   * need the Pull Request's `state` / `merged` / `mergeable`, which no route hands the
   * browser today. Gating on the half we can actually derive is honest; claiming the other
   * half would not be.
   */
  const readiness = useMemo(() => deriveReadiness(comments.filter(isThread)), [comments]);

  /** R-5.10 — publishing is initiated by a person. This runs from a click, never a hook. */
  const stagePublish = useCallback(() => {
    setPublishError(null);
    const handle = editor.current;
    if (!handle) return;
    setStaged(handle.publish().markdown);
  }, []);

  const confirmPublish = useCallback(async () => {
    if (staged === null) return;
    setPublishing(true);
    setPublishError(null);
    const result = await publish({ markdown: staged });
    setPublishing(false);
    if (!result.ok) {
      // R-11.4 — the server's own words.
      setPublishError(result.message);
      return;
    }
    // The published state is now the clean baseline, so the editor stops reporting dirty.
    editor.current?.markClean();
    setStaged(null);
    setMode('review');
  }, [publish, staged]);

  const [handoff, setHandoff] = useState<string | null>(null);

  /*
   * R-5.10 — hand the open comments to an agent, and stop there.
   *
   * The prompt itself has existed and been tested since task 5.x with no caller at all,
   * so nothing in the app could ever ask an agent to act on a pull request's comments.
   * This is the caller, and it is deliberately the smallest one that closes the loop:
   * the prompt goes to the clipboard and the author runs it in their own session, the
   * way the local surface's "Copy prompt" already works. No route, no process, no
   * activity stream — those are worth building once the prompt is known to be good.
   *
   * THE PATH IS `documentPath`, and under Markdown-canonical that is the only path there
   * is. `fsCollaborationStore` writes the document at `<contentDir>/<documentPath>` and
   * the agent runs with that directory as its cwd, so the file it opens is the file under
   * review — the same bytes the branch holds. `core/bundle-guard.test.ts` asserts the two
   * directories are one variable in each host, because a drift there sends the agent to a
   * file that is not there — or worse, to one that is.
   */
  const copyHandoff = useCallback(async () => {
    /*
     * `status` is the LOCAL apply-agent flag (R-5.21) — whether this agent has already
     * acted — and is deliberately NOT GitHub's resolution. A thread resolved on github.com
     * still reads `open` here, because nothing local has acted on it yet. That is the same
     * predicate the panel lists on, so the two surfaces cannot disagree about what counts.
     */
    if (!fullDocument) return;
    const open = comments.filter((c) => c.status === 'open');
    const prompt = buildApplyPrompt(open, { mode: 'collab', documentPath: fullDocument.documentPath });
    try {
      await navigator.clipboard.writeText(prompt);
      setHandoff(`Copied — ${open.length} open comment${open.length === 1 ? '' : 's'}. Run it where the specs directory is.`);
    } catch (err) {
      setHandoff((err as Error).message);
    }
  }, [comments, fullDocument]);

  const source = useMemo<CommentPanelSource | null>(
    () =>
      fullDocument
        ? collabCommentPanelSource({
            document: fullDocument,
            comments,
            add: addComment,
            reply: replyToComment,
          })
        : null,
    [fullDocument, comments, addComment, replyToComment],
  );

  if (loading) {
    return (
      <main style={centerMsg}>
        <LoadingLine />
      </main>
    );
  }
  if (error) {
    // R-11.4 — the server's own words, not a generic failure.
    return <main style={centerMsg}>{error.message}</main>;
  }
  if (!fullDocument || !document || !source) {
    return <main style={centerMsg}>Document not found.</main>;
  }

  return (
    // `surfaceId` namespaces the inspector's selection state. A collaboration document
    // is not a local file, so it gets its own scheme rather than borrowing `toSurfaceId`.
    <InspectorProvider key={documentId} surfaceId={`collab:${documentId}`} pageIndex={0}>
      {/*
        * Clicking an inline indicator is supposed to focus its row in the sidebar, and the
        * shaded area is supposed to brighten with it (R-2.1 / R-2.2). Both read the active
        * id from this context, and only `markdown-editor.tsx` was mounting the provider —
        * so collaboration ran on the default context, whose `setActiveId` is an empty
        * function. Every click on a marker did precisely nothing, silently.
        */}
      <ActiveCommentProvider>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={docPane}>
          <div style={docTitleBar}>
            {/*
              * P4 — the title used to run underneath the buttons beside it. A flex child
              * defaults to `min-width: auto`, which means "never shrink below your own
              * content", so the title simply overflowed its lane and slid under `Edit` /
              * `Copy agent prompt` / `Reload`. `minWidth: 0` lets it shrink and the
              * ellipsis takes the tail; the pull request reference is a separate,
              * unshrinkable element, so the identifying part is never what gets cut.
              */}
            <strong style={docTitleText} title={document.title}>
              {document.title}
            </strong>
            {document.github?.pullNumber !== undefined && (
              <span data-vs-doc-pull style={docPullRef}>
                · {document.github.owner}/{document.github.repo}#{document.github.pullNumber}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => setMode(mode === 'review' ? 'edit' : 'review')}
              disabled={mode === 'edit' && dirty}
              title={mode === 'edit' && dirty ? 'Publish or discard your changes first' : undefined}
              style={backBtn}
            >
              {mode === 'review' ? 'Edit' : 'Review'}
            </button>
            {mode === 'review' && (
              <>
                {/*
                  * Review mode only, and that is a safety property rather than a layout
                  * choice. The editor seeds its tree from `fullDocument` on mount, so an
                  * author sitting in edit mode while an agent rewrites the JSON on disk
                  * would publish the copy they loaded and drop the agent's work without
                  * a word. Handing work out from the read-only view, and reloading into
                  * it, keeps those two writers apart.
                  */}
                <button type="button" onClick={() => void copyHandoff()} style={backBtn} title="Copy the prompt that hands the open comments to an agent">
                  Copy agent prompt
                </button>
                <button type="button" onClick={() => void reload()} style={backBtn} title="Re-read the document from disk — an agent's edits land there">
                  Reload
                </button>
              </>
            )}
            {mode === 'edit' && (
              <button
                type="button"
                onClick={stagePublish}
                disabled={!dirty || !readiness.ready}
                title={publishBlockedReason(dirty, readiness)}
                style={publishBtn}
              >
                Publish
              </button>
            )}
          </div>
          {handoff && (
            <div style={handoffNote} data-vs-handoff>
              {handoff}
            </div>
          )}
          {/* R-8.25 — the verdict names its own reason, unknown resolution included. */}
          {mode === 'edit' && !readiness.ready && <div style={blockedBanner}>{readiness.reason}</div>}
          {/*
            * R-7.5's create path ends here. `CommentPanel` reads the inspector's selection
            * and `collabCommentPanelSource` turns the selected element into a `nodeId`, but
            * nothing was ever putting a selection there: the overlay that hit-tests clicks
            * is mounted by the local markdown surface only, so the panel sat on "Click a
            * block in the spec to comment on it" forever and no reviewer could open a
            * thread from the browser. Review mode only — in edit mode the blocks belong to
            * Lexical and a click is a caret move, not a selection.
            */}
          {mode === 'review' && <InspectOverlay />}
          {/*
            * R-6.2 — the markers that show which blocks carry a comment. `collabIndicatorTargets`
            * was built and tested against a real `IndicatorLayer`, but only `markdown-editor.tsx`
            * ever mounted that layer, so in the running app a collaboration document showed none:
            * the sidebar listed four comments and not one of them pointed at a block. Review mode
            * only, because the markers pin to `[data-vs-node-id]` and Lexical never puts those in
            * the DOM — the same reason the two modes are a toggle (see the note at the top).
            *
            * No root is passed on purpose. `docRoot.current` is null on the first render, and
            * `findCollabBlock` treats an explicit null as "nowhere" rather than falling back, so
            * every marker would resolve to null until something re-rendered. The default searches
            * the document, which is safe here because the selector carries the document id.
            */}
          {mode === 'review' && <IndicatorLayer targets={collabIndicatorTargets(fullDocument, comments)} />}
          <div ref={docRoot} style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 56px 120px' }}>
            {mode === 'review' ? (
              <MarkdownSurface source={fullDocument.markdown} />
            ) : (
              <CollabEditor
                document={fullDocument}
                onDirtyChange={setDirty}
                onEditorReady={(handle) => {
                  editor.current = handle;
                }}
              />
            )}
          </div>
        </main>
        {mode === 'review' && <CommentPanel width={340} source={source} />}
      </div>
      </ActiveCommentProvider>
      {staged !== null && (
        <PublishConfirm busy={publishing} error={publishError} onCancel={() => setStaged(null)} onConfirm={confirmPublish} />
      )}
    </InspectorProvider>
  );
}

/**
 * The comment route answers projected review threads, but `CollabClient` types them as the
 * wider `CommentRecord`, so the narrowing has to happen somewhere. It happens here rather
 * than with a cast because the predicate is also the right product rule: a record with no
 * `github` is not a GitHub review thread, so it has no resolution state and cannot be the
 * thing standing between an author and a publish.
 */
function isThread(comment: CommentRecord): comment is ReviewThreadRecord {
  // The base record does not declare this at all — it is the projection's own addition —
  // so the check reads it through a widened view.
  return typeof (comment as Partial<ReviewThreadRecord>).github?.reviewCommentId === 'number';
}

/** Names the blocking reason rather than leaving a disabled control unexplained. */
function publishBlockedReason(dirty: boolean, readiness: ReadinessVerdict): string | undefined {
  // R-8.25 — including "resolution unknown", which must never read as "unresolved".
  if (!readiness.ready) return readiness.reason;
  if (!dirty) return 'No changes to publish';
  return undefined;
}

/**
 * The confirmation before an irreversible-ish remote write.
 *
 * There is deliberately no "these things cannot be expressed in Markdown" list. That
 * panel existed because publish *derived* Markdown from a canonical JSON document and
 * some node types did not survive the trip. Markdown is now the document (R-0.1): the
 * bytes committed are the bytes the author edited, so there is no derivation and nothing
 * to lose in it. A loss list here would be reporting a step that no longer happens.
 */
function PublishConfirm({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div role="dialog" aria-label="Confirm publish" style={dialogScrim}>
      <div style={dialogCard}>
        <strong>Publish to the branch?</strong>
        <p style={dialogBody}>The Markdown you edited is committed to the pull request branch, byte for byte.</p>
        {error && <p style={dialogError}>{error}</p>}
        <div style={dialogActions}>
          <button type="button" onClick={onCancel} disabled={busy} style={backBtn}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} style={publishBtn}>
            <BusyLabel busy={busy}>{busy ? 'Publishing…' : 'Publish'}</BusyLabel>
          </button>
        </div>
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 18px',
  borderBottom: '1px solid #e5e7eb',
  background: 'linear-gradient(180deg, #ffffff 0%, #fbfaff 100%)',
};
const backBtn: React.CSSProperties = {
  font: '12px system-ui, sans-serif',
  padding: '4px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  background: 'white',
  color: '#334155',
  cursor: 'pointer',
  // P4 — a control keeps its size and its touch target; the title beside it is what gives.
  flexShrink: 0,
};
const title: React.CSSProperties = { fontWeight: 700, color: '#334155' };
/** Same read-only chip vocabulary the review banner uses, so the two read as one surface. */
const reviewChip: React.CSSProperties = {
  font: '600 10px ui-monospace, monospace',
  padding: '2px 8px',
  borderRadius: 99,
  border: '1px solid #fcd34d',
  background: '#fef3c7',
  color: '#92400e',
};
const sectionRule: React.CSSProperties = { border: 0, borderTop: '1px solid #e5e7eb', margin: '4px 12px', maxWidth: 720 };
const centerMsg: React.CSSProperties = { flex: 1, display: 'grid', placeItems: 'center', opacity: 0.6 };
const docPane: React.CSSProperties = { flex: 1, minWidth: 0, position: 'relative', overflow: 'auto', background: '#f8fafc' };
const docTitleBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '14px 56px 0',
  font: '14px system-ui',
  color: '#334155',
};
/** P4 — the one element allowed to shrink, and the only one an ellipsis may touch. */
const docTitleText: React.CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const docPullRef: React.CSSProperties = { flexShrink: 0, opacity: 0.6, font: '12px ui-monospace, monospace' };

const publishBtn: React.CSSProperties = {
  padding: '4px 14px',
  borderRadius: 6,
  border: '1px solid #2563eb',
  background: '#2563eb',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  flexShrink: 0,
};

const blockedBanner: React.CSSProperties = {
  padding: '8px 24px',
  background: '#fef3c7',
  borderBottom: '1px solid #fcd34d',
  fontSize: 12,
  color: '#92400e',
};

const dialogScrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 50,
};

const dialogCard: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: 24,
  maxWidth: 520,
  maxHeight: '70vh',
  overflow: 'auto',
  boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
};

const dialogBody: React.CSSProperties = { fontSize: 13, lineHeight: 1.5 };
const dialogError: React.CSSProperties = { fontSize: 12, color: '#b91c1c' };
const dialogActions: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 };

/** The one-line receipt after handing work to an agent. Same lane as the blocked banner. */
const handoffNote: React.CSSProperties = {
  margin: '0 56px',
  padding: '6px 10px',
  border: '1px solid #c7d2fe',
  borderRadius: 6,
  background: '#eef2ff',
  color: '#3730a3',
  font: '12px system-ui',
};
