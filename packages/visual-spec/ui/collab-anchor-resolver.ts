/**
 * collab-anchor-resolver.ts — the DOM half of collaborative anchor resolution (R-6.1 …
 * R-6.4). The *state* half is `core/collaboration/anchor-resolution.ts`, which is pure
 * JSON and needs no browser; this file exists only because indicators and the comment
 * panel eventually need the element task 7.1 stamped, and `document` lives here.
 *
 * It is deliberately thin: one lookup by the identity attributes, no fallbacks. If the
 * block is not in the DOM there is nothing to point at, and guessing a nearby element
 * would put a comment on a paragraph it was never about.
 *
 * **R-6.6 — this is not the local resolver and does not call it.** `ui/anchor-resolver.ts`
 * (`resolveMarkdownAnchors`) is DOM- and line-based, local-mode only, and untouched. This
 * module never imports it, never reads `data-vs-loc`, and never looks at a line number,
 * a snippet or a heading (R-6.1). The two paths are separate by design.
 *
 * Named `collab*` so task 2.4's import-boundary lint covers it: it reads JSON and DOM
 * attributes, never Markdown.
 */
import type { CollabAnchorResolution } from '../core/collaboration/anchor-resolution';
import { VS_UNCOMMENTABLE_ATTR, collabBlockSelector } from './collab-document-view';

/** The default search root, or `null` outside a browser. */
function defaultRoot(): ParentNode | null {
  return typeof document !== 'undefined' ? document : null;
}

/**
 * The rendered block for one document + node, or `null`. Never throws.
 *
 * A block the renderer marked uncommentable (`data-vs-uncommentable`) carries no id, so it
 * can never match — which is the point: an anchor to it could not have been created.
 */
export function findCollabBlock(
  documentId: string,
  nodeId: string,
  root: ParentNode | null = defaultRoot(),
): HTMLElement | null {
  if (!root || !documentId || !nodeId) return null;
  const el = root.querySelector(collabBlockSelector(documentId, nodeId)) as HTMLElement | null;
  return el && el.hasAttribute(VS_UNCOMMENTABLE_ATTR) ? null : el;
}

/**
 * The element an already-resolved anchor points at. `null` for an orphan (R-6.4) — it is
 * unanchored by definition and belongs in the document-level view (R-6.5), not on a block
 * — and `null` for an anchored state whose block is not currently rendered.
 *
 * `outdated` resolves to its element exactly like `exact` does (R-6.3): the version flag
 * changes how the comment is *presented*, never where it points.
 */
export function resolveCollabAnchorElement(
  resolution: CollabAnchorResolution,
  root: ParentNode | null = defaultRoot(),
): HTMLElement | null {
  if (!resolution.anchored) return null;
  return findCollabBlock(resolution.documentId, resolution.nodeId, root);
}
