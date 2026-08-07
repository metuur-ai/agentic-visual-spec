/**
 * publish-payload.ts — the single generation point for a publish payload
 * (R-2.9 … R-2.11, R-12.8).
 *
 * A publish carries two artifacts: the canonical `json` document that stays the
 * artifact of record, and the `markdown` that lands in the repository. The server
 * treats that Markdown as opaque bytes (R-8.12), so **no server-side check can
 * catch a client that serialized the two from different states**. The only
 * defence is that both come from one document object read at one instant — which
 * is what this module exists to guarantee.
 *
 * How the guarantee is made structural rather than conventional:
 *
 *   - the caller hands in a *reader*, and this function calls it **exactly once**;
 *   - that one read is immediately turned into a detached snapshot (a `JSON.parse`
 *     of the editor's JSON string, or a `structuredClone` of a document object),
 *     so nothing the editor does afterwards can reach either artifact;
 *   - `markdown` is derived from that snapshot, never from live editor state.
 *
 * Deliberately **not** reused: `normalizeForStore(a.getMarkdown(), …)`
 * (`ui/wysiwyg-editor.tsx:135`). It takes a *second, independent* read of live
 * editor state — so the JSON and the Markdown could come from different editor
 * states — and it rewrites image srcs for the local viewer, which has no meaning
 * in a published artifact. Both properties are exactly what this task removes.
 *
 * R-2.10: the Markdown produced here is write-only. Nothing parses it back;
 * reconstruction always goes through the JSON.
 *
 * This file imports Luthor and therefore must stay under `ui/` —
 * `core/bundle-guard.test.ts` fails the build if Luthor becomes reachable from the
 * CLI or Vite-plugin host entrypoints.
 */
import { headless } from '@lyfie/luthor';
import type { JsonDocument } from '../core/collaboration/document-protocol';
import { getSerializedNodeId } from './node-id-extension';

/**
 * A node the published Markdown cannot represent. Reported, never silently
 * dropped, so the UI can warn before the publish (LLD §2). `path` is the
 * child-index route from `root`, matching `DocumentStore.resolveNode`.
 */
export type DroppedNodeReport = {
  /** `nodeId` if the node carries one — absent for the unserializable types. */
  nodeId?: string;
  type: string;
  path: readonly number[];
  /** The placeholder text that takes the node's place in the Markdown. */
  fallback: string;
};

/** What a publish request carries. Task 8.3 consumes this shape verbatim. */
export type PublishPayload = {
  /** The canonical document — the artifact of record. */
  json: JsonDocument;
  /** Derived from `json`, write-only (R-2.10). */
  markdown: string;
  /** Nodes the Markdown drops. Empty when nothing is lost. */
  droppedNodes: readonly DroppedNodeReport[];
};

/**
 * A single read of the document to publish. In the browser this is
 * `() => editorRef.current.getJSON()` (R-2.11 — structured state, not a Markdown
 * string buffer); a caller that already holds the document may return it directly.
 */
export type PublishDocumentSource = () => string | JsonDocument;

/** Detach the read from whatever still owns it, so later edits cannot reach it. */
function snapshot(read: string | JsonDocument): JsonDocument {
  const parsed = typeof read === 'string' ? JSON.parse(read) : structuredClone(read);
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as JsonDocument).root !== 'object') {
    throw new Error('publish payload: document source did not yield a JsonDocument ({ root })');
  }
  return parsed as JsonDocument;
}

/**
 * Build the publish payload. **Calls `readDocument` exactly once**; `json` and
 * `markdown` are both derived from that one snapshot (R-12.8).
 */
export function generatePublishPayload(readDocument: PublishDocumentSource): PublishPayload {
  const json = snapshot(readDocument());

  // Detection only — `prepareDocumentForBridge` returns an envelope per node the
  // Markdown bridge cannot represent. The envelopes are never appended to the
  // output: `metadataMode: 'none'` keeps the published artifact envelope-free
  // (R-2.9), and Markdown is never the return path anyway (R-2.10).
  const prepared = headless.prepareDocumentForBridge(json, {
    mode: 'markdown',
    supportedNodeTypes: headless.MARKDOWN_SUPPORTED_NODE_TYPES,
  });
  const droppedNodes: DroppedNodeReport[] = prepared.envelopes.map((envelope) => ({
    ...(getSerializedNodeId(envelope.node) ? { nodeId: getSerializedNodeId(envelope.node) } : {}),
    type: envelope.type,
    path: envelope.path,
    fallback: envelope.fallback,
  }));

  const markdown = headless.jsonToMarkdown(json, { metadataMode: 'none' });

  return { json, markdown, droppedNodes };
}
