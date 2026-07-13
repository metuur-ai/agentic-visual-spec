/**
 * markdown-editor.tsx — the rich markdown commenting body (unchanged behavior).
 * The InspectorProvider is supplied by App (so the header's inspector toggle
 * shares the same context); this renders the markdown surface + overlay + panel.
 */
import { InspectOverlay, SelectionReporter, useMarkdownSource } from '../core/app';
import { CommentPanel } from './comment-panel';
import { ContentTitle } from './content-title';
import { useMemo } from 'react';
import { MarkdownSurface } from './markdown-surface';
import { makeImageResolver, toSurfaceId } from './md-path';

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
  // Resolve relative image paths against the file's dir for display; the stored
  // .md keeps its plain relative srcs, so it stays portable to simpler viewers.
  const resolveImageSrc = useMemo(() => makeImageResolver(path), [path]);
  return (
    <>
      <main style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'auto', background: '#f8fafc' }}>
        <ContentTitle path={path} />
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 56px 120px' }}>
          {loading ? <p style={{ opacity: 0.6 }}>Loading…</p> : <MarkdownSurface source={source} resolveImageSrc={resolveImageSrc} />}
        </div>
        <InspectOverlay />
      </main>
      {splitter}
      <CommentPanel file={surfaceId} width={commentWidth} />
      <SelectionReporter />
    </>
  );
}
