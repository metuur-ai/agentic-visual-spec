/**
 * collab-editor.tsx — the author's edit surface for a collaboration document.
 *
 * WHAT IT IS NOW. The document is the Markdown (R-0.1), so the editor edits Markdown:
 * `SourceEditor` over the record's bytes, with the buffer, the dirty check and the
 * publish payload all being the same string. `publish()` hands back exactly what
 * `POST /:id/publish` commits (R-8.9), so there is no derivation step between what the
 * author saw and what lands on the branch — and therefore no loss channel to report.
 *
 * WHAT IT WAS, AND WHY THAT IS GONE. It used to mount Luthor over a canonical
 * `JsonDocument`, carry `nodeId` identity through Lexical `NodeState`, and derive the
 * Markdown at publish time through `generatePublishPayload` — which also enumerated
 * everything Markdown could not express. All of that existed to protect block identity
 * across an edit. With Markdown canonical there is no second representation to keep in
 * step, GitHub's own outdated-comment semantics take identity's place, and the derivation
 * that produced the losses does not happen.
 *
 * DIRTY DETECTION IS STRING EQUALITY, and that is the point rather than a simplification:
 * the buffer is the artifact, so "changed" means the bytes differ from the baseline. The
 * two-stage signature the Lexical mount needed — Lexical's dirty sets, then a content
 * signature that ignored `$` and `direction` — was machinery for a lossless tree that
 * reported an edit every time the caret moved. None of it applies to a string.
 *
 * Fidelity-first, like the local source editor: nothing normalizes, reformats or
 * re-parses the buffer on its way through (R-8.12 says the server treats it as opaque
 * bytes; it would be pointless for the client to have already rewritten them).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollaborationRecord } from '../core/collaboration/document-record';
import { SourceEditor } from './source-editor';

/** What `publish()` produces: the whole payload, which is the document (R-8.9). */
export type CollabPublishPayload = { markdown: string };

/** The imperative surface of a mounted collaboration editor. */
export type CollabEditorHandle = {
  /** One read of the live buffer. */
  readMarkdown(): string;
  /** R-8.9 — the publish payload. One artifact, byte-identical to the buffer. */
  publish(): CollabPublishPayload;
  isDirty(): boolean;
  /** Adopt the current buffer as the clean baseline — after a successful publish. */
  markClean(): void;
};

export function CollabEditor({
  document: source,
  onMarkdownChange,
  onDirtyChange,
  onEditorReady,
}: {
  document: CollaborationRecord;
  /** The live buffer, emitted on every edit. */
  onMarkdownChange?: (markdown: string) => void;
  /** Fired on transitions only, never repeated. */
  onDirtyChange?: (dirty: boolean) => void;
  onEditorReady?: (handle: CollabEditorHandle) => void;
}) {
  const [value, setValue] = useState(source.markdown);
  /** The clean state. Every dirty verdict is measured against this and nothing else. */
  const baseline = useRef(source.markdown);
  const live = useRef(source.markdown);
  const dirty = useRef(false);

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  onMarkdownChangeRef.current = onMarkdownChange;
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;

  const setDirty = useCallback((next: boolean) => {
    if (dirty.current === next) return;
    dirty.current = next;
    onDirtyChangeRef.current?.(next);
  }, []);

  // A different document is a different buffer. Re-adopting an external revision of the
  // SAME document (a sync from GitHub) is deliberately not wired here — reload does it.
  const mountedId = useRef(source.documentId);
  useEffect(() => {
    if (source.documentId === mountedId.current) return;
    mountedId.current = source.documentId;
    baseline.current = source.markdown;
    live.current = source.markdown;
    setValue(source.markdown);
    setDirty(false);
  }, [source.documentId, source.markdown, setDirty]);

  useEffect(() => {
    onEditorReadyRef.current?.({
      readMarkdown: () => live.current,
      publish: () => ({ markdown: live.current }),
      isDirty: () => dirty.current,
      markClean: () => {
        baseline.current = live.current;
        setDirty(false);
      },
    });
  }, [setDirty]);

  const onChange = useCallback(
    (next: string) => {
      live.current = next;
      setValue(next);
      setDirty(next !== baseline.current);
      onMarkdownChangeRef.current?.(next);
    },
    [setDirty],
  );

  return (
    <div style={wrap} className="vs-collab-editor">
      {/* Publishing is a deliberate act on the toolbar above, so ⌘S is a no-op here
          rather than a second, quieter way to write to a remote branch. */}
      <SourceEditor value={value} onChange={onChange} onSave={() => {}} />
    </div>
  );
}

const wrap: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'white',
  overflow: 'hidden',
};
