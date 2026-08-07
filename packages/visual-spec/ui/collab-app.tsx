/**
 * collab-app.tsx — task U-1, mounts the collaboration surface App.tsx swaps to.
 *
 * SCOPE (Option B — read-only). A reviewer pastes a PR reference + document id
 * (`CollabOpenPanel`), the document renders with its identity attributes
 * (`CollabDocumentView`), and its existing comments list alongside it. Editing,
 * publish, comment creation/reply/resolve are later tasks and are not wired here.
 *
 * WHY THIS IS ITS OWN TOP-LEVEL ROUTE, NOT A `TreeEntry`. App.tsx's `selected` is a
 * `TreeEntry` enumerated by `ui/use-tree.ts` from the local file tree; a collaboration
 * document has no such entry. Faking one would feed it through `isMarkdown` /
 * `InspectorProvider`, both of which assume local-file semantics (App.tsx's own
 * comment on `InspectorProvider`). So App.tsx swaps its whole shell for this
 * component instead of stretching `selected`/`mode` to cover a second kind of thing.
 *
 * WHY THE COMMENT LIST HERE DOES NOT REUSE `CommentPanel`. `CommentPanel`'s
 * interactive shell (`Panel` in comment-panel.tsx) calls `useInspector()`
 * unconditionally, which throws outside `<InspectorProvider>` — and mounting it
 * would also stand up its compose form, i.e. comment *creation*, which Option B
 * defers. So comments render as a plain read-only list built from the same
 * `nodeId`-keyed helpers (`collabAnchorRefOf`, `collabOrphans`) rather than through
 * that shell.
 *
 * Named `collab-app.tsx` so `core/collaboration/import-boundary.test.ts` (R-2.13)
 * covers it: nothing here may reach `markdownToInjectable` / `canonicalizeMarkdown` /
 * `markdownToJSON`, and nothing here does — it only renders the canonical JSON
 * `CollabDocumentView` already walks.
 */
import { useState } from 'react';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import type { CommentRecord } from '../core/editing/comment-doc';
import { findCollabBlock } from './collab-anchor-resolver';
import { collabAnchorRefOf, collabOrphans } from './collab-comment-source';
import { CollabDocumentView } from './collab-document-view';
import { CollabOpenPanel } from './collab-open-panel';
import { flash } from './comment-history-list';
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
  const { document, fullDocument, comments, loading, error } = useCollabDocument(documentId);

  if (loading) {
    return <main style={centerMsg}>Loading…</main>;
  }
  if (error) {
    // R-11.4 — the server's own words, not a generic failure.
    return <main style={centerMsg}>{error.message}</main>;
  }
  if (!fullDocument || !document) {
    return <main style={centerMsg}>Document not found.</main>;
  }

  return (
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
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 56px 120px' }}>
          <CollabDocumentView document={fullDocument} />
        </div>
      </main>
      <ReadOnlyComments document={fullDocument} comments={comments} />
    </div>
  );
}

/** The author GitHub attached, when the record was projected from a PR comment. */
function authorOf(comment: CommentRecord): string | undefined {
  return (comment as { github?: { user?: string } }).github?.user;
}

/**
 * A read-only list of a document's existing comments (R-7.3's reading half only —
 * no compose form, no reply, no resolve). Anchored comments jump to and flash their
 * block, exactly like the local history list's "show in file"; orphans (R-6.5) are
 * listed separately with the last-known text of the block they pointed at.
 */
function ReadOnlyComments({ document: doc, comments }: { document: CollaborationDocument; comments: CommentRecord[] }) {
  const open = comments.filter((c) => c.status === 'open');
  const orphans = collabOrphans(doc, open);
  const orphanIds = new Set(orphans.map((o) => o.comment.id));
  const anchored = open.filter((c) => !orphanIds.has(c.id));

  return (
    <aside style={panel}>
      <header style={panelHeader}>
        Comments <span style={{ opacity: 0.5, fontWeight: 400 }}>({open.length})</span>
      </header>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {open.length === 0 && <p style={hint}>No comments on this document yet.</p>}
        {anchored.map((c) => (
          <CommentRow key={c.id} comment={c} onLocate={() => {
            const ref = collabAnchorRefOf(doc.documentId, c);
            const el = ref ? findCollabBlock(doc.documentId, ref.nodeId) : null;
            if (el) flash([el]);
          }} />
        ))}
        {orphans.length > 0 && (
          <div style={{ padding: 12, borderTop: '1px solid #e5e7eb' }} data-vs-orphan-list>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
              {orphans.length} orphaned — the block they pointed at is gone
            </div>
            {orphans.map(({ comment, targetText }) => (
              <div key={comment.id} style={card} data-vs-orphan={comment.id}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', letterSpacing: 0.3 }}>ORPHANED</div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>{targetText ? `“${targetText}”` : 'no last-known text'}</div>
                <CommentBody comment={comment} />
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function CommentRow({ comment, onLocate }: { comment: CommentRecord; onLocate: () => void }) {
  return (
    <div style={card} data-vs-comment={comment.id}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onLocate} style={locateBtn} title="Show where this comment is anchored" aria-label="Show in document">
          ⌖
        </button>
      </div>
      <CommentBody comment={comment} />
    </div>
  );
}

function CommentBody({ comment }: { comment: CommentRecord }) {
  const author = authorOf(comment);
  return (
    <>
      {author && <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>{author}</div>}
      <div style={{ margin: '2px 0' }}>{comment.comment}</div>
    </>
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
const panel: React.CSSProperties = {
  width: 340,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '1px solid #e5e7eb',
  background: 'white',
};
const panelHeader: React.CSSProperties = { padding: 12, borderBottom: '1px solid #e5e7eb', fontWeight: 700 };
const hint: React.CSSProperties = { padding: 12, opacity: 0.6, fontSize: 13, fontStyle: 'italic' };
const card: React.CSSProperties = { margin: '8px 12px', border: '1px solid #f1f5f9', borderRadius: 8, padding: 8, overflowWrap: 'anywhere' };
const locateBtn: React.CSSProperties = { border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer', font: '14px system-ui' };
