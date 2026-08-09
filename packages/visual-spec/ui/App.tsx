import { InspectorProvider, useComments } from '../core/app';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollabApp, type CollabIntent } from './collab-app';
import { CollabDrawer } from './collab-drawer';
import { FileTree } from './file-tree';
import { GenericEditor } from './generic-editor';
import { BrandHeader, type HeaderActions, MainHeader, type ViewMode } from './main-header';
import { MarkdownEditor } from './markdown-editor';
import { MarkdownDocEditor } from './markdown-doc-editor';
import { toSurfaceId } from './md-path';
import { useCollabPulls } from './use-collab-pulls';
import { type TreeEntry, invalidateTree, useTree } from './use-tree';

const MIN_W = 180;
const MAX_W = 680;
const CMT_MIN_W = 260;
const CMT_MAX_W = 720;

export function App() {
  const { entries, loading, reload } = useTree();
  const [selected, setSelected] = useState<TreeEntry | null>(null);
  const [mode, setMode] = useState<ViewMode>('view');
  // A collaboration document has no local-file entry (ui/use-tree.ts enumerates the
  // file tree only), so it cannot be reached through `selected`/`pick()`. It is a
  // genuinely separate top-level route that swaps the whole shell instead.
  //
  // It carries an intent rather than a boolean because there are now three ways in and
  // they arrive at different places: the sidebar link opens the surface's own two
  // entry panels, while the header's pull request list already knows which document to
  // resume (R-7.7) or which pull request to check out (R-7.8) and would otherwise ask
  // the user to find it again on the screen they just came from.
  const [collab, setCollab] = useState<CollabIntent | null>(null);
  // The picker that leads to it. It is a right-side drawer over the file shell rather
  // than the first screen of the swapped-in route: "what pull requests are there?" is a
  // question asked *while* looking at the files, and answering it used to cost the whole
  // view. What the drawer hands back is always a full intent, so the surface below only
  // ever mounts on something already chosen.
  const [picker, setPicker] = useState(false);
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('vs:sidebarWidth'));
    return saved >= MIN_W && saved <= MAX_W ? saved : 280;
  });
  const [commentWidth, setCommentWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('vs:commentWidth'));
    return saved >= CMT_MIN_W && saved <= CMT_MAX_W ? saved : 340;
  });

  const resize = (w: number) => {
    const clamped = Math.min(MAX_W, Math.max(MIN_W, w));
    setWidth(clamped);
    localStorage.setItem('vs:sidebarWidth', String(clamped));
  };
  const resizeComment = (w: number) => {
    const clamped = Math.min(CMT_MAX_W, Math.max(CMT_MIN_W, w));
    setCommentWidth(clamped);
    localStorage.setItem('vs:commentWidth', String(clamped));
  };

  // Live dirty state + a success-returning save, reported up by the doc editor,
  // so switching to View can guard unsaved edits instead of dropping them.
  const editorState = useRef<{ dirty: boolean; save: () => Promise<boolean> }>({ dirty: false, save: async () => true });
  // A navigation deferred behind the unsaved-changes prompt: `run` performs it
  // once the user resolves the dialog (Save/Discard); Cancel just clears it.
  const [pending, setPending] = useState<{ run: () => void; primaryLabel: string; message: string } | null>(null);
  const onEditorState = useCallback((s: { dirty: boolean; save: () => Promise<boolean> }) => {
    editorState.current = s;
  }, []);

  const exitToView = useCallback(() => {
    editorState.current = { dirty: false, save: async () => true };
    setMode('view');
  }, []);

  // Guarded mode switch: leaving Edit for View with unsaved edits opens a
  // Save / Discard / Cancel prompt rather than silently unmounting the buffer.
  const requestMode = useCallback(
    (next: ViewMode) => {
      if (next === 'view' && editorState.current.dirty) {
        setPending({ run: exitToView, primaryLabel: 'Save & View', message: 'You have edits that aren’t saved yet. Save them before switching to View?' });
        return;
      }
      setMode(next);
    },
    [exitToView],
  );

  // Selecting a different file/folder always returns to View mode (Edit is
  // per-file). Perform the switch now.
  const doPick = useCallback(
    (e: TreeEntry) => {
      setSelected(e);
      exitToView();
    },
    [exitToView],
  );

  // Guarded pick: switching away from a file with unsaved edits prompts to Save
  // or Discard first, instead of silently dropping the buffer. Re-picking the
  // open file is a no-op so it never prompts.
  const pick = useCallback(
    (e: TreeEntry) => {
      if (selected && e.path === selected.path && e.type === selected.type) return;
      if (editorState.current.dirty) {
        setPending({ run: () => doPick(e), primaryLabel: 'Save & Switch', message: 'You have edits that aren’t saved yet. Save them before opening another file?' });
        return;
      }
      doPick(e);
    },
    [selected, doPick],
  );

  // R-5.4 — a file that was just created is not in `entries` yet (the walk that
  // would list it has not run), so the pane is pointed at the path the server
  // confirmed rather than looked up. Created files are always markdown, and
  // landing in Edit is what "ready to edit" means.
  const onCreated = useCallback(
    (path: string) => {
      invalidateTree();
      reload();
      editorState.current = { dirty: false, save: async () => true };
      setSelected({ path, name: baseName(path), type: 'file', kind: 'markdown' });
      setMode('edit');
    },
    [reload],
  );

  // R-5.5 — the pane follows the document it is showing to its new path; a pane on
  // any other file is left alone.
  const onRenamed = useCallback(
    (from: string, to: string) => {
      invalidateTree();
      reload();
      setSelected((cur) => (cur && cur.path === from ? { ...cur, path: to, name: baseName(to) } : cur));
    },
    [reload],
  );

  /**
   * R-6.5 — the branch switcher's half of the unsaved-changes guard.
   *
   * It reuses the machinery the mode switch and the file pick already run through
   * rather than growing a second dialog: `editorState` is the live dirty flag the
   * document editor reports, `pending` is the deferred action, and `UnsavedDialog`
   * below is the prompt. Note which editor this guards — `MarkdownDocEditor`, the one
   * on screen. `CollabEditor` can also be dirty, but it lives inside `CollabApp`,
   * which this component returns early, so the switcher and it are never mounted
   * together and a guard naming it would protect nothing.
   */
  const confirmUnsaved = useCallback((proceed: () => void) => {
    if (!editorState.current.dirty) {
      proceed();
      return;
    }
    setPending({
      run: proceed,
      primaryLabel: 'Save & Change',
      message: 'You have edits that aren’t saved yet. Save them before changing branch?',
    });
  }, []);

  /**
   * R-6.7 / R-6.8 — the branch moved, so the tree is a different tree.
   *
   * The chip needs nothing back: the checkout route answered with the context git
   * reported after the change and `useGitContext` has already adopted it (R-5.9). What
   * only this component can do is re-read the tree and decide what happens to the open
   * pane — and a file that is not on the new branch must not go on rendering the
   * previous branch's bytes under the new branch's name.
   */
  const onBranchChanged = useCallback(async () => {
    invalidateTree();
    const next = await reload();
    setSelected((current) => {
      if (!current || next.some((e) => e.path === current.path)) return current;
      editorState.current = { dirty: false, save: async () => true };
      setMode('view');
      return null; // R-6.8 — back to the empty state
    });
  }, [reload]);

  const headerActions = useMemo<HeaderActions>(
    () => ({
      confirmUnsaved,
      onBranchChanged: () => void onBranchChanged(),
      onResumeCollab: (documentId: string) => setCollab({ documentId }),
      onReviewPull: (reviewPull: number) => setCollab({ reviewPull }),
    }),
    [confirmUnsaved, onBranchChanged],
  );

  // Jump to a path from the cart dropdown.
  const navigate = (path: string) => {
    const e = entries.find((x) => x.path === path);
    if (e) pick(e);
  };

  const current = selected?.path ?? '';
  const isMarkdown = selected?.type === 'file' && selected.kind === 'markdown';
  const editing = isMarkdown && mode === 'edit';
  const commentSplitter = <Splitter onResize={resizeComment} fromRight />;

  const shell = (
    <>
      {selected ? (
        <MainHeader file={current} onNavigate={navigate} withInspector={isMarkdown} isMarkdown={isMarkdown} mode={mode} onModeChange={requestMode} actions={headerActions} />
      ) : (
        <BrandHeader actions={headerActions} />
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar entries={entries} current={current} loading={loading} onPick={pick} width={width} onOpenCollab={() => setPicker(true)} onCreated={onCreated} onRenamed={onRenamed} />
        <Splitter onResize={resize} />
        {selected ? (
          editing ? (
            <MarkdownDocEditor key={current} path={current} previewWidth={commentWidth} splitter={commentSplitter} onExitToView={exitToView} onStateChange={onEditorState} />
          ) : isMarkdown ? (
            <MarkdownEditor path={current} commentWidth={commentWidth} splitter={commentSplitter} />
          ) : (
            <GenericEditor key={current} entry={selected} commentWidth={commentWidth} splitter={commentSplitter} />
          )
        ) : (
          <main style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: 0.6 }}>
            {loading ? 'Loading…' : 'Select a file or folder to view and comment.'}
          </main>
        )}
      </div>
      {pending && (
        <UnsavedDialog
          message={pending.message}
          primaryLabel={pending.primaryLabel}
          onSaveAndContinue={async () => {
            const ok = await editorState.current.save();
            const { run } = pending;
            setPending(null);
            if (ok) run(); // stay put on a failed save; the editor shows the error
          }}
          onDiscard={() => {
            const { run } = pending;
            setPending(null);
            run();
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {picker && (
        <CollabDrawer
          onClose={() => setPicker(false)}
          onResume={(documentId) => {
            setPicker(false);
            setCollab({ documentId });
          }}
          onReview={(pull, worktree) => {
            setPicker(false);
            setCollab({ review: { pull, worktree } });
          }}
        />
      )}
    </>
  );

  if (collab) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/*
          * A checkout's way back is labelled `← Pull requests`, so it goes to the list —
          * which now means reopening the drawer. The document surface's is labelled
          * `← Files` and means it, so that one just leaves.
          */}
        <CollabApp
          initial={collab}
          onExit={() => {
            setCollab(null);
            if (collab.review) setPicker(true);
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isMarkdown && selected ? (
        <InspectorProvider key={current} surfaceId={toSurfaceId(current)} pageIndex={0}>
          {shell}
        </InspectorProvider>
      ) : (
        shell
      )}
    </div>
  );
}

/** Guard shown when navigating away from Edit mode with unsaved changes. */
function UnsavedDialog({ onSaveAndContinue, onDiscard, onCancel, message, primaryLabel }: { onSaveAndContinue: () => void; onDiscard: () => void; onCancel: () => void; message: string; primaryLabel: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div style={dialogBackdrop} onMouseDown={onCancel}>
      <div style={dialogCard} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Unsaved changes">
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Unsaved changes</div>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 16 }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onDiscard} style={dialogDiscard}>Discard</button>
          <button type="button" onClick={onCancel} style={dialogCancel}>Cancel</button>
          <button type="button" onClick={onSaveAndContinue} style={dialogPrimary} autoFocus>{primaryLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Splitter({ onResize, fromRight = false }: { onResize: (w: number) => void; fromRight?: boolean }) {
  const dragging = useRef(false);
  const [hot, setHot] = useState(false);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) onResize(fromRight ? window.innerWidth - e.clientX : e.clientX);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onResize, fromRight]);

  return (
    <div
      onMouseDown={() => {
        dragging.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      title="Drag to resize"
      style={{ ...splitter, background: hot ? '#3b82f6' : 'transparent' }}
    />
  );
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function Sidebar({
  entries,
  current,
  loading,
  onPick,
  width,
  onOpenCollab,
  onCreated,
  onRenamed,
}: {
  entries: TreeEntry[];
  current: string;
  loading: boolean;
  onPick: (e: TreeEntry) => void;
  width: number;
  onOpenCollab: () => void;
  onCreated: (path: string) => void;
  onRenamed: (from: string, to: string) => void;
}) {
  const [q, setQ] = useState('');
  const { comments } = useComments(); // all → to flag which paths have open comments
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) {
      if (c.status !== 'open') continue;
      m.set(c.target.path, (m.get(c.target.path) ?? 0) + 1);
    }
    return m;
  }, [comments]);
  const fileCount = entries.filter((e) => e.type === 'file').length;

  return (
    <nav style={{ ...sidebar, width }}>
      <ReviewPullRequestsItem onOpenCollab={onOpenCollab} />
      <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', background: 'white', flexShrink: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Files <span style={{ opacity: 0.5, fontWeight: 400 }}>({fileCount})</span>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" style={filter} />
      </div>
      <div style={{ padding: 8, flex: 1, overflow: 'auto' }}>
        {loading ? <div style={{ opacity: 0.6, padding: 8 }}>Loading…</div> : <FileTree entries={entries} current={current} filter={q} onPick={onPick} commentCounts={commentCounts} onCreated={onCreated} onRenamed={onRenamed} />}
      </div>
      <SidebarFooter />
    </nav>
  );
}

/**
 * Two people, one of them behind the other — the shape a UI draws for "together".
 *
 * It replaced a pull-request glyph (a branch with a commit on it). That icon named the
 * *object* on the other side of the click, which the label already does; what the row
 * had nowhere to say was that a reviewer goes there to work with someone. The count
 * beside it still says how many pull requests there are, so nothing is lost by the icon
 * describing the activity instead of the artifact.
 */
function CollaborateIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/**
 * The way in to pull requests, at the top of the sidebar where navigation belongs.
 *
 * It used to be the first line of the *footer*, between the copyright and the
 * buy-me-a-coffee link, at 11px muted — which is how this sidebar dresses chrome.
 * Reviewing a pull request is not chrome: it is one of the two jobs this tool does,
 * and the only one the file tree below cannot lead anyone to. Everything else on the
 * route to it (the git chip's count, `CollabPullsPanel`) already assumed the user had
 * decided to look; nothing offered the decision.
 *
 * THE COUNT IS THE HEADER CHIP'S COUNT (R-7.1 … R-7.3), on the chip's own terms.
 * `useCollabPulls` reads `GET /__vs/collab` first and requests nothing at all where
 * collaboration is unconfigured (R-7.2), so mounting it a second time here adds no
 * GitHub traffic — and the badge stays absent until the first listing lands, rather
 * than rendering a `0` that would be a claim the server has not made yet.
 */
function ReviewPullRequestsItem({ onOpenCollab }: { onOpenCollab: () => void }) {
  const pulls = useCollabPulls();
  // Same gate as `PullCount` in the header: unconfigured says nothing, and neither
  // does a listing that has not arrived.
  const count = pulls.configured === true && pulls.pulls !== null ? pulls.pulls.length : null;

  return (
    <div style={navSection}>
      <button
        type="button"
        onClick={onOpenCollab}
        className="vs-focus-ring"
        style={navItem}
        title="Browse the repository’s open pull requests — review the code, or pick a document up where it was left"
      >
        <CollaborateIcon />
        {/*
          * "Pull requests" alone named a destination and left the reason for going
          * unsaid, next to a file tree that is the obvious thing to click instead. The
          * label now leads with the verb. It wraps rather than truncates at a narrow
          * sidebar — `navItem` has a `minHeight`, not a fixed one — because half a
          * sentence is worse here than two lines.
          */}
        <span style={navItemLabel}>Collaborate on pull requests</span>
        {count !== null && (
          <span style={navCount} data-testid="sidebar-pull-count">
            {count}
          </span>
        )}
      </button>
    </div>
  );
}

declare const __APP_VERSION__: string;

/** A gentle, muted footer pinned to the bottom of the sidebar. */
function SidebarFooter() {
  return (
    <footer style={footer}>
      <div>© 2026 Visual Specs v{__APP_VERSION__}</div>
      <div style={{ marginTop: 2 }}>
        Made with <span style={{ color: '#ef4444' }}>❤</span> by{' '}
        {/* <a href="https://github.com/javierhbr" target="_blank" rel="noreferrer" style={footerLink}>@javierhbr</a> */}
        javierhbr
      </div>
      <a href="https://www.buymeacoffee.com/javierhbr" target="_blank" rel="noreferrer" style={{ ...footerLink, display: 'inline-block', marginTop: 4 }}>
        ☕ Buy me a coffee
      </a>
    </footer>
  );
}

const sidebar: React.CSSProperties = { height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #e5e7eb', background: 'white', overflow: 'hidden', font: '13px system-ui' };
const footer: React.CSSProperties = { flexShrink: 0, padding: '10px 12px', borderTop: '1px solid #f1f5f9', background: '#fbfaff', font: '11px system-ui', color: '#94a3b8', lineHeight: 1.5 };
const footerLink: React.CSSProperties = { color: '#a78bca', textDecoration: 'none', fontWeight: 600 };
const navSection: React.CSSProperties = { flexShrink: 0, padding: 8, borderBottom: '1px solid #e5e7eb', background: 'white' };
/**
 * Sized as navigation, not as a link: a 36px row is a comfortable pointer target and
 * matches the density of the tree rows below it, so the two read as one column of
 * places to go rather than a caption sitting above a list.
 */
const navItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 36, padding: '0 10px', border: '1px solid transparent', borderRadius: 6, background: '#f8f5ff', color: '#6d28d9', font: '600 13px system-ui', cursor: 'pointer' };
/** Takes the slack and wraps into it; the icon and the count keep their size. */
const navItemLabel: React.CSSProperties = { flex: 1, textAlign: 'left', lineHeight: 1.3, padding: '7px 0' };
/** The count, quiet enough to read as a fact about the row rather than a second control. */
const navCount: React.CSSProperties = { font: '600 11px ui-monospace, monospace', padding: '1px 7px', borderRadius: 99, background: '#ede9fe', color: '#6d28d9', flexShrink: 0 };
const splitter: React.CSSProperties = { width: 6, flexShrink: 0, cursor: 'col-resize', background: 'transparent', transition: 'background 120ms', marginLeft: -3, zIndex: 5 };
const filter: React.CSSProperties = { width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: 'inherit' };
const dialogBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center', background: 'rgba(15,23,42,0.35)' };
const dialogCard: React.CSSProperties = { width: 380, maxWidth: 'calc(100vw - 32px)', padding: 20, borderRadius: 12, background: 'white', boxShadow: '0 20px 50px rgba(0,0,0,0.28)', font: 'system-ui' };
const dialogPrimary: React.CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 13px system-ui' };
const dialogCancel: React.CSSProperties = { padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#475569', cursor: 'pointer', font: '600 13px system-ui' };
const dialogDiscard: React.CSSProperties = { padding: '7px 14px', border: '1px solid #fecaca', borderRadius: 8, background: 'white', color: '#b91c1c', cursor: 'pointer', font: '600 13px system-ui' };
