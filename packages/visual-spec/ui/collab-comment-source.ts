/**
 * collab-comment-source.ts — task 7.3. The collaboration half of the shared comment UI.
 *
 * This is the module that makes `resolveCollabAnchor` (task 6.1) *live*: it turns the
 * comments projected off a Pull Request into the two shapes the shared components take —
 * `IndicatorTarget[]` for `IndicatorLayer` and a `CommentPanelSource` for `CommentPanel`
 * — so collaboration reuses those components rather than forking them (R-7.4).
 *
 * Everything here keys on `nodeId` and nothing else (R-6.1 / R-6.7): no line, no snippet,
 * no heading. The three resolution states are presented, not flattened:
 *
 *   exact     → a marker on the block, plain.
 *   outdated  → a marker on the same block, rendered `state: 'stale'` (R-6.3 anchors it
 *               exactly and flags it; the flag changes presentation, never placement).
 *   orphaned  → NO marker. It goes to `orphans`, which the panel renders document-level
 *               with its last-known target text and an explicit marker (R-6.4 / R-6.5).
 *
 * **Uncommentable blocks (R-7.3).** `image`, `iframe-embed` and `youtube-embed` reach the
 * store without a durable `nodeId`, so task 7.1 stamps them `data-vs-uncommentable`.
 * `describe()` returns `{ uncommentable }` for a selection inside one, which withdraws the
 * panel's compose form. Offering a comment there would promise an anchor the store cannot
 * keep — the comment would be born orphaned.
 *
 * **R-6.6 / R-10.6 — the local resolver is not involved.** `resolveMarkdownAnchors` is
 * neither imported nor reachable from here; blocks are located with `findCollabBlock`,
 * which queries the identity attributes only. `flash` is reused from the history list
 * because it is pure scroll-and-highlight styling with no anchoring in it.
 */
import {
  COLLAB_TARGET_TEXT_KEY,
  type CollabAnchorRef,
  type CollabAnchorResolution,
  resolveCollabAnchor,
} from '../core/collaboration/anchor-resolution';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import type { CommentTrailer } from '../core/collaboration/comment-projection';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { SelectedTarget } from '../core/app';
import { VS_NODE_ID_ATTR, VS_UNCOMMENTABLE_ATTR } from './collab-document-view';
import { findCollabBlock } from './collab-anchor-resolver';
import { flash } from './comment-history-list';
import type { IndicatorTarget } from './indicator-layer';
import type { CommentPanelSource } from './comment-panel';

/** The trailer a projected comment carries (task 5.1). Absent on a hand-built record. */
function trailerOf(comment: CommentRecord): CommentTrailer {
  return ((comment as { collab?: CommentTrailer }).collab ?? {}) as CommentTrailer;
}

/**
 * The anchor a comment claims, or `null` when it claims none — a comment with no
 * `nodeId` is a document-level discussion (R-5.7), not an orphan.
 */
export function collabAnchorRefOf(documentId: string, comment: CommentRecord): CollabAnchorRef | null {
  const trailer = trailerOf(comment);
  const nodeId = trailer.nodeId;
  if (!nodeId) return null;
  const version = Number(trailer.nodeVersion);
  return {
    documentId,
    nodeId,
    ...(Number.isFinite(version) && trailer.nodeVersion !== undefined ? { nodeVersion: version } : {}),
    ...(trailer[COLLAB_TARGET_TEXT_KEY] ? { targetText: trailer[COLLAB_TARGET_TEXT_KEY] as string } : {}),
  };
}

/** One node's open comments plus the single resolution they share. */
type NodeGroup = { nodeId: string; comments: CommentRecord[]; resolution: CollabAnchorResolution };

/**
 * Group open, node-anchored comments by `nodeId` and resolve each group once. Comments
 * with no `nodeId` are skipped — they have no block to point at by construction.
 */
function groupByNode(doc: CollaborationDocument, comments: readonly CommentRecord[]): NodeGroup[] {
  const byNode = new Map<string, CommentRecord[]>();
  for (const comment of comments) {
    if (comment.status !== 'open') continue;
    const ref = collabAnchorRefOf(doc.documentId, comment);
    if (!ref) continue;
    const bucket = byNode.get(ref.nodeId);
    if (bucket) bucket.push(comment);
    else byNode.set(ref.nodeId, [comment]);
  }
  return [...byNode.entries()].map(([nodeId, group]) => ({
    nodeId,
    comments: group,
    resolution: resolveCollabAnchor(collabAnchorRefOf(doc.documentId, group[0]!)!, doc),
  }));
}

/**
 * R-6.2 / R-6.3 — the markers `IndicatorLayer` places in collaboration mode. Orphans are
 * deliberately absent: an unanchored comment has no block to sit on (R-6.4).
 */
export function collabIndicatorTargets(
  doc: CollaborationDocument,
  comments: readonly CommentRecord[],
  root?: ParentNode | null,
): IndicatorTarget[] {
  const targets: IndicatorTarget[] = [];
  for (const group of groupByNode(doc, comments)) {
    if (!group.resolution.anchored) continue;
    const count = group.comments.length;
    const stale = group.resolution.state === 'outdated';
    const suffix = stale ? ' (block edited since)' : '';
    targets.push({
      comments: group.comments,
      title:
        count > 1
          ? `${count} comments on this block${suffix} — show in sidebar`
          : `Comment on this block${suffix} — show in sidebar`,
      ariaLabel: `${count} pending comment${count > 1 ? 's' : ''} on this block${suffix}`,
      ...(stale ? { state: 'stale' as const } : {}),
      element: () => findCollabBlock(doc.documentId, group.nodeId, root),
    });
  }
  return targets;
}

/** R-6.5 — the comments whose block is gone, paired with what they remember of it. */
export function collabOrphans(
  doc: CollaborationDocument,
  comments: readonly CommentRecord[],
): { comment: CommentRecord; targetText: string }[] {
  const out: { comment: CommentRecord; targetText: string }[] = [];
  for (const comment of comments) {
    if (comment.status !== 'open') continue;
    const ref = collabAnchorRefOf(doc.documentId, comment);
    if (!ref) continue;
    const resolution = resolveCollabAnchor(ref, doc);
    if (resolution.state === 'orphaned') out.push({ comment, targetText: resolution.targetText });
  }
  return out;
}

/** The block a selection sits in, and whether it can be commented on at all. */
function blockOf(anchor: HTMLElement): { nodeId: string } | { uncommentable: string } {
  const blocked = anchor.closest(`[${VS_UNCOMMENTABLE_ATTR}]`) as HTMLElement | null;
  if (blocked) return { uncommentable: blocked.getAttribute(VS_UNCOMMENTABLE_ATTR) || 'it carries no durable identity' };
  const block = anchor.closest(`[${VS_NODE_ID_ATTR}]`) as HTMLElement | null;
  const nodeId = block?.getAttribute(VS_NODE_ID_ATTR);
  if (!nodeId) return { uncommentable: 'it is not an identified block of this document' };
  return { nodeId };
}

export type CollabCommentSourceDeps = {
  document: CollaborationDocument;
  /** Comments projected off the Pull Request (task 5.1). */
  comments: CommentRecord[];
  /** R-7.5 — persist against `nodeId`. Goes to `POST /__vs/collab/:id/comments`. */
  add: (input: { nodeId: string; comment: string; workflow: string }) => Promise<void>;
  /**
   * R-9.8 — post a threaded reply. Goes to `POST /__vs/collab/:id/comments/:cid/reply`.
   */
  reply: (id: string, text: string) => Promise<void>;
  /**
   * Marks the comment applied. Named `remove` because that is the `CommentPanelSource`
   * seam it fills — it takes the comment off the open list — but nothing is deleted:
   * GitHub keeps the thread (R-5.2), so the panel is told to say "Resolve".
   */
  remove: (id: string) => Promise<void>;
  /** Where the document is rendered. Defaults to the whole document. */
  root?: ParentNode | null;
};

/** The `CommentPanel` source for a collaboration document. */
export function collabCommentPanelSource(deps: CollabCommentSourceDeps): CommentPanelSource {
  const doc = deps.document;
  const labels = new Map<string, string>();
  for (const group of groupByNode(doc, deps.comments)) {
    const text = group.resolution.anchored ? group.resolution.targetText : '';
    const flag = group.resolution.state === 'outdated' ? ' · outdated' : '';
    for (const c of group.comments) labels.set(c.id, `${text || group.nodeId}${flag}`);
  }
  const orphans = collabOrphans(doc, deps.comments);
  const orphaned = new Set(orphans.map((o) => o.comment.id));
  return {
    path: doc.documentPath,
    // Orphans have their own section (R-5.6); listing them twice would double-render them.
    comments: deps.comments.filter((c) => !orphaned.has(c.id)),
    remove: deps.remove,
    reply: deps.reply,
    removeVerb: { action: 'Resolve', confirm: 'Resolve?' },
    orphans,
    supportsSections: false,
    label: (c) => labels.get(c.id) ?? '(document)',
    locate: (c) => {
      const ref = collabAnchorRefOf(doc.documentId, c);
      const el = ref ? findCollabBlock(doc.documentId, ref.nodeId, deps.root) : null;
      if (el) flash([el]);
    },
    describe: (selection: SelectedTarget[]) => {
      const block = blockOf(selection[0]!.anchor);
      if ('uncommentable' in block) return block;
      const resolution = resolveCollabAnchor({ documentId: doc.documentId, nodeId: block.nodeId }, doc);
      return {
        title: (resolution.anchored ? resolution.targetText : '') || '(block)',
        detail: ` · block ${block.nodeId}`,
      };
    },
    create: async (selection, text, workflow) => {
      const block = blockOf(selection[0]!.anchor);
      if ('uncommentable' in block) return; // no anchor to persist against (R-7.5)
      await deps.add({ nodeId: block.nodeId, comment: text, workflow: workflow || 'visual-spec' });
    },
  };
}
