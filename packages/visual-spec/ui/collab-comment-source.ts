/**
 * collab-comment-source.ts — the collaboration half of the shared comment UI.
 *
 * It turns the review threads projected off a Pull Request into the two shapes the shared
 * components take — `IndicatorTarget[]` for `IndicatorLayer` and a `CommentPanelSource`
 * for `CommentPanel` — so collaboration reuses those components rather than forking them
 * (R-7.4).
 *
 * R-6.6 — THERE IS ONE ANCHOR RESOLVER, AND IT IS THE LOCAL ONE. A projected thread is a
 * `CommentRecord` with an ordinary `CommentTarget` (`path` + `startLine`/`endLine`, or
 * `kind: 'file'`), and the review surface renders Markdown stamped with `data-vs-loc`
 * (R-7.3). So `resolveMarkdownAnchors` — the resolver local mode already uses — locates a
 * collaborative comment too. The second resolver this module used to carry, keyed on
 * `nodeId`, went with the format that issued the ids.
 *
 * The three states are presented, not flattened:
 *
 *   anchored          → a marker on the block, plain.
 *   anchored, outdated → a marker on the same block, rendered `state: 'stale'` (R-6.3
 *                       anchors it and flags it; the flag changes presentation, never
 *                       placement — R-6.10).
 *   unanchored        → NO marker. It goes to `orphans`, which the panel renders
 *                       document-level with the text it was written about (R-6.4 / R-6.9).
 *
 * Nothing here re-anchors anything. `projectReviewThreadInDocument` already decided, on
 * the server, whether an outdated thread's snippet matched exactly once (R-6.8), and a
 * second opinion in the browser could only disagree with it.
 */
import type { CollaborationRecord } from '../core/collaboration/document-record';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
import type { CommentRecord } from '../core/editing/comment-doc';
import type { SelectedTarget } from '../core/app';
import { resolveMarkdownAnchors } from './anchor-resolver';
import { flash } from './comment-history-list';
import type { IndicatorTarget } from './indicator-layer';
import type { CommentPanelSource } from './comment-panel';

/** R-6.10 — a thread GitHub reports as having lost its line. */
function isOutdated(comment: CommentRecord): boolean {
  return (comment as Partial<ReviewThreadRecord>).github?.isOutdated === true;
}

/**
 * The line a comment anchors to, or `null` when it anchors to none.
 *
 * `kind: 'file'` covers both R-6.12's file-level thread and R-6.4's unanchored one: in
 * neither case is there a line, and the document-level list is where both belong.
 */
function lineOf(comment: CommentRecord): number | null {
  const { target } = comment;
  if (target.kind === 'file' || typeof target.startLine !== 'number') return null;
  return target.startLine;
}

/** One line's open comments, plus whether the block moved on under them. */
type LineGroup = { line: number; comments: CommentRecord[]; heading: string | null; endLine?: number; stale: boolean };

function groupByLine(record: CollaborationRecord, comments: readonly CommentRecord[]): LineGroup[] {
  const byLine = new Map<number, LineGroup>();
  for (const comment of comments) {
    if (comment.status !== 'open') continue;
    if (comment.target.path !== record.documentPath) continue;
    const line = lineOf(comment);
    if (line === null) continue;
    const group = byLine.get(line);
    if (group) {
      group.comments.push(comment);
      group.stale = group.stale && isOutdated(comment);
    } else {
      byLine.set(line, {
        line,
        comments: [comment],
        heading: comment.target.heading ?? null,
        ...(typeof comment.target.endLine === 'number' ? { endLine: comment.target.endLine } : {}),
        stale: isOutdated(comment),
      });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** R-6.2 / R-6.3 — the markers `IndicatorLayer` places in collaboration mode. */
export function collabIndicatorTargets(
  record: CollaborationRecord,
  comments: readonly CommentRecord[],
  root?: ParentNode | null,
): IndicatorTarget[] {
  return groupByLine(record, comments).map((group) => {
    const count = group.comments.length;
    const suffix = group.stale ? ' (the text moved since)' : '';
    return {
      comments: group.comments,
      title:
        count > 1
          ? `${count} comments on line ${group.line}${suffix} — show in sidebar`
          : `Comment on line ${group.line}${suffix} — show in sidebar`,
      ariaLabel: `${count} pending comment${count > 1 ? 's' : ''} on line ${group.line}${suffix}`,
      ...(group.stale ? { state: 'stale' as const } : {}),
      element: () =>
        resolveMarkdownAnchors(
          {
            startLine: group.line,
            heading: group.heading,
            ...(group.endLine !== undefined ? { endLine: group.endLine } : {}),
          },
          root === undefined ? undefined : root,
        )[0] ?? null,
    };
  });
}

/**
 * R-6.4 / R-6.9 — the comments that carry no line, paired with what they were written
 * about. Includes a comment on another file, which is a real thing to receive on a Pull
 * Request and must not be hidden just because it is not about this document.
 */
export function collabOrphans(
  record: CollaborationRecord,
  comments: readonly CommentRecord[],
): { comment: CommentRecord; targetText: string }[] {
  const out: { comment: CommentRecord; targetText: string }[] = [];
  for (const comment of comments) {
    if (comment.status !== 'open') continue;
    if (comment.target.path === record.documentPath && lineOf(comment) !== null) continue;
    const other = comment.target.path !== record.documentPath ? `${comment.target.path} — ` : '';
    out.push({ comment, targetText: `${other}${comment.target.snippet ?? ''}`.trim() });
  }
  return out;
}

/**
 * R-5.14 — where this thread lives on github.com.
 *
 * A resolved thread is deliberately not linked: R-5.14 asks for the way to the act, and
 * for a thread already resolved there is no act left. A thread whose `isResolved` could
 * not be read (`undefined`) IS linked — "we could not tell" is not "it is done" (R-5.15),
 * and github.com is exactly where a reader settles it.
 *
 * A record with no `github` was never posted — a hand-built one in a test, say — so it
 * has no thread to open and gets no link.
 */
function threadLink(comment: CommentRecord): string | undefined {
  const github = (comment as Partial<ReviewThreadRecord>).github;
  if (!github?.htmlUrl || github.isResolved === true) return undefined;
  return github.htmlUrl;
}

export type CollabCommentSourceDeps = {
  document: CollaborationRecord;
  /** Threads projected off the Pull Request. */
  comments: CommentRecord[];
  /** R-7.5 — persist against the selected line range. Goes to `POST /:id/comments`. */
  add: (input: {
    comment: string;
    workflow: string;
    startLine?: number;
    endLine?: number;
    selectedText?: string;
  }) => Promise<void>;
  /** R-9.8 — post a threaded reply. Goes to `POST /:id/comments/:cid/reply`. */
  reply: (id: string, text: string) => Promise<void>;
  /*
   * There is deliberately no `remove` and no `restore` here. Both used to write a
   * resolution — `remove` posted a "resolved" marker reply, `restore` posted its inverse —
   * and R-5.13 forbids this system writing resolution at all. A thread is resolved by a
   * reviewer on github.com, and `threadLink` above is how a reader gets there (R-5.14).
   */
  /** Where the document is rendered. Defaults to the whole document. */
  root?: ParentNode | null;
};

/** The `CommentPanel` source for a collaboration document. */
export function collabCommentPanelSource(deps: CollabCommentSourceDeps): CommentPanelSource {
  const record = deps.document;
  const orphans = collabOrphans(record, deps.comments);
  const orphaned = new Set(orphans.map((o) => o.comment.id));
  return {
    path: record.documentPath,
    // Orphans have their own section (R-5.7); listing them twice would double-render them.
    comments: deps.comments.filter((c) => !orphaned.has(c.id)),
    reply: deps.reply,
    link: threadLink,
    orphans,
    // Section selection reaches into the local sidecar's heading model; collaboration
    // posts a line range and has no use for it.
    supportsSections: false,
    label: (c) => {
      const line = lineOf(c);
      const head = c.target.heading ?? '(top)';
      const range = line === null ? '(document)' : `L${line}${c.target.endLine ? `–${c.target.endLine}` : ''}`;
      return `${head} · ${range}${isOutdated(c) ? ' · outdated' : ''}`;
    },
    locate: (c) => {
      const line = lineOf(c);
      if (line === null) return;
      const els = resolveMarkdownAnchors(
        {
          startLine: line,
          heading: c.target.heading ?? null,
          ...(typeof c.target.endLine === 'number' ? { endLine: c.target.endLine } : {}),
        },
        deps.root === undefined ? undefined : deps.root,
      );
      if (els.length) flash(els);
    },
    describe: (selection: SelectedTarget[]) => {
      const selected = selection[0]!;
      const last = selection[selection.length - 1]!;
      return {
        title: (selected.anchor.textContent ?? '').trim().slice(0, 80) || '(block)',
        detail:
          selection.length > 1
            ? ` · lines ${selected.line}–${last.line} · ${selection.length} blocks`
            : ` · line ${selected.line}`,
      };
    },
    create: async (selection, text, workflow) => {
      const selected = selection[0]!;
      const last = selection[selection.length - 1]!;
      await deps.add({
        comment: text,
        workflow: workflow || 'visual-spec',
        startLine: selected.line,
        ...(selection.length > 1 ? { endLine: last.line } : {}),
        // R-7.12 — quoted back into the body if the line is outside the PR's diff and the
        // comment has to degrade to file-level. The browser holds the selection; the
        // server re-reading the branch for it would be a second, disagreeing answer.
        selectedText: (selected.anchor.textContent ?? '').trim().slice(0, 400),
      });
    },
  };
}
