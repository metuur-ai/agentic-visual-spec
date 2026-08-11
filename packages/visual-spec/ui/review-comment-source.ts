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
import { type CommentAction, type CommentOrigin, type CommentPanelSource, toPanelReply } from './comment-panel';
import type { ReviewThreadRecord } from '../core/collaboration/review-comments';
import type { IndicatorTarget } from './indicator-layer';

export type ReviewCommentSourceDeps = {
  /** Path of the file on screen, relative to the checkout root — the path GitHub wants. */
  path: string;
  /** The commit the worktree is detached at; a draft records the head it was written against. */
  headSha: string;
  /** Every draft for this pull request; this module keeps the ones on `path`. */
  drafts: readonly ReviewDraft[];
  /**
   * Every review thread ON the pull request, from `GET /pulls/:n/comments` — all files.
   *
   * These are the conversation; the drafts are this machine's outbox. A published draft
   * and its thread are the same comment seen from two sides, and the thread wins: it is
   * the one that knows whether anybody replied.
   */
  threads?: readonly ReviewThreadRecord[];
  /** The pull request number, for the "On GitHub · #N" chip on a thread nobody here drafted. */
  pullNumber: number;
  hold: (input: ReviewDraftInput) => Promise<boolean>;
  publish: (id: string, force?: boolean) => Promise<void>;
  discard: (id: string) => Promise<void>;
  /**
   * R-7.15 — answer a thread on the pull request. `id` is the thread root's record id.
   *
   * Optional because the caller owns the write: the reply goes to GitHub and the thread
   * list has to be re-read afterwards, and both of those live with the pull request one
   * level up, not with the file on screen.
   */
  reply?: (id: string, text: string) => Promise<void>;
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

/**
 * The chip for a thread read back from the pull request.
 *
 * Resolution is stated only when GitHub told us (R-4.12 / R-5.15): `isResolved` is
 * three-valued, and an unknown printed as "open" would be a claim nobody made.
 */
function threadOrigin(thread: ReviewThreadRecord, pullNumber: number): CommentOrigin {
  const resolved = thread.github.isResolved === true ? ' · resolved' : '';
  return { where: 'github', label: `On GitHub · #${pullNumber}${resolved}` };
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
  const threadsOnFile = (deps.threads ?? []).filter((t) => t.target.path === deps.path);
  const byThreadId = new Map(threadsOnFile.map((t) => [t.id, t]));
  const onGitHub = new Set(threadsOnFile.map((t) => t.github.reviewCommentId));

  /*
   * A published draft whose thread is in the list is dropped, not shown twice.
   *
   * The two are one comment. The draft is what this machine remembers posting — the text
   * at the moment it was sent, and nothing since; the thread is what the pull request has
   * now, replies included. Keeping both would print the reviewer's own sentence twice,
   * once with the answer to it and once without.
   */
  const onFile = deps.drafts.filter(
    (d) => d.target.path === deps.path && !(d.published && onGitHub.has(d.published.reviewCommentId)),
  );
  const byId = new Map(onFile.map((d) => [d.id, d]));
  const held = onFile.filter(isHeld);

  // Oldest first, across both sources — the conversation in the order it happened.
  const comments = [...onFile.map(toRecord), ...threadsOnFile].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return {
    path: deps.path,
    comments,
    // Every draft anchors to a line in the checkout at `headSha`; there is no snapshot to
    // have drifted from, so nothing can be orphaned the way a branch's threads can.
    orphans: [],
    // Sections reach into the local sidecar's heading model; a draft posts a line range.
    supportsSections: false,
    // A review comment is sent to GitHub, not handed to a local apply agent.
    supportsWorkflows: false,
    origin: (c) => {
      const thread = byThreadId.get(c.id);
      if (thread) return threadOrigin(thread, deps.pullNumber);
      const draft = byId.get(c.id);
      return draft ? draftOrigin(draft) : { where: 'local', label: 'Draft — not sent' };
    },
    link: (c) => byThreadId.get(c.id)?.github.htmlUrl ?? byId.get(c.id)?.published?.htmlUrl,
    replies: (c) => (byThreadId.get(c.id)?.replies ?? []).map(toPanelReply),
    /*
     * Answering happens here now, not only on github.com.
     *
     * The panel could already SHOW a thread's replies while offering no way to add one,
     * which sent a reviewer who wanted to answer out to the browser and back. The reply
     * is GitHub's own — `POST /pulls/:n/comments/:id/reply` — so it inherits the thread's
     * anchor and appears the same to everyone reading the pull request.
     */
    ...(deps.reply ? { reply: deps.reply } : {}),
    // Only a thread has a root for a reply to hang off. A held draft is not on the pull
    // request yet, and a published one is listed as its thread (see the dedupe above).
    canReply: (c) => byThreadId.has(c.id),
    notice: (c) => deps.notice?.(c.id) ?? null,
    label: (c) => {
      const line = startLineOf(c);
      const head = c.target.heading ?? '(top)';
      const range = line === null ? '(file)' : `L${line}${c.target.endLine ? `–${c.target.endLine}` : ''}`;
      const thread = byThreadId.get(c.id);
      if (thread) {
        // An outdated thread lost its line to a later commit; the row says so rather than
        // printing "(file)" and letting the reader think it was always file-level.
        return `${thread.github.user} · ${range}${thread.github.isOutdated ? ' · outdated' : ''}`;
      }
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
 *
 * `threads` are the pull request's own, and they count for the same reason — a block
 * somebody else commented on is a block that has been said something about. Without them
 * the margin claimed a file was unremarked when the pull request had a conversation on it.
 */
export function reviewIndicatorTargets(
  path: string,
  drafts: readonly ReviewDraft[],
  threads: readonly ReviewThreadRecord[] = [],
): IndicatorTarget[] {
  const byLine = new Map<number, { comments: CommentRecord[]; heading: string | null; endLine?: number }>();
  const add = (record: CommentRecord): void => {
    if (record.target.path !== path) return;
    const line = startLineOf(record);
    if (line === null) return;
    const group = byLine.get(line);
    if (group) group.comments.push(record);
    else
      byLine.set(line, {
        comments: [record],
        heading: record.target.heading ?? null,
        ...(typeof record.target.endLine === 'number' ? { endLine: record.target.endLine } : {}),
      });
  };
  // Same de-duplication as the panel: a published draft and its thread are one comment,
  // and a line with one comment on it must not report two.
  const onGitHub = new Set(threads.map((t) => t.github.reviewCommentId));
  for (const draft of drafts) {
    if (draft.published && onGitHub.has(draft.published.reviewCommentId)) continue;
    add(toRecord(draft));
  }
  for (const thread of threads) add(thread);
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
