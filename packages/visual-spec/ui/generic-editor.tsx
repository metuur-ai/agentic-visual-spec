/**
 * generic-editor.tsx — viewer + comment panel for everything that isn't markdown:
 * code/text (line-anchored), images (preview), binaries (placeholder), and folders.
 */
import { useEffect, useState } from 'react';
import { CodeView, type LineSelection } from './code-view';
import { GenericPanel } from './generic-panel';
import { type FileKind, type TreeEntry, rawUrl, useFile } from './use-tree';
import { ActiveCommentProvider } from './active-comment';
import { IndicatorLayer } from './indicator-layer';

export function GenericEditor({
  entry,
  commentWidth,
  splitter,
}: {
  entry: TreeEntry;
  /** A CSS length — the host drives this with a custom property so a drag costs no render. */
  commentWidth: number | string;
  splitter: React.ReactNode;
}) {
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const isFolder = entry.type === 'dir';
  const { file, loading } = useFile(isFolder ? '' : entry.path, entry.kind);

  // Clear any line selection when the open file changes.
  useEffect(() => setSelection(null), [entry.path]);

  const content = file && 'content' in file ? file.content : undefined;
  const showsCode = !isFolder && !loading && entry.kind !== 'image' && content != null;

  return (
    <ActiveCommentProvider>
      <main style={main}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 40px 120px' }}>
          <PathCrumb path={entry.path} kind={entry.kind} isFolder={isFolder} />
          {isFolder ? (
            <Placeholder icon="📂" title={entry.path} note="Add a comment about this folder in the panel on the right." />
          ) : loading ? (
            <p style={{ opacity: 0.6 }}>Loading…</p>
          ) : entry.kind === 'image' ? (
            <div style={imageWrap}>
              <img src={rawUrl(entry.path)} alt={entry.name} style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #e2e8f0' }} />
            </div>
          ) : content != null ? (
            <CodeView content={content} selection={selection} onSelect={setSelection} />
          ) : (
            <Placeholder
              icon="📦"
              title={entry.name}
              note={file && 'reason' in file && file.reason === 'too-large' ? 'File too large to preview. You can still comment on it.' : 'Binary file — no preview. You can still comment on it.'}
            />
          )}
        </div>
        {showsCode && <IndicatorLayer path={entry.path} mode="code" />}
      </main>
      {splitter}
      <GenericPanel path={entry.path} type={entry.type} kind={entry.kind} selection={selection} content={content} width={commentWidth} />
    </ActiveCommentProvider>
  );
}

function PathCrumb({ path, kind, isFolder }: { path: string; kind?: FileKind; isFolder: boolean }) {
  return (
    <div style={{ font: '12px ui-monospace, monospace', color: '#64748b', marginBottom: 14 }}>
      {isFolder ? '📂 ' : ''}
      {path}
      {kind && !isFolder ? <span style={{ opacity: 0.6 }}> · {kind}</span> : null}
    </div>
  );
}

function Placeholder({ icon, title, note }: { icon: string; title: string; note: string }) {
  return (
    <div style={ph}>
      <div style={{ fontSize: 40 }}>{icon}</div>
      <div style={{ fontWeight: 600, margin: '8px 0 4px', wordBreak: 'break-all' }}>{title}</div>
      <div style={{ color: '#64748b', fontSize: 13 }}>{note}</div>
    </div>
  );
}

const main: React.CSSProperties = { flex: 1, minWidth: 0, position: 'relative', overflow: 'auto', background: '#f8fafc' };
const imageWrap: React.CSSProperties = { display: 'flex', justifyContent: 'center', padding: 16, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8 };
const ph: React.CSSProperties = { display: 'grid', placeItems: 'center', textAlign: 'center', padding: '64px 24px', background: 'white', border: '1px dashed #cbd5e1', borderRadius: 12 };
