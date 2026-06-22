import { InspectorProvider, useComments } from '../core/app';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from './file-tree';
import { GenericEditor } from './generic-editor';
import { BrandHeader, MainHeader } from './main-header';
import { MarkdownEditor } from './markdown-editor';
import { toSurfaceId } from './md-path';
import { type TreeEntry, useTree } from './use-tree';

const MIN_W = 180;
const MAX_W = 680;
const CMT_MIN_W = 260;
const CMT_MAX_W = 720;

export function App() {
  const { entries, loading } = useTree();
  const [selected, setSelected] = useState<TreeEntry | null>(null);
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

  // Jump to a path from the cart dropdown.
  const navigate = (path: string) => {
    const e = entries.find((x) => x.path === path);
    if (e) setSelected(e);
  };

  const current = selected?.path ?? '';
  const isMarkdown = selected?.type === 'file' && selected.kind === 'markdown';
  const commentSplitter = <Splitter onResize={resizeComment} fromRight />;

  const shell = (
    <>
      {selected ? <MainHeader file={current} onNavigate={navigate} withInspector={isMarkdown} /> : <BrandHeader />}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar entries={entries} current={current} loading={loading} onPick={setSelected} width={width} />
        <Splitter onResize={resize} />
        {selected ? (
          isMarkdown ? (
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
      <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          Files <span style={{ opacity: 0.5, fontWeight: 400 }}>({fileCount})</span>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…" style={filter} />
      </div>
      <div style={{ padding: 8 }}>
        {loading ? <div style={{ opacity: 0.6, padding: 8 }}>Loading…</div> : <FileTree entries={entries} current={current} filter={q} onPick={onPick} commentCounts={commentCounts} />}
      </div>
    </nav>
  );
}

const sidebar: React.CSSProperties = { height: '100%', flexShrink: 0, borderRight: '1px solid #e5e7eb', background: 'white', overflow: 'auto', font: '13px system-ui' };
const splitter: React.CSSProperties = { width: 6, flexShrink: 0, cursor: 'col-resize', background: 'transparent', transition: 'background 120ms', marginLeft: -3, zIndex: 5 };
const filter: React.CSSProperties = { width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: 'inherit' };
