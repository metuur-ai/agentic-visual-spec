/**
 * markdown-editor.tsx — the rich markdown commenting body (unchanged behavior).
 * The InspectorProvider is supplied by App (so the header's inspector toggle
 * shares the same context); this renders the markdown surface + overlay + panel.
 */
import { InspectOverlay, SelectionReporter, useMarkdownSource } from '@visual-spec/core/app';
import { CommentPanel } from './comment-panel';
import { MarkdownSurface } from './markdown-surface';
import { toSurfaceId } from './md-path';

export function MarkdownEditor({
  path,
  commentWidth,
  splitter,
}: {
  path: string; // real .md path
  commentWidth: number;
  splitter: React.ReactNode;
}) {
  const surfaceId = toSurfaceId(path);
  const { source, loading } = useMarkdownSource(surfaceId);
  return (
    <>
      <main style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'auto', background: '#f8fafc' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 56px 120px' }}>
          {loading ? <p style={{ opacity: 0.6 }}>Loading…</p> : <MarkdownSurface source={source} />}
        </div>
        <InspectOverlay />
      </main>
      {splitter}
      <CommentPanel file={surfaceId} width={commentWidth} />
      <SelectionReporter />
    </>
  );
}
