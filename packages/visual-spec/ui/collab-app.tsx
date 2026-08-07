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
import { useCallback, useMemo, useRef, useState } from 'react';
import { InspectorProvider } from '../core/app';
import type { ProjectedCommentRecord } from '../core/collaboration/comment-projection';
import { deriveReadiness, type ReadinessVerdict } from '../core/collaboration/failure-states';
import type { CommentRecord } from '../core/editing/comment-doc';
import { collabCommentPanelSource } from './collab-comment-source';
import { CollabDocumentView } from './collab-document-view';
import { CollabEditor, type CollabEditorHandle } from './collab-editor';
import { CollabOpenPanel } from './collab-open-panel';
import { CommentPanel, type CommentPanelSource } from './comment-panel';
import type { PublishLoss, PublishPayload } from './publish-payload';
import { useCollabDocument } from './use-collab-document';

/**
 * WHY THE TWO MODES ARE A TOGGLE AND NOT ONE SURFACE.
 *
 * `CommentPanel` anchors on `[data-vs-node-id]`, which `CollabDocumentView` stamps onto
 * the rendered DOM. A live Lexical tree does not carry those attributes, so mounting the
 * editor and the comment panel side by side would present a panel whose every anchor
 * silently fails to locate. Rather than ship a half-working anchor, the author edits in
 * one mode and works comments in the other — the same document, two views of it.
 *
 * Closing this properly means teaching the editor to stamp node ids onto its rendered
 * DOM, which is a real piece of work in Luthor's reconciler and is not this task.
 */
type PaneMode = 'review' | 'edit';

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
  const { document, fullDocument, comments, loading, error, addComment, replyToComment, removeComment, publish } =
    useCollabDocument(documentId);
  // `locate` scopes its query to the rendered document rather than the whole page.
  const docRoot = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<PaneMode>('review');
  const editor = useRef<CollabEditorHandle | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Non-null while a publish is staged and awaiting the author's confirmation. */
  const [staged, setStaged] = useState<StagedPublish | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  /**
   * R-8.15 — unresolved comments block publishing. `deriveLifecycleState` also decides
   * `merged` / `closed` / `conflicted`, but those arms need the Pull Request's
   * `state` / `merged` / `mergeable`, which no route hands the browser today. Gating on
   * the half we can actually derive is honest; claiming the other half would not be.
   */
  const readiness = useMemo(() => deriveReadiness(comments.filter(isProjected)), [comments]);

  /** R-5.10 — publishing is initiated by a person. This runs from a click, never a hook. */
  const stagePublish = useCallback(() => {
    setPublishError(null);
    const handle = editor.current;
    if (!handle) return;
    const payload = handle.publish();
    setStaged({ json: payload.json, markdown: payload.markdown, losses: payload.losses });
  }, []);

  const confirmPublish = useCallback(async () => {
    if (!staged) return;
    setPublishing(true);
    setPublishError(null);
    const result = await publish({ json: staged.json, markdown: staged.markdown });
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
          {mode === 'edit' && !readiness.ready && (
            <div style={blockedBanner}>
              {readiness.unresolved} of {readiness.total} comment
              {readiness.total === 1 ? '' : 's'} unresolved — resolve them before publishing.
            </div>
          )}
          <div ref={docRoot} style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 56px 120px' }}>
            {mode === 'review' ? (
              <CollabDocumentView document={fullDocument} />
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
      {staged && (
        <PublishConfirm
          losses={staged.losses}
          busy={publishing}
          error={publishError}
          onCancel={() => setStaged(null)}
          onConfirm={confirmPublish}
        />
      )}
    </InspectorProvider>
  );
}

/** The payload held between staging a publish and the author confirming it. */
type StagedPublish = Pick<PublishPayload, 'json' | 'markdown' | 'losses'>;

/**
 * The comment routes answer projected records, but `CollabClient` types them as the wider
 * `CommentRecord`, so the narrowing has to happen somewhere. It happens here rather than
 * with a cast because the predicate is also the right product rule: a record with no
 * `github` was never posted, so no reviewer can have resolved it and it cannot be the
 * thing standing between an author and a publish.
 */
function isProjected(comment: CommentRecord): comment is ProjectedCommentRecord {
  // The base record does not declare these at all — they are the projection's own
  // additions — so the check reads them through a widened view.
  const candidate = comment as Partial<ProjectedCommentRecord>;
  return typeof candidate.github?.issueCommentId === 'number' && candidate.collab !== undefined;
}

/** Names the blocking reason rather than leaving a disabled control unexplained. */
function publishBlockedReason(dirty: boolean, readiness: ReadinessVerdict): string | undefined {
  if (!readiness.ready) {
    return `${readiness.unresolved} of ${readiness.total} comment(s) unresolved`;
  }
  if (!dirty) return 'No changes to publish';
  return undefined;
}

/**
 * R-2.10 — publishing is lossy by construction for node types Markdown cannot express.
 * `generatePublishPayload` already computes exactly what will be lost; this is the surface
 * that tells the author before the commit rather than after it.
 */
function PublishConfirm({
  losses,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  losses: readonly PublishLoss[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div role="dialog" aria-label="Confirm publish" style={dialogScrim}>
      <div style={dialogCard}>
        <strong>Publish to the branch?</strong>
        {losses.length === 0 ? (
          <p style={dialogBody}>The Markdown carries everything in this document.</p>
        ) : (
          <>
            <p style={dialogBody}>
              {losses.length} {losses.length === 1 ? 'thing' : 'things'} cannot be expressed in Markdown and will not
              survive the round trip. The canonical JSON keeps {losses.length === 1 ? 'it' : 'them'}.
            </p>
            <ul style={dialogList}>
              {losses.map((loss, i) => (
                <li key={`${loss.source}:${loss.subject}:${loss.nodeId ?? i}`}>
                  <code>{loss.subject}</code> ({loss.source}) —{' '}
                  {loss.visibility === 'placeholder' ? `replaced by ${loss.fallback ?? 'a placeholder'}` : 'dropped'}
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <p style={dialogError}>{error}</p>}
        <div style={dialogActions}>
          <button type="button" onClick={onCancel} disabled={busy} style={backBtn}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} style={publishBtn}>
            {busy ? 'Publishing…' : 'Publish'}
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
};
const title: React.CSSProperties = { fontWeight: 700, color: '#334155' };
const centerMsg: React.CSSProperties = { flex: 1, display: 'grid', placeItems: 'center', opacity: 0.6 };
const docPane: React.CSSProperties = { flex: 1, minWidth: 0, position: 'relative', overflow: 'auto', background: '#f8fafc' };
const docTitleBar: React.CSSProperties = { padding: '14px 56px 0', font: '14px system-ui', color: '#334155' };

const publishBtn: React.CSSProperties = {
  padding: '4px 14px',
  borderRadius: 6,
  border: '1px solid #2563eb',
  background: '#2563eb',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
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
const dialogList: React.CSSProperties = { fontSize: 12, lineHeight: 1.6, paddingLeft: 20 };
const dialogError: React.CSSProperties = { fontSize: 12, color: '#b91c1c' };
const dialogActions: React.CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 };
