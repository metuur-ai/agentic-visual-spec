import { InspectorProvider, useComments } from '../core/app';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from './file-tree';
import { GenericEditor } from './generic-editor';
import { BrandHeader, MainHeader, type ViewMode } from './main-header';
import { MarkdownEditor } from './markdown-editor';
import { MarkdownDocEditor } from './markdown-doc-editor';
import { toSurfaceId } from './md-path';
import { type TreeEntry, useTree } from './use-tree';

const MIN_W = 180;
const MAX_W = 680;
const CMT_MIN_W = 260;
const CMT_MAX_W = 720;

export function App() {
  const { entries, loading } = useTree();
  const [selected, setSelected] = useState<TreeEntry | null>(null);
  const [mode, setMode] = useState<ViewMode>('view');
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
  const [confirmView, setConfirmView] = useState(false);
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
        setConfirmView(true);
        return;
      }
      setMode(next);
    },
    [],
  );

  // Selecting a different file always returns to View mode (Edit is per-file).
  const pick = (e: TreeEntry) => {
    setSelected(e);
    exitToView();
  };

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
        <MainHeader file={current} onNavigate={navigate} withInspector={isMarkdown} isMarkdown={isMarkdown} mode={mode} onModeChange={requestMode} />
      ) : (
        <BrandHeader />
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar entries={entries} current={current} loading={loading} onPick={pick} width={width} />
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
      {confirmView && (
        <UnsavedDialog
          onSaveAndView={async () => {
            const ok = await editorState.current.save();
            setConfirmView(false);
            if (ok) exitToView();
          }}
          onDiscard={() => {
            setConfirmView(false);
            exitToView();
          }}
          onCancel={() => setConfirmView(false)}
        />
      )}
    </>
  );

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

/** Guard shown when leaving Edit for View with unsaved changes. */
function UnsavedDialog({ onSaveAndView, onDiscard, onCancel }: { onSaveAndView: () => void; onDiscard: () => void; onCancel: () => void }) {
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
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 16 }}>You have edits that aren’t saved yet. Save them before switching to View?</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onDiscard} style={dialogDiscard}>Discard</button>
          <button type="button" onClick={onCancel} style={dialogCancel}>Cancel</button>
          <button type="button" onClick={onSaveAndView} style={dialogPrimary} autoFocus>Save &amp; View</button>
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

function Sidebar({ entries, current, loading, onPick, width }: { entries: TreeEntry[]; current: string; loading: boolean; onPick: (e: TreeEntry) => void; width: number }) {
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
      <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', background: 'white', flexShrink: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Files <span style={{ opacity: 0.5, fontWeight: 400 }}>({fileCount})</span>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" style={filter} />
      </div>
      <div style={{ padding: 8, flex: 1, overflow: 'auto' }}>
        {loading ? <div style={{ opacity: 0.6, padding: 8 }}>Loading…</div> : <FileTree entries={entries} current={current} filter={q} onPick={onPick} commentCounts={commentCounts} />}
      </div>
      <SidebarFooter />
    </nav>
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
const splitter: React.CSSProperties = { width: 6, flexShrink: 0, cursor: 'col-resize', background: 'transparent', transition: 'background 120ms', marginLeft: -3, zIndex: 5 };
const filter: React.CSSProperties = { width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: 'inherit' };
const dialogBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center', background: 'rgba(15,23,42,0.35)' };
const dialogCard: React.CSSProperties = { width: 380, maxWidth: 'calc(100vw - 32px)', padding: 20, borderRadius: 12, background: 'white', boxShadow: '0 20px 50px rgba(0,0,0,0.28)', font: 'system-ui' };
const dialogPrimary: React.CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 13px system-ui' };
const dialogCancel: React.CSSProperties = { padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#475569', cursor: 'pointer', font: '600 13px system-ui' };
const dialogDiscard: React.CSSProperties = { padding: '7px 14px', border: '1px solid #fecaca', borderRadius: 8, background: 'white', color: '#b91c1c', cursor: 'pointer', font: '600 13px system-ui' };
