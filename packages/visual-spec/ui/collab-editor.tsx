/**
 * collab-editor.tsx — the collaboration mount of Luthor's `ExtensiveEditor`,
 * driven from structured state (R-2.11).
 *
 * WHY THIS IS A SECOND MOUNT RATHER THAN A PORT OF `ui/wysiwyg-editor.tsx`
 * ----------------------------------------------------------------------
 * The local editor is the shipped product and R-10.1 rates a local regression
 * worse than collaboration not shipping. Its buffer is a Markdown string it owns
 * end to end (`value` in, `onChange(md)` out), its dirty check is
 * `md === lastSynced.current` (`:136`), and it sets `markdownSourceOfTruth`. None
 * of those can survive here — a document that must keep `nodeId` cannot be a
 * Markdown string, and under `markdownSourceOfTruth` Luthor implements
 * `getJSON()` as `markdownToJSON(getMarkdown())`, so every id is stripped on the
 * way out (task 0.1, finding 3). Changing the local editor's buffer type is not a
 * refactor of its dirty detection, it is a replacement of it — and the 120 lines
 * of interaction heuristics that make it stable have no test coverage.
 * `core/collaboration/import-boundary.test.ts` already draws the same line: the
 * local editor "imports `markdownToInjectable` and must keep doing so — it is the
 * local editor's load path, explicitly out of scope for this feature".
 *
 * So local mode keeps its Markdown path, byte for byte, and collaboration gets
 * this module. Nothing here is imported by the local viewer.
 *
 * DIRTY DETECTION — the crux
 * --------------------------
 * Markdown is lossy and normalizing, which is exactly what makes string equality
 * a *stable* dirty check in local mode: caret position, node keys and selection
 * cannot survive into the projection. `getJSON()` is lossless, so the naive port
 * ("compare the whole `getJSON()` output") reports an edit every time the caret
 * moves. Two stages replace it:
 *
 *   1. **Lexical's own dirty sets** (`dirtyElements` / `dirtyLeaves` on the update
 *      listener). A selection-only update touches no node, so it is discarded
 *      without serializing anything. This is a cost filter, never the verdict —
 *      a real edit always marks nodes dirty, so it cannot hide an edit.
 *   2. **A content signature** of the serialized document — `collabDocumentSignature`
 *      below — compared against the baseline. This is the verdict, and it is what
 *      makes the check self-validating: anything that leaves the content equal is
 *      not an edit, whatever the editor did internally to get there.
 *
 * The signature deliberately ignores two things and nothing else:
 *
 *   - **`$` (NodeState)** — where `nodeId` lives. Assigning or re-issuing an id is
 *     identity work, not content, so a backfill on load can never read as an edit.
 *     This is the same definition of "content" `core/collaboration/node-identity.ts`
 *     uses for version bumping (R-2.6/R-2.7), and it is reused, not restated.
 *   - **`direction`** — Lexical derives it from the text during reconciliation and
 *     writes it back into the node, so it can flip from `null` to `"ltr"` on a
 *     reconcile the user did not cause. It carries no information the text does not
 *     already carry: text change ⇒ signature change anyway.
 *
 * Not ignored, on purpose: text, formatting marks, `format`/`indent`/`tag`/
 * `listType`, and child structure. Node keys and the selection never appear —
 * Lexical does not serialize either.
 *
 * There are no DOM listeners and no MutationObserver. Local mode needs them
 * because `getMarkdown()` is too expensive to run per mutation and a
 * MutationObserver cannot tell a load-settling reflow from an edit; here stage 1
 * already answers that question with the editor's own bookkeeping.
 *
 * THE DEFERRED `injectJSON`
 * -------------------------
 * Luthor defers `injectJSON` behind a 100 ms `setTimeout`, so the injected state
 * is not readable on the next line and any update observed before it lands belongs
 * to the load, not to the user. The inject itself must also be issued one
 * macrotask after `onReady` rather than inside it — see the load below. The baseline is therefore captured `INJECT_SETTLE_MS`
 * after the inject, **from the editor itself** rather than from the document that
 * was injected — whatever settling Luthor does (reconciler-assigned `direction`,
 * normalization) is baked into the baseline by construction, so a load can never
 * read as dirty. Until the baseline exists nothing is reported at all.
 *
 * This file imports Luthor and therefore must stay under `ui/`;
 * `core/bundle-guard.test.ts` fails the build if Luthor becomes reachable from the
 * CLI or Vite-plugin host entrypoints.
 */
import './prism-global'; // must precede @lyfie/luthor — sets the global Prism it needs
import { ExtensiveEditor, headless, type ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import type { LexicalEditor } from 'lexical';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollaborationDocument, JsonDocument } from '../core/collaboration/document-protocol';
import { nodeContentSignature, reconcileDocumentIdentity } from '../core/collaboration/node-identity';
import { type NodeIdGenerator, createNodeIdExtension, createRandomNodeId } from './node-id-extension';
import { type PublishPayload, generatePublishPayload } from './publish-payload';

/**
 * How long to wait for `injectJSON` before adopting the editor's state as the
 * clean baseline. Luthor's own defer is 100 ms; the margin covers the parse and
 * the reconcile it schedules.
 */
export const INJECT_SETTLE_MS = 150;

/** Fields the signature drops, with the reason. See the header for the argument. */
const DERIVED_FIELDS = new Set(['direction']);

/**
 * The comparison dirty detection is built on: a document reduced to its content.
 * `$` and key order are dropped by `nodeContentSignature` (the R-2.6 definition of
 * "content", reused so the editor and the store cannot disagree about what an edit
 * is); `direction` is dropped here.
 */
export function collabDocumentSignature(doc: JsonDocument | null | undefined): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (!DERIVED_FIELDS.has(key)) out[key] = strip(inner);
      }
      return out;
    }
    return value;
  };
  return nodeContentSignature(strip(doc?.root ?? {}));
}

/** The imperative surface of a mounted collaboration editor. */
export type CollabEditorHandle = {
  /** The live editor, for callers that need to place a caret or focus a block. */
  editor: LexicalEditor;
  /** One read of live structured state (R-2.11) — never a Markdown string. */
  readDocument(): JsonDocument;
  /**
   * Build a publish payload. The reader closure is this editor's own
   * `getJSON()`, called exactly once by `generatePublishPayload`, so the JSON and
   * the Markdown cannot come from two different editor states (R-12.8).
   */
  publish(): PublishPayload;
  isDirty(): boolean;
  /** Adopt the current state as the clean baseline — after a successful publish. */
  markClean(): void;
};

export function CollabEditor({
  document: source,
  onDocumentChange,
  onDirtyChange,
  onEditorReady,
  generateNodeId,
}: {
  document: CollaborationDocument;
  /** Structured state, emitted when the content actually changed (R-2.11). */
  onDocumentChange?: (doc: JsonDocument) => void;
  /** Fired on transitions only, never repeated. */
  onDirtyChange?: (dirty: boolean) => void;
  onEditorReady?: (handle: CollabEditorHandle) => void;
  /** Injected for deterministic tests; defaults to the module's random generator. */
  generateNodeId?: NodeIdGenerator;
}) {
  const api = useRef<ExtensiveEditorRef | null>(null);
  /** The clean state's signature — `null` until the deferred inject has settled. */
  const baseline = useRef<string | null>(null);
  /** The last signature handed to `onDocumentChange`. */
  const emitted = useRef<string | null>(null);
  const dirty = useRef(false);

  const onDocumentChangeRef = useRef(onDocumentChange);
  onDocumentChangeRef.current = onDocumentChange;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const generateNodeIdRef = useRef(generateNodeId);
  generateNodeIdRef.current = generateNodeId;

  // A different document is a different editor: remount so no state leaks across.
  // Re-adopting an external revision of the SAME document (a sync from GitHub) is
  // task 8.x's concern and deliberately not wired here.
  const [gen, setGen] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const mountedId = useRef(source.documentId);
  useEffect(() => {
    if (source.documentId === mountedId.current) return;
    mountedId.current = source.documentId;
    baseline.current = null;
    emitted.current = null;
    dirty.current = false;
    setGen((g) => g + 1);
  }, [source.documentId]);

  const readDocument = (): JsonDocument => {
    const a = api.current;
    if (!a) throw new Error('collab editor: read before the editor was ready');
    return JSON.parse(a.getJSON()) as JsonDocument;
  };

  /**
   * The signature of the live document, or `null` while the editor cannot be read.
   * Serialization only happens once stage 1 has already established that nodes
   * changed.
   */
  const liveSignature = (): string | null => {
    try {
      return collabDocumentSignature(readDocument());
    } catch {
      return null;
    }
  };

  const setDirty = (next: boolean): void => {
    if (dirty.current === next) return;
    dirty.current = next;
    onDirtyChangeRef.current?.(next);
  };

  // Two extensions, created once: the `nodeId` transforms (task 2.1) and the
  // update listener dirty detection rides on. Both live in extensions because
  // `initialize` is where the live editor is handed over, and both must be torn
  // down with it.
  const extensions = useMemo(
    () => [
      createNodeIdExtension({ generateNodeId: () => (generateNodeIdRef.current ?? createRandomNodeId)() }),
      headless.createExtension({
        name: 'vs-collab-dirty',
        initialize: (editor: LexicalEditor) => {
          onEditorReadyRef.current?.({
            editor,
            readDocument,
            publish: () => generatePublishPayload(() => api.current?.getJSON() ?? ''),
            isDirty: () => dirty.current,
            markClean: () => {
              const signature = liveSignature();
              if (signature === null) return;
              baseline.current = signature;
              setDirty(false);
            },
          });
          return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
            // Stage 1 — the editor's own bookkeeping. A selection-only update
            // (caret move, arrow key, clicking the comment pill) touches no node,
            // so it costs nothing and is never mistaken for an edit.
            if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
            if (baseline.current === null) return; // still loading
            // Stage 2 — the verdict. Nodes were marked dirty; only the content
            // signature can say whether anything actually changed.
            const signature = liveSignature();
            if (signature === null) return;
            setDirty(signature !== baseline.current);
            if (signature !== emitted.current) {
              emitted.current = signature;
              onDocumentChangeRef.current?.(readDocument());
            }
          });
        },
      }),
    ],
    // Every value the closures read is a ref, so this is created exactly once and
    // the extensions never churn across renders.
    [],
  );

  // THE LOAD, and the two things that make its timing load bearing.
  //
  // 1. The inject is issued one macrotask AFTER `onReady`, not inside it. Luthor
  //    runs its own initial-content pass in the same tick as `onReady`, and it
  //    overwrites an editor state injected during that tick — the document mounts
  //    as a single empty paragraph, silently. Yielding once is enough.
  // 2. The baseline is then taken `INJECT_SETTLE_MS` later, because Luthor defers
  //    the inject itself behind a 100 ms `setTimeout`, and is read back out of the
  //    EDITOR rather than from the document that went in, so whatever settling
  //    happens is part of the clean state by construction.
  const timers = useRef<number[]>([]);
  const loadedGen = useRef(-1);
  const load = (): void => {
    const a = api.current;
    if (!a) return;
    // Identity first: `injectJSON` runs no node transforms, so a document that
    // arrives without ids would be mounted without any (R-2.8). The reconcile is
    // a no-op on a document that already has them.
    try {
      const reconciled = reconcileDocumentIdentity(sourceRef.current, { generateNodeId: generateNodeIdRef.current });
      a.injectJSON(JSON.stringify(reconciled.document.doc));
    } catch (err) {
      // A failed load would strand the reviewer in an empty editor over a
      // non-empty document — surface it rather than swallow (data-loss shaped).
      console.error('[visual-spec] failed to load the collaboration document into the editor', err);
    }
    timers.current.push(
      window.setTimeout(() => {
        baseline.current = liveSignature();
        emitted.current = baseline.current;
      }, INJECT_SETTLE_MS),
    );
  };
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  return (
    <div style={wrap} className="vs-luthor vs-collab-editor">
      <ExtensiveEditor
        key={gen}
        onReady={(methods) => {
          api.current = methods;
          if (loadedGen.current === gen) return; // `onReady` can fire on re-render
          loadedGen.current = gen;
          timers.current.push(window.setTimeout(load, 0));
        }}
        extraExtensions={extensions}
        showDefaultContent={false}
        sourceMetadataMode="none"
        defaultEditorView="visual"
        isEditorViewTabsVisible={false}
        toolbarPosition="top"
        isToolbarEnabled
        placeholder="Start writing…"
      />
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
