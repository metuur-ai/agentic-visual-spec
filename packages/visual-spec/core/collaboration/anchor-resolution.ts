/**
 * anchor-resolution.ts — where a collaborative comment points (R-6.1 … R-6.5, R-6.7).
 *
 * **There is no ladder** (LLD §6). Identity lives in the canonical JSON and collaborative
 * comments are PR issue comments, which have no diff position — so five of the seven
 * proposed rungs have nothing left to resolve against. What is left is one lookup:
 * `documentId` + `nodeId` against the document. That part is genuinely five lines
 * (`resolveNodeIn`, reused from task 3.1 — there is deliberately no second resolver).
 *
 * The work in this module is the *degraded* states, which are the ones a reviewer
 * actually lives in:
 *
 * | state      | when                                        | anchored | what the UI owes the reader |
 * | ---------- | ------------------------------------------- | -------- | --------------------------- |
 * | `exact`    | node resolves, versions agree (R-6.2)       | yes      | nothing extra               |
 * | `outdated` | node resolves, versions differ (R-6.3)      | yes      | an "outdated" flag — the block moved on under the comment |
 * | `orphaned` | node does not resolve (R-6.4)               | **no**   | show it document-level with its last-known target text, and offer re-anchoring (R-6.5) |
 *
 * An orphan is never discarded (R-6.4). Losing the block a comment points at is a reason
 * to show the comment differently, never a reason to lose the comment.
 *
 * **Versions come from the `nodes` projection, never from the serialized node's own
 * `version` field.** That field is Lexical's node-*class* schema version and has nothing
 * to do with content changing; task 2.2 maintains the projection, and task 7.1's renderer
 * stamps `data-vs-node-version` from the same place. Reading the wrong one would flag
 * every comment in the document outdated.
 *
 * **Where this lives, and why `core/`.** Resolution is pure JSON: a document in, a
 * discriminated state out. Keeping it here makes every state testable without jsdom and
 * lets the routes and jobs use it. The DOM half — turning a resolved anchor into the
 * element task 7.1 stamped — is the only part that needs a browser, and it lives
 * separately in `ui/collab-anchor-resolver.ts`. This module imports no react and no
 * `@lyfie/luthor` (R-3.3, guarded by `core/bundle-guard.test.ts`).
 *
 * **R-6.6 — local mode is not involved.** `ui/anchor-resolver.ts` (`resolveMarkdownAnchors`,
 * DOM- and line-based) is untouched and unimported from here. Collaboration and local mode
 * share no resolver by design; that is what retires the risk of regressing local anchoring.
 *
 * **R-6.1 / R-6.7 — no line, no snippet, no heading.** Not consulted, not required, not
 * mentioned below this docblock. `anchor-resolution.test.ts` asserts it against this
 * file's own source as well as behaviourally.
 */
import type { CollaborationAnchor, CollaborationDocument, CollaborationNode } from './document-protocol';
// The pure module, not `document-store`: this file is reachable from the browser and
// `document-store` imports `node:fs/promises` / `node:path`.
import { resolveNodeIn } from './node-location';
import { nodeTextContent } from './node-identity';

/** R-6.2 / R-6.3 / R-6.4 — the three states a collaborative comment can be in. */
export type CollabAnchorState = 'exact' | 'outdated' | 'orphaned';

/**
 * What resolution is given. This is the whole input — `documentId` and `nodeId` locate,
 * `nodeVersion` only flags, `targetText` is only ever read in the orphan branch (R-6.1).
 *
 * `nodeVersion` and `targetText` are optional and the resolver degrades without them:
 * a comment written before a version was recorded is `exact`, not falsely `outdated`.
 */
export type CollabAnchorRef = {
  documentId: string;
  nodeId: string;
  /** The version the comment was authored against (`CollaborationAnchor.nodeVersion`). */
  nodeVersion?: number;
  /** R-6.5 — last-known target text, carried on the comment. See `COLLAB_TARGET_TEXT_KEY`. */
  targetText?: string;
};

/** Fields common to the two anchored states. */
type AnchoredResolution = {
  documentId: string;
  nodeId: string;
  anchored: true;
  /** Child-index route from `doc.root` (task 3.1's `NodeLocation`). A location, not an identity. */
  path: number[];
  node: CollaborationNode;
  /** Current version from the `nodes` projection; `null` when the projection does not know the node. */
  nodeVersion: number | null;
  /** The version the comment was authored against; `null` when it recorded none. */
  anchorVersion: number | null;
  /** The block's text as it reads *now* — fresher than the comment's own copy. */
  targetText: string;
};

/** R-6.4 — resolution failed. The comment is kept, unanchored, with what it remembers. */
export type OrphanedResolution = {
  state: 'orphaned';
  documentId: string;
  nodeId: string;
  anchored: false;
  /** R-6.5 — last-known target text as recorded on the comment; `''` when it recorded none. */
  targetText: string;
};

export type CollabAnchorResolution =
  | ({ state: 'exact' } & AnchoredResolution)
  | ({ state: 'outdated' } & AnchoredResolution)
  | OrphanedResolution;

/**
 * R-6.5 — the trailer key that carries last-known target text on a collaborative comment.
 *
 * **Why a trailer key.** Once the node is gone from the document there is nowhere else to
 * read the text from: the `nodes` projection entry went with it. So the *comment* must
 * carry it, and the only part of a collaborative comment that survives a GitHub round-trip
 * is task 5.1's trailer (`<!-- visual-spec: documentId=… nodeId=… text=… -->`). This is a
 * protocol addition in the sense that it defines a new well-known key — but not a type
 * change and not a format change: `CommentTrailer` already carries unknown keys through
 * parse/format untouched, exactly as `resolved=` (5.2) and `key=` (5.3) do. No edit to
 * `comment-projection.ts` is needed or made.
 *
 * **What it costs.** It must be captured at comment-creation time (`captureTargetText`),
 * because after the fact it is unrecoverable. It is truncated to `TARGET_TEXT_MAX` — the
 * same budget local mode gives `snippet` — so a comment on a long block does not carry the
 * block into every GitHub API response.
 */
export const COLLAB_TARGET_TEXT_KEY = 'text';

/** Character budget for last-known target text, matching local mode's snippet budget. */
export const TARGET_TEXT_MAX = 160;

/** Trim and clamp a block's text to the trailer budget. */
function clampText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TARGET_TEXT_MAX ? flat.slice(0, TARGET_TEXT_MAX) : flat;
}

/** The current version of `nodeId` per the `nodes` projection, or `null` if unprojected. */
export function collabNodeVersion(doc: CollaborationDocument | null | undefined, nodeId: string): number | null {
  const entry = doc?.nodes?.find((n) => n?.id === nodeId);
  return typeof entry?.version === 'number' ? entry.version : null;
}

/**
 * R-6.5 — the text to record on a comment at creation time, so the comment can still say
 * what it was about after its block is gone. Reads the `nodes` projection first (task 2.2
 * keeps `content` there) and falls back to the serialized subtree. `''` when `nodeId` is
 * not in the document, which is the honest answer — nothing is fabricated.
 */
export function captureTargetText(doc: CollaborationDocument | null | undefined, nodeId: string): string {
  if (!doc) return '';
  const projected = doc.nodes?.find((n) => n?.id === nodeId)?.content;
  if (typeof projected === 'string' && projected.trim()) return clampText(projected);
  const found = resolveNodeIn(doc, nodeId);
  return found.found ? clampText(nodeTextContent(found.node)) : '';
}

/**
 * R-6.1 — resolve a collaborative comment by `documentId` + `nodeId`, and by nothing else.
 *
 * A `documentId` that is not this document's is not a lookup miss to retry another way, it
 * is an orphan: the comment belongs elsewhere and this document cannot anchor it.
 */
export function resolveCollabAnchor(
  ref: CollabAnchorRef,
  doc: CollaborationDocument | null | undefined,
): CollabAnchorResolution {
  const orphan = (): OrphanedResolution => ({
    state: 'orphaned',
    documentId: ref.documentId,
    nodeId: ref.nodeId,
    anchored: false,
    targetText: ref.targetText ? clampText(ref.targetText) : '',
  });

  if (!doc || doc.documentId !== ref.documentId) return orphan();
  const found = resolveNodeIn(doc, ref.nodeId);
  if (!found.found) return orphan(); // R-6.4 — kept, unanchored.

  const nodeVersion = collabNodeVersion(doc, ref.nodeId);
  const anchorVersion = typeof ref.nodeVersion === 'number' ? ref.nodeVersion : null;
  // R-6.3 — a mismatch needs two known versions. One unknown is not a mismatch (R-6.2).
  const outdated = nodeVersion !== null && anchorVersion !== null && nodeVersion !== anchorVersion;

  return {
    state: outdated ? 'outdated' : 'exact',
    documentId: ref.documentId,
    nodeId: ref.nodeId,
    anchored: true,
    path: found.path,
    node: found.node,
    nodeVersion,
    anchorVersion,
    targetText: captureTargetText(doc, ref.nodeId) || (ref.targetText ? clampText(ref.targetText) : ''),
  };
}

/**
 * R-6.5 — the orphans among `refs`, in input order, each paired with its resolution so the
 * document-level discussion view can render the marker and the last-known text without
 * resolving twice.
 */
export function orphanedAnchors<T extends CollabAnchorRef>(
  refs: readonly T[],
  doc: CollaborationDocument | null | undefined,
): { ref: T; resolution: OrphanedResolution }[] {
  const out: { ref: T; resolution: OrphanedResolution }[] = [];
  for (const ref of refs) {
    const resolution = resolveCollabAnchor(ref, doc);
    if (resolution.state === 'orphaned') out.push({ ref, resolution });
  }
  return out;
}

/**
 * R-6.5 — manual re-anchoring: given an orphaned comment's anchor and a block the reader
 * picked, produce the anchor that points at that block. Pure; the caller persists it.
 *
 * Returns `null` — never a half-built anchor — when the chosen `nodeId` does not resolve in
 * the tree, or when the `nodes` projection has no version for it. Both refusals are the
 * same rule: re-anchoring to a block the renderer will not version-stamp would produce an
 * anchor that can never be compared, i.e. a comment that is silently `exact` forever.
 *
 * Unknown fields on the anchor and its `github` binding are carried through (R-1.8); the
 * GitHub binding is preserved exactly, because re-anchoring changes what the comment points
 * at, not which GitHub comment it is.
 */
export function reanchorCollabAnchor(
  anchor: CollaborationAnchor,
  doc: CollaborationDocument | null | undefined,
  nodeId: string,
): CollaborationAnchor | null {
  if (!doc || !nodeId) return null;
  if (!resolveNodeIn(doc, nodeId).found) return null;
  const nodeVersion = collabNodeVersion(doc, nodeId);
  if (nodeVersion === null) return null;
  return { ...anchor, nodeId, nodeVersion };
}
