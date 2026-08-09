/**
 * review-comment-source.ts — a pull request review's comments, in the shared panel's shape.
 *
 * WHY THIS EXISTS. Commenting on a document in a checkout used to mean leaving the
 * rendered document entirely: `Start commenting` flipped the pane to raw Markdown with
 * line numbers and put a textarea under it. That is a different act from the one this
 * product teaches everywhere else — click the block you mean, write beside it — and a
 * reviewer who had learned the local surface had to learn a second thing to do the same
 * job. This is the adapter that lets the review reuse `CommentPanel`, the way
 * `collab-comment-source.ts` already lets a collaboration document reuse it.
 *
 * A BLOCK SELECTION IS A LINE RANGE, WHICH IS WHAT A DRAFT ANCHORS TO. `MarkdownSurface`
 * stamps every rendered block with `data-vs-loc`, the inspector reports it as
 * `SelectedTarget.line`, and `ReviewDraftInput` wants `startLine`/`endLine` — so nothing
 * is being approximated here. The raw-source view was never carrying information the
 * rendered one lacks; it was only the view that happened to show line numbers.
 *
 * DRAFT STATUS IS NOT COMMENT STATUS. `CommentRecord.status` is the sidecar's lifecycle
 * (`open` until an apply run marks it `applied`) and the panel lists on it. A draft's own
 * `draft` / `published` is a different axis — where the comment IS, not whether it is
 * still outstanding — so every projected record is `open` and the draft status drives the
 * origin chip and which actions the row offers instead. Collapsing the two would hide
 * every published comment from the panel the moment it was sent.
 */
import type { SelectedTarget } from '../core/app';
import type { ReviewDraft } from './collab-client';
import type { ReviewDraftInput } from '../core/collaboration/review-drafts';
import type { CommentRecord } from '../core/editing/comment-doc';
import { resolveMarkdownAnchors } from './anchor-resolver';
import { flash } from './comment-history-list';
import type { CommentAction, CommentOrigin, CommentPanelSource } from './comment-panel';
import type { IndicatorTarget } from './indicator-layer';

export type ReviewCommentSourceDeps = {
  /** Path of the file on screen, relative to the checkout root — the path GitHub wants. */
  path: string;
  /** The commit the worktree is detached at; a draft records the head it was written against. */
  headSha: string;
  /** Every draft for this pull request; this module keeps the ones on `path`. */
  drafts: readonly ReviewDraft[];
  hold: (input: ReviewDraftInput) => Promise<boolean>;
  publish: (id: string, force?: boolean) => Promise<void>;
  discard: (id: string) => Promise<void>;
  /** Per-draft warning or receipt, already rendered by the caller. */
  notice?: (id: string) => React.ReactNode | null;
};

/** Held on this machine, or already on the pull request. */
function isHeld(draft: ReviewDraft): boolean {
  return draft.status !== 'published';
}

/**
 * R-13.18 — the provenance chip, in the two states a review comment has.
 *
 * "Draft" and not "Your note": on this surface a comment genuinely is on its way out, and
 * the sidecar's wording would describe a personal note that is going nowhere.
 */
function draftOrigin(draft: ReviewDraft): CommentOrigin {
  return isHeld(draft)
    ? { where: 'local', label: 'Draft — not sent' }
    : { where: 'github', label: `On GitHub · #${draft.pullNumber}` };
}

/** The projection the panel lists. See the header on why `status` is always `open`. */
function toRecord(draft: ReviewDraft): CommentRecord {
  return {
    id: draft.id,
    workflow: 'visual-spec',
    target: draft.target,
    comment: draft.comment,
    status: 'open',
    ts: draft.ts,
  } as CommentRecord;
}

function startLineOf(comment: CommentRecord): number | null {
  const { target } = comment;
  if (target.kind === 'file' || typeof target.startLine !== 'number') return null;
  return target.startLine;
}

/**
 * The drafts on one file, oldest first, as a `CommentPanelSource`.
 *
 * `remove` is deliberately NOT supplied. The panel's remove is a delete with a Yes/No
 * confirm, and a published comment must not be deletable from here — it lives on GitHub
 * now, and this system reads that side rather than writing it. Discard is offered as a
 * row action instead, on held drafts only, where it is the honest word for what happens.
 */
export function reviewCommentPanelSource(deps: ReviewCommentSourceDeps): CommentPanelSource {
  const onFile = deps.drafts.filter((d) => d.target.path === deps.path);
  const byId = new Map(onFile.map((d) => [d.id, d]));
  const held = onFile.filter(isHeld);

  return {
    path: deps.path,
    comments: onFile.map(toRecord),
    // Every draft anchors to a line in the checkout at `headSha`; there is no snapshot to
    // have drifted from, so nothing can be orphaned the way a branch's threads can.
    orphans: [],
    // Sections reach into the local sidecar's heading model; a draft posts a line range.
    supportsSections: false,
    // A review comment is sent to GitHub, not handed to a local apply agent.
    supportsWorkflows: false,
    origin: (c) => {
      const draft = byId.get(c.id);
      return draft ? draftOrigin(draft) : { where: 'local', label: 'Draft — not sent' };
    },
    link: (c) => byId.get(c.id)?.published?.htmlUrl,
    notice: (c) => deps.notice?.(c.id) ?? null,
    label: (c) => {
      const line = startLineOf(c);
      const head = c.target.heading ?? '(top)';
      const range = line === null ? '(file)' : `L${line}${c.target.endLine ? `–${c.target.endLine}` : ''}`;
      const draft = byId.get(c.id);
      return `${head} · ${range}${draft ? ` · at ${draft.headSha.slice(0, 7)}` : ''}`;
    },
    locate: (c) => {
      const line = startLineOf(c);
      if (line === null) return;
      const els = resolveMarkdownAnchors({
        startLine: line,
        heading: c.target.heading ?? null,
        ...(typeof c.target.endLine === 'number' ? { endLine: c.target.endLine } : {}),
      });
      if (els.length) flash(els);
    },
    actions: (c): CommentAction[] => {
      const draft = byId.get(c.id);
      if (!draft || !isHeld(draft)) return [];
      return [
        {
          label: 'Discard',
          title: 'Throw this comment away — it is not on GitHub, so this is the end of it',
          tone: 'danger',
          run: () => deps.discard(draft.id),
        },
        { label: 'Send', title: 'Post this comment to the pull request', tone: 'primary', run: () => deps.publish(draft.id) },
      ];
    },
    // Sequential, not `Promise.all`: each publish re-reads the drafts, and the 409s — stale,
    // already published — are per-comment answers the reviewer reads one at a time.
    bulkAction:
      held.length > 0
        ? {
            label: held.length === 1 ? 'Send the draft' : `Send all ${held.length}`,
            title: 'Post these to the pull request',
            tone: 'primary',
            run: async () => {
              for (const draft of held) await deps.publish(draft.id);
            },
          }
        : null,
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
    create: async (selection, text) => {
      const selected = selection[0]!;
      const last = selection[selection.length - 1]!;
      await deps.hold({
        path: deps.path,
        comment: text,
        headSha: deps.headSha,
        startLine: selected.line,
        // What the reviewer clicked, so the row can name it later. Without this every
        // draft's label fell back to "(top)" — a heading the reader never selected.
        heading: (selected.anchor.textContent ?? '').trim().slice(0, 120) || null,
        ...(selection.length > 1 ? { endLine: last.line } : {}),
        // Quoted back if the line falls outside the pull request's diff and the comment has
        // to degrade to file-level. The browser holds the selection; the server re-reading
        // the checkout for it would be a second, disagreeing answer.
        snippet: (selected.anchor.textContent ?? '').trim().slice(0, 400),
      });
    },
  };
}

/**
 * R-6.2 — which blocks carry a review comment, for `IndicatorLayer`.
 *
 * Held and published alike get a marker: the question the marker answers is "has anyone
 * said anything about this block", and where the comment currently lives is the chip's
 * job in the panel, not the margin's.
 */
export function reviewIndicatorTargets(path: string, drafts: readonly ReviewDraft[]): IndicatorTarget[] {
  const byLine = new Map<number, { comments: CommentRecord[]; heading: string | null; endLine?: number }>();
  for (const draft of drafts) {
    if (draft.target.path !== path) continue;
    const record = toRecord(draft);
    const line = startLineOf(record);
    if (line === null) continue;
    const group = byLine.get(line);
    if (group) group.comments.push(record);
    else
      byLine.set(line, {
        comments: [record],
        heading: draft.target.heading ?? null,
        ...(typeof draft.target.endLine === 'number' ? { endLine: draft.target.endLine } : {}),
      });
  }
  return [...byLine.entries()].map(([line, group]) => {
    const count = group.comments.length;
    return {
      comments: group.comments,
      title: count > 1 ? `${count} review comments on line ${line} — show in sidebar` : `Review comment on line ${line} — show in sidebar`,
      ariaLabel: `${count} review comment${count > 1 ? 's' : ''} on line ${line}`,
      element: () =>
        resolveMarkdownAnchors({
          startLine: line,
          heading: group.heading,
          ...(group.endLine !== undefined ? { endLine: group.endLine } : {}),
        })[0] ?? null,
    };
  });
}
