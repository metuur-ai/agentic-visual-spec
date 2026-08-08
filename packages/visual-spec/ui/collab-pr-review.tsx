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
 * R-13.18 IS A LABEL, NOT AN INFERENCE. Every comment card carries a chip that says where
 * it lives — "Local draft" or "On GitHub · #n" — and the published chip renders even when
 * the permalink is missing. A reviewer must never have to read the absence of a button.
 *
 * IT IMPORTS ONLY TYPES FROM `core/`. `worktree.ts` reads `node:fs/promises`; the one
 * thing needed from it here is the shape of a mounted worktree and the shape of its
 * path, and the path convention is re-declared below rather than imported.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { CodeView, type LineSelection } from './code-view';
import {
  type MountedWorktree,
  type PullRequestSummary,
  type ReviewDraft,
  type ReviewDraftInput,
  createCollabClient,
} from './collab-client';
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
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, DraftNotice>>({});

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

  const noticeFor = (id: string, notice: DraftNotice | null) =>
    setNotices((prev) => {
      const next = { ...prev };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });

  /** R-13.13 — hold the comment. Nothing reaches GitHub until someone presses Publish. */
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
  const publishedCount = drafts.length - heldCount;

  const checkout = useMemo(() => entriesUnder(entries, prefix), [entries, prefix]);
  const byPath = useMemo(() => new Map(checkout.map((e) => [e.path, e])), [checkout]);

  /**
   * R-13.12 — the changed paths and the checkout must name the same commit. Both were
   * taken at the mount, and the head is re-read on every reload, so a changed file that
   * the checkout does not have is reported as such instead of opening nothing.
   */
  const open = (path: string) =>
    setSelected(byPath.get(path) ?? { path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file', kind: 'text' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div data-vs-pr-readonly style={banner}>
        <button type="button" onClick={onExit} style={backBtn}>
          ← Pull requests
        </button>
        <strong>
          #{pull.number} {pull.title}
        </strong>
        <span style={bannerMeta}>
          {pull.headBranch} → {pull.baseBranch} · at {pull.headSha.slice(0, 7)}
        </span>
        <span style={readOnlyChip}>Read-only checkout — no commit, push or merge</span>
        {drafts.length > 0 && (
          <span data-vs-draft-tally style={tallyChip}>
            {heldCount} held locally · {publishedCount} on GitHub
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            invalidateTree();
            reload();
          }}
          style={backBtn}
        >
          Refresh files
        </button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav style={sidebar}>
          <div style={sectionHead}>
            Changed files{changed ? ` (${changed.length})` : ''}
          </div>
          {changedError && (
            <div data-vs-pr-changed-error style={errorLine}>
              {changedError}
            </div>
          )}
          <ul style={listReset}>
            {(changed ?? []).map((path) => (
              <li key={path}>
                <button
                  type="button"
                  onClick={() => open(path)}
                  title={path}
                  style={{ ...changedRow, ...(selected?.path === path ? rowActive : {}) }}
                >
                  {path}
                </button>
              </li>
            ))}
          </ul>
          {changed !== null && changed.length === 0 && !changedError && (
            <div style={emptyLine}>This pull request changes no files.</div>
          )}

          {/*
            * R-13.11's second half. The tree is the *whole* checkout, not the changed
            * subset, because reading a change means reading what it calls into.
            */}
          <div style={sectionHead}>All files in the checkout</div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" style={filterInput} />
          <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
            {loading ? (
              <div style={emptyLine}>Loading…</div>
            ) : (
              <FileTree entries={checkout} current={selected?.path ?? ''} filter={filter} onPick={setSelected} readOnly />
            )}
          </div>
        </nav>

        {selected ? (
          <CheckoutFileView
            key={selected.path}
            entry={selected}
            prefix={prefix}
            headSha={worktree.headSha}
            drafts={drafts.filter((d) => d.target.path === selected.path)}
            notices={notices}
            error={draftsError}
            onHold={hold}
            onPublish={publish}
            onDiscard={discard}
          />
        ) : (
          <main style={centerMsg}>Pick a changed file to start reading, or open any file in the checkout.</main>
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
  notices: Record<string, DraftNotice>;
  error: string | null;
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
function CheckoutFileView({ entry, prefix, headSha, drafts, notices, error, onHold, onPublish, onDiscard }: CheckoutFileViewProps) {
  const path = checkoutPath(prefix, entry.path);
  const { file, loading } = useFile(entry.type === 'dir' ? '' : path, entry.kind);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const content = file && 'content' in file ? file.content : undefined;
  /*
   * Markdown renders rendered by default, because that is how a document under review is
   * meant to be read. But the rendered surface has no lines, and a comment anchors to
   * one — so on a Markdown file the composer was unreachable, which in a Markdown-centric
   * product meant commenting did not work on exactly the files people review. The source
   * view is the same read-only `CodeView` every other file gets; the toggle only chooses
   * which one is on screen. Found in the browser against a real pull request.
   */
  const [asSource, setAsSource] = useState(false);
  const rendered = entry.kind === 'markdown' && !asSource;

  return (
    <main style={pane}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 36px 120px' }}>
        <div style={crumb}>
          {entry.type === 'dir' ? '📂 ' : ''}
          {entry.path}
          <span style={{ opacity: 0.7 }}> · read-only</span>
          {entry.type === 'file' && entry.kind === 'markdown' && (
            <button
              type="button"
              data-vs-md-view={asSource ? 'source' : 'rendered'}
              onClick={() => {
                // The selection belongs to the source view's line numbers; carrying it
                // across would leave a composer open against a surface that no longer
                // shows the line it names.
                setSelection(null);
                setAsSource((v) => !v);
              }}
              title={asSource ? 'Show the rendered document' : 'Show the source, where lines can be commented on'}
              style={viewToggle}
            >
              {asSource ? 'Rendered' : 'Source · to comment'}
            </button>
          )}
        </div>
        {entry.type === 'dir' ? (
          <div style={placeholder}>Folder — pick a file inside it.</div>
        ) : loading ? (
          <p style={{ opacity: 0.6 }}>Loading…</p>
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
        {drafts.length > 0 && (
          <section data-vs-draft-list style={{ marginTop: 16, display: 'grid', gap: 8 }}>
            <div style={sectionHead}>Review comments on this file</div>
            {drafts.map((draft) => (
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
    </main>
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
          {busy ? 'Saving…' : 'Save draft'}
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
 * One comment, and — R-13.18 — where it lives, said out loud.
 *
 * The chip is driven by `status`, which is the record's own account of itself, and not by
 * whether a link or a button happens to be renderable. A published comment whose permalink
 * is missing still reads "On GitHub"; it simply has no link to offer.
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
    <div data-vs-draft={draft.id} style={draftCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span data-vs-draft-origin={published ? 'github' : 'local'} style={published ? githubChip : localChip}>
          {published ? `On GitHub · #${draft.pullNumber}` : 'Local draft — not on GitHub'}
        </span>
        <span style={{ font: '11px ui-monospace, monospace', color: '#64748b' }}>{anchorLabel(draft)}</span>
        <span style={{ font: '11px ui-monospace, monospace', color: '#94a3b8' }}>at {draft.headSha.slice(0, 7)}</span>
      </div>
      <div style={{ margin: '6px 0', font: '13px system-ui', color: '#0f172a', overflowWrap: 'anywhere' }}>{draft.comment}</div>

      {notice && (
        <div data-vs-draft-notice={notice.kind} style={notice.kind === 'error' ? noticeError : notice.kind === 'stale' ? noticeStale : noticeNote}>
          {notice.kind === 'stale' ? (
            <>
              <div>
                Written against <code>{notice.draftHeadSha}</code>; the pull request is now at{' '}
                <code>{notice.currentHeadSha}</code>. Publishing now would anchor it to whatever sits at that line today.
              </div>
              <button type="button" onClick={() => void onPublish(draft.id, true)} style={{ ...primaryBtn, marginTop: 6 }}>
                Publish anyway
              </button>
            </>
          ) : (
            notice.message
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        {published ? (
          draft.published?.htmlUrl && (
            <a href={draft.published.htmlUrl} target="_blank" rel="noreferrer" style={linkBtn}>
              Open on GitHub
            </a>
          )
        ) : (
          <>
            <button type="button" onClick={() => void onDiscard(draft.id)} style={backBtn}>
              Discard
            </button>
            <button type="button" onClick={() => void onPublish(draft.id)} style={primaryBtn}>
              Publish
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const banner: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid #e5e7eb', background: '#fffbeb', font: '13px system-ui', color: '#334155' };
const bannerMeta: React.CSSProperties = { font: '11px ui-monospace, monospace', color: '#92400e' };
const readOnlyChip: React.CSSProperties = { font: '600 10px system-ui', padding: '2px 8px', borderRadius: 99, border: '1px solid #fcd34d', background: '#fef3c7', color: '#92400e' };
const backBtn: React.CSSProperties = { font: '12px system-ui, sans-serif', padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#334155', cursor: 'pointer' };
const sidebar: React.CSSProperties = { width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #e5e7eb', background: 'white', overflow: 'hidden' };
const sectionHead: React.CSSProperties = { padding: '10px 12px 6px', font: '700 11px system-ui', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 };
const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: '0 6px', maxHeight: 220, overflow: 'auto' };
const changedRow: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '3px 6px', border: 'none', borderRadius: 4, background: 'transparent', cursor: 'pointer', font: '12px ui-monospace, monospace', color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const rowActive: React.CSSProperties = { background: '#eff6ff', color: '#1d4ed8', fontWeight: 600 };
const filterInput: React.CSSProperties = { margin: '0 12px 6px', padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: '12px system-ui' };
const emptyLine: React.CSSProperties = { padding: '4px 12px', font: '12px system-ui', color: '#94a3b8' };
const errorLine: React.CSSProperties = { padding: '4px 12px', font: '12px system-ui', color: '#b91c1c' };
const pane: React.CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto', background: '#f8fafc' };
const crumb: React.CSSProperties = { font: '12px ui-monospace, monospace', color: '#64748b', marginBottom: 12 };
const viewToggle: React.CSSProperties = { marginLeft: 10, padding: '2px 8px', border: '1px solid #cbd5e1', borderRadius: 999, background: 'white', color: '#475569', font: '600 11px system-ui', cursor: 'pointer' };
const mdWrap: React.CSSProperties = { background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 24px' };
const placeholder: React.CSSProperties = { padding: '48px 24px', textAlign: 'center', color: '#64748b', background: 'white', border: '1px dashed #cbd5e1', borderRadius: 12 };
const centerMsg: React.CSSProperties = { flex: 1, display: 'grid', placeItems: 'center', opacity: 0.6, font: '13px system-ui' };
const tallyChip: React.CSSProperties = { font: '600 10px system-ui', padding: '2px 8px', borderRadius: 99, border: '1px solid #cbd5e1', background: 'white', color: '#475569' };
const composer: React.CSSProperties = { display: 'grid', gap: 6, marginTop: 10, padding: 10, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8 };
const composerText: React.CSSProperties = { width: '100%', height: 70, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: '13px system-ui', resize: 'vertical', boxSizing: 'border-box' };
const primaryBtn: React.CSSProperties = { padding: '4px 12px', border: '1px solid #2563eb', borderRadius: 4, background: '#2563eb', color: 'white', cursor: 'pointer', font: '12px system-ui' };
const linkBtn: React.CSSProperties = { padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#1d4ed8', font: '12px system-ui', textDecoration: 'none' };
const draftCard: React.CSSProperties = { padding: 10, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8 };
/** R-13.18 — two chips, two colours, two sentences. Never one chip and an empty space. */
const chipBase: React.CSSProperties = { font: '600 10px system-ui', padding: '2px 8px', borderRadius: 99, whiteSpace: 'nowrap' };
const localChip: React.CSSProperties = { ...chipBase, border: '1px solid #fcd34d', background: '#fef3c7', color: '#92400e' };
const githubChip: React.CSSProperties = { ...chipBase, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534' };
const noticeBase: React.CSSProperties = { margin: '0 0 6px', padding: 8, borderRadius: 6, font: '12px system-ui', lineHeight: 1.5 };
const noticeStale: React.CSSProperties = { ...noticeBase, border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e' };
const noticeError: React.CSSProperties = { ...noticeBase, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c' };
const noticeNote: React.CSSProperties = { ...noticeBase, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8' };
