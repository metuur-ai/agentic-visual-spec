/**
 * collab-app.tsx — task U-1, mounts the collaboration surface App.tsx swaps to.
 *
 * SCOPE. The reviewer half of the round trip. A reviewer pastes a PR reference +
 * document id (`CollabOpenPanel`), the document renders with its identity attributes
 * (`CollabDocumentView`), and the real `CommentPanel` runs beside it: read, create,
 * reply, resolve. Authoring and publish are the author's surface, not this one.
 *
 * WHY THIS IS ITS OWN TOP-LEVEL ROUTE, NOT A `TreeEntry`. App.tsx's `selected` is a
 * `TreeEntry` enumerated by `ui/use-tree.ts` from the local file tree; a collaboration
 * document has no such entry. Faking one would feed it through `isMarkdown`, which
 * assumes local-file semantics. So App.tsx swaps its whole shell for this component
 * instead of stretching `selected`/`mode` to cover a second kind of thing.
 *
 * WHY THE DOCUMENT IS `CollabDocumentView` AND NOT AN EDITOR. `CommentPanel`'s
 * "show in document" resolves a comment's `nodeId` to a DOM element through
 * `[data-vs-node-id]`, and `CollabDocumentView` is what stamps that attribute.
 * Luthor's editor keeps `nodeId` in Lexical `NodeState`, never in the DOM, so
 * rendering the reviewer's copy through the editor would silently break locate.
 * The reviewer does not edit, so read-only rendering is also the honest surface.
 *
 * An earlier revision hand-rolled a read-only comment list here, on the reasoning that
 * `CommentPanel` calls `useInspector()` and would drag in comment creation. Creation is
 * now wanted, and `InspectorProvider` turns out to be document-agnostic — it needs only
 * a `surfaceId` — so the real panel is mounted and the parallel list is gone.
 *
 * Named `collab-app.tsx` so `core/collaboration/import-boundary.test.ts` (R-2.13)
 * covers it: nothing here may reach `markdownToInjectable` / `canonicalizeMarkdown` /
 * `markdownToJSON`, and nothing here does — it only renders the canonical JSON
 * `CollabDocumentView` already walks.
 */
import { useMemo, useRef, useState } from 'react';
import { InspectorProvider } from '../core/app';
import { collabCommentPanelSource } from './collab-comment-source';
import { CollabDocumentView } from './collab-document-view';
import { CollabOpenPanel } from './collab-open-panel';
import { CommentPanel, type CommentPanelSource } from './comment-panel';
import { useCollabDocument } from './use-collab-document';

export function CollabApp({ onExit }: { onExit: () => void }) {
  const [documentId, setDocumentId] = useState<string | null>(null);

  return (
    <>
      <header style={bar}>
        <button type="button" onClick={onExit} style={backBtn}>
          ← Files
        </button>
        <span style={title}>Collaboration review</span>
      </header>
      {documentId ? (
        <CollabDocumentPane documentId={documentId} />
      ) : (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <CollabOpenPanel onOpened={setDocumentId} />
        </div>
      )}
    </>
  );
}

function CollabDocumentPane({ documentId }: { documentId: string }) {
  const { document, fullDocument, comments, loading, error, addComment, replyToComment, removeComment } =
    useCollabDocument(documentId);
  // `locate` scopes its query to the rendered document rather than the whole page.
  const docRoot = useRef<HTMLDivElement | null>(null);

  const source = useMemo<CommentPanelSource | null>(
    () =>
      fullDocument
        ? collabCommentPanelSource({
            document: fullDocument,
            comments,
            add: addComment,
            reply: replyToComment,
            remove: removeComment,
            root: docRoot.current,
          })
        : null,
    [fullDocument, comments, addComment, replyToComment, removeComment],
  );

  if (loading) {
    return <main style={centerMsg}>Loading…</main>;
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
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={docPane}>
          <div style={docTitleBar}>
            <strong>{document.title}</strong>
            {document.github?.pullNumber !== undefined && (
              <span style={{ opacity: 0.6 }}>
                {' '}
                · {document.github.owner}/{document.github.repo}#{document.github.pullNumber}
              </span>
            )}
          </div>
          <div ref={docRoot} style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 56px 120px' }}>
            <CollabDocumentView document={fullDocument} />
          </div>
        </main>
        <CommentPanel width={340} source={source} />
      </div>
    </InspectorProvider>
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
};
const title: React.CSSProperties = { fontWeight: 700, color: '#334155' };
const centerMsg: React.CSSProperties = { flex: 1, display: 'grid', placeItems: 'center', opacity: 0.6 };
const docPane: React.CSSProperties = { flex: 1, minWidth: 0, position: 'relative', overflow: 'auto', background: '#f8fafc' };
const docTitleBar: React.CSSProperties = { padding: '14px 56px 0', font: '14px system-ui', color: '#334155' };
