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
import type { DocumentFrontmatter, JsonDocument } from '../core/collaboration/document-protocol';
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

/**
 * A frontmatter key the emitted YAML block cannot represent. Reported on the same
 * channel as `droppedNodes` so an author sees the loss before publishing, rather
 * than discovering it in the merged artifact.
 */
export type DroppedFrontmatterReport = {
  key: string;
  /** Only cause today: the value is not a scalar or an array of scalars. */
  reason: 'unsupported-type';
};

/** What a publish request carries. Task 8.3 consumes this shape verbatim. */
export type PublishPayload = {
  /** The canonical document — the artifact of record. */
  json: JsonDocument;
  /** Derived from `json`, write-only (R-2.10). */
  markdown: string;
  /** Nodes the Markdown drops. Empty when nothing is lost. */
  droppedNodes: readonly DroppedNodeReport[];
  /** Frontmatter keys the YAML block drops. Empty when nothing is lost. */
  droppedFrontmatter: readonly DroppedFrontmatterReport[];
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

type EmittableScalar = string | number | boolean;

function isEmittableScalar(value: unknown): value is EmittableScalar {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  // `NaN`/`Infinity` have no YAML 1.1 spelling that round-trips across parsers.
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Double-quoted YAML. `JSON.stringify`'s escape set (`\"`, `\\`, `\n`, `\t`,
 * `\uXXXX`) is a strict subset of YAML's double-quoted escape set, so this is
 * safe for every string — including ones holding newlines or leading `#`.
 */
function emitScalar(value: EmittableScalar): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function emitKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

/** Flow-style array, or `null` if any element is not an emittable scalar. */
function emitArray(value: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const item of value) {
    if (!isEmittableScalar(item)) return null;
    parts.push(emitScalar(item));
  }
  return `[${parts.join(', ')}]`;
}

/**
 * Serialize authored frontmatter to a YAML block (option B — scalars and arrays
 * of scalars only).
 *
 * This is deliberately *not* `metadataMode: 'preserve'`: that emits Luthor's own
 * `luthor:meta` envelope, which R-2.9 exists to keep out of the artifact. Authored
 * frontmatter lives on the collaboration envelope beside `doc`, so it is prepended
 * here and the body stays envelope-free.
 *
 * Anything richer than a scalar (nested maps, arrays of arrays, `null`) is dropped
 * and reported rather than approximated — a wrong value in a published artifact is
 * worse than a visibly absent one. Key order is `title` first, then alphabetical,
 * so re-publishing an unchanged document produces byte-identical output.
 */
export function serializeFrontmatter(frontmatter: DocumentFrontmatter): {
  block: string;
  dropped: DroppedFrontmatterReport[];
} {
  const dropped: DroppedFrontmatterReport[] = [];
  const lines: string[] = [];

  const keys = Object.keys(frontmatter).sort((a, b) => {
    if (a === b) return 0;
    if (a === 'title') return -1;
    if (b === 'title') return 1;
    return a < b ? -1 : 1;
  });

  for (const key of keys) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    if (isEmittableScalar(value)) {
      lines.push(`${emitKey(key)}: ${emitScalar(value)}`);
      continue;
    }
    const asArray = Array.isArray(value) ? emitArray(value) : null;
    if (asArray !== null) {
      lines.push(`${emitKey(key)}: ${asArray}`);
    } else {
      dropped.push({ key, reason: 'unsupported-type' });
    }
  }

  // No emittable keys means no block at all — never a bare `---\n---`, which would
  // put an empty frontmatter fence at the top of every artifact.
  const block = lines.length === 0 ? '' : `---\n${lines.join('\n')}\n---\n\n`;
  return { block, dropped };
}

/**
 * Build the publish payload. **Calls `readDocument` exactly once**; `json` and
 * `markdown` are both derived from that one snapshot (R-12.8).
 *
 * `frontmatter` comes from the collaboration envelope, which the reader cannot
 * see — it is a sibling of `doc`, not part of the document JSON.
 */
export function generatePublishPayload(
  readDocument: PublishDocumentSource,
  frontmatter: DocumentFrontmatter = {},
): PublishPayload {
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

  const { block, dropped: droppedFrontmatter } = serializeFrontmatter(frontmatter);
  const markdown = block + headless.jsonToMarkdown(json, { metadataMode: 'none' });

  return { json, markdown, droppedNodes, droppedFrontmatter };
}
