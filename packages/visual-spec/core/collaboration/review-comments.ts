/**
 * review-comments.ts — projecting GitHub Pull Request **review comments** into the
 * comment model the rest of the product already speaks (R-5.1, R-5.16 … R-5.22).
 *
 * WHY THIS EXISTS AND WHY IT IS PURE. `comment-projection.ts` next door projects PR
 * *issue* comments, which carry their anchor in an HTML-comment trailer because an
 * issue comment has nowhere else to put one. A review comment carries `path` and
 * `line` natively, so none of that machinery applies — and this module is reachable
 * from the browser, so it imports no node builtin, no `@lyfie/luthor`, and no react
 * (`ui/browser-safety.test.ts` and `core/bundle-guard.test.ts` fail the build if that
 * changes).
 *
 * ---------------------------------------------------------------------------
 * THREADING IS ONE LEVEL, AND THAT IS AN OBSERVED FACT (R-5.17)
 * ---------------------------------------------------------------------------
 * GitHub flattens reply chains server-side: `in_reply_to_id` always names a thread
 * *root*, never another reply. This was not inferred from the docs — it was provoked:
 * replying to a reply on `metuur-ai/visual-spec-collaboration-test#9` returned an
 * `in_reply_to_id` pointing at the root, not at the reply. It also holds across
 * `microsoft/vscode#280236` (100 comments, 28 replies, 0 nested) and
 * `facebook/react#20915` (10 comments, 8 replies, 0 nested).
 *
 * So `groupIntoThreads` is a single-pass `groupBy`, not a chain walk. If GitHub ever
 * stopped flattening, replies to replies would surface as their own threads rather
 * than being lost — the orphan branch below already handles exactly that shape.
 *
 * ---------------------------------------------------------------------------
 * THE OUTDATED CASE IS WHY THIS MODULE IS CAREFUL (R-6.3 … R-6.7)
 * ---------------------------------------------------------------------------
 * When the text a comment was written about changes, GitHub reports `line: null` and
 * keeps only `original_line`, against an `original_commit_id` that is no longer
 * current. Verified on the spike PR and on two public repositories.
 *
 * `original_line` is a line number **in a different commit**. Using it as a current
 * position would anchor a reviewer's words to whatever prose now happens to sit at
 * that offset — confidently, and wrongly, with nothing in the UI looking off. So this
 * module never does. It reports the thread as outdated and carries the captured
 * snippet; a second stage that actually holds the document text may re-anchor it, and
 * only on an exact unique match.
 *
 * ---------------------------------------------------------------------------
 * THE TWO STAGES, AND WHY BOTH LIVE HERE (R-6.3 / R-6.4 / R-6.7)
 * ---------------------------------------------------------------------------
 * Stage one is *capture*: read the text at `original_line` from the blob at
 * `original_commit_id`. Reading the original line out of the original commit is not
 * the R-6.5 violation — that rule forbids treating `original_line` as a position in
 * the *current* file, and this reads it as a position in the file it actually belongs
 * to. Capture needs the network, so it lives in `review-anchoring.ts`, which the
 * browser never imports; only the clamp and the line lookup are here.
 *
 * Stage two is *re-anchoring*: `projectReviewThreadInDocument` searches the current
 * document for that snippet and upgrades the target to a range on an exact unique hit,
 * leaving `github.isOutdated` set either way. An outdated comment that found its text
 * again is still outdated — the reviewer wrote it against a different commit, and the
 * UI owes the reader that (R-6.10). Neither stage may drop a comment (R-6.9): no
 * snippet, no match, or an ambiguous match all land on a file-level target that is
 * still rendered.
 */
import type { CommentRecord, CommentTarget } from '../editing/comment-doc';
import { DEFAULT_WORKFLOW } from '../editing/comment-doc';

/**
 * One PR review comment, flattened to what the projection needs.
 *
 * `id` is the REST integer, and that is deliberate (R-5.19): `inReplyToId` is an
 * integer, the reply endpoint takes an integer path segment, and the existing
 * `c-<8hex>` record-id bijection is built on it. GraphQL's `PRRC_…` node id is a
 * second id space with no use here — the one GraphQL value we need, resolution, joins
 * back on `databaseId`, which *is* this integer.
 *
 * `position` is GitHub's deprecated diff offset and is deliberately not carried.
 */
export type ReviewComment = {
  id: number;
  /** Always a thread ROOT when present, never another reply. `null` ⇒ this is a root. */
  inReplyToId: number | null;
  path: string;
  /** `null` when the comment has gone outdated — there is no current position. */
  line: number | null;
  startLine: number | null;
  /** The line in `originalCommitId`. NOT a current position — see the header. */
  originalLine: number;
  side: 'LEFT' | 'RIGHT';
  /** `'file'` ⇒ anchored to the document, not to a line, and never outdated (R-6.12). */
  subjectType: 'line' | 'file';
  commitId: string;
  originalCommitId: string;
  /** The only surviving text context once a comment is outdated. */
  diffHunk: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

/** A root plus its replies, in creation order. */
export type ReviewThread = {
  root: ReviewComment;
  replies: ReviewComment[];
};

/** Resolution as GitHub reports it. Read-only here — this system never writes it. */
export type ThreadResolution = {
  /** Thread root's REST integer id — the join key onto a projected record. */
  rootCommentId: number;
  isResolved: boolean;
  isOutdated: boolean;
};

/**
 * A projected review thread: structurally a `CommentRecord`, so `CommentPanel`,
 * `IndicatorLayer`, `resolveMarkdownAnchors` and `buildApplyPrompt` consume it with
 * no change (R-5.16). GitHub identity and the replies ride alongside.
 */
export type ReviewThreadRecord = CommentRecord & {
  github: {
    /** The root's REST integer id — the reply target and the resolution join key. */
    reviewCommentId: number;
    /** `true` ⇒ the thread lost its line; `target` carries no usable position yet. */
    isOutdated: boolean;
    /**
     * `undefined` means the resolution read did not run or failed (R-4.12, R-5.15).
     * That is a third answer and must not be flattened into `false` — "we could not
     * tell" and "nobody resolved it" lead to different UI and a different Ready gate.
     */
    isResolved?: boolean;
    htmlUrl: string;
    user: string;
    updatedAt: string;
  };
  replies: {
    id: number;
    body: string;
    user: string;
    createdAt: string;
    htmlUrl: string;
  }[];
};

type Json = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Map one raw REST review-comment payload onto `ReviewComment`. */
export function toReviewComment(raw: Json): ReviewComment {
  const side = str(raw.side, 'RIGHT');
  return {
    id: typeof raw.id === 'number' ? raw.id : Number.NaN,
    inReplyToId: numOrNull(raw.in_reply_to_id),
    path: str(raw.path),
    line: numOrNull(raw.line),
    startLine: numOrNull(raw.start_line),
    // GitHub always sends one; 0 is not a valid line, so it doubles as "absent".
    originalLine: numOrNull(raw.original_line) ?? 0,
    side: side === 'LEFT' ? 'LEFT' : 'RIGHT',
    subjectType: str(raw.subject_type) === 'file' ? 'file' : 'line',
    commitId: str(raw.commit_id),
    originalCommitId: str(raw.original_commit_id),
    diffHunk: str(raw.diff_hunk),
    body: str(raw.body),
    user: str((raw.user as Json | undefined)?.login),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    htmlUrl: str(raw.html_url),
  };
}

/**
 * Group a **complete** review-comment list into threads (R-5.17).
 *
 * The completeness requirement is not stylistic. Callers must pass every page
 * accumulated: a root on page 1 whose reply lands on page 2 would otherwise project
 * as an orphan on the first call and as a duplicate thread on the second, and nothing
 * downstream could tell that had happened.
 *
 * A reply whose root is absent — the root was deleted — is promoted to a thread of its
 * own rather than dropped (R-5.18). Zero occurrences were observed in the wild, but
 * deleting a comment is reachable from GitHub's UI, and silently losing a reviewer's
 * words is the one outcome worth writing code to prevent.
 */
export function groupIntoThreads(comments: readonly ReviewComment[]): ReviewThread[] {
  const byCreation = (a: ReviewComment, b: ReviewComment) =>
    a.createdAt === b.createdAt ? a.id - b.id : a.createdAt < b.createdAt ? -1 : 1;

  const roots = new Map<number, ReviewThread>();
  const pending: ReviewComment[] = [];

  for (const c of comments) {
    if (c.inReplyToId === null) roots.set(c.id, { root: c, replies: [] });
  }
  for (const c of comments) {
    if (c.inReplyToId === null) continue;
    const thread = roots.get(c.inReplyToId);
    if (thread) thread.replies.push(c);
    else pending.push(c); // orphan — its root is gone
  }

  // Orphans become roots. Group them so several replies to one deleted root stay
  // together instead of fragmenting into a thread each.
  const orphanGroups = new Map<number, ReviewComment[]>();
  for (const c of pending) {
    const key = c.inReplyToId as number;
    const group = orphanGroups.get(key);
    if (group) group.push(c);
    else orphanGroups.set(key, [c]);
  }
  for (const group of orphanGroups.values()) {
    const [first, ...rest] = [...group].sort(byCreation);
    if (first) roots.set(first.id, { root: first, replies: rest });
  }

  const threads = [...roots.values()];
  for (const t of threads) t.replies.sort(byCreation);
  threads.sort((a, b) => byCreation(a.root, b.root));
  return threads;
}

/**
 * Is this thread anchored to a current line?
 *
 * A file-level thread is *not* outdated (R-6.12): it was never anchored to a line, so
 * there is no line for it to lose. Verified — the spike's edit outdated every
 * line-anchored thread on the file while the `subject_type: file` thread kept a usable
 * position and advanced its `commit_id`. That makes the out-of-diff fallback a more
 * durable anchor than a line, not a degraded one.
 */
export function isThreadOutdated(thread: ReviewThread): boolean {
  return thread.root.subjectType === 'line' && thread.root.line === null;
}

/** Record id ⇄ review-comment id. Same `c-<8hex>` shape the comment routes already parse. */
export function reviewRecordIdFor(reviewCommentId: number): string {
  return `c-${reviewCommentId.toString(16).padStart(8, '0')}`;
}

/** Inverse of `reviewRecordIdFor`. `null` for an id that was not projected. */
export function reviewCommentIdFor(recordId: string): number | null {
  const hex = /^c-([0-9a-f]+)$/.exec(recordId)?.[1];
  if (!hex) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Build the `CommentTarget` for a thread.
 *
 * Three shapes, and the distinction is load-bearing:
 *   - anchored line/range → `kind: 'range'` with real line numbers;
 *   - file-level          → `kind: 'file'`, correct and durable;
 *   - outdated            → `kind: 'file'`, because there is no current line and
 *                           `original_line` is not one (R-6.5).
 *
 * An outdated thread still carries `snippet` when the caller captured one, so a later
 * stage holding the document text can re-anchor it on an exact unique match. That
 * upgrade is deliberately not done here: this module has no document to search.
 */
export function targetForThread(thread: ReviewThread, snippet?: string): CommentTarget {
  const { root } = thread;
  if (isThreadOutdated(thread) || root.subjectType === 'file') {
    const target: CommentTarget = { path: root.path, kind: 'file' };
    if (snippet) target.snippet = snippet;
    return target;
  }
  const endLine = root.line as number;
  const startLine = root.startLine ?? endLine;
  const target: CommentTarget = { path: root.path, kind: 'range', startLine };
  if (endLine !== startLine) target.endLine = endLine;
  if (snippet) target.snippet = snippet;
  return target;
}

/**
 * Project one thread into a `CommentRecord`-shaped record (R-5.1, R-5.20).
 *
 * `status` is always `open` here, and that is a rule rather than a default (R-5.21):
 * `status` records whether the **local apply agent** has acted on a comment. Deriving
 * it from GitHub — say, from `isResolved` — would quietly reintroduce a second
 * resolution model and let a local value be mistaken for a remote one.
 */
export function projectReviewThread(
  thread: ReviewThread,
  options: { snippet?: string; heading?: string | null; resolution?: ThreadResolution } = {},
): ReviewThreadRecord {
  const { root, replies } = thread;
  const target = targetForThread(thread, options.snippet);
  if (options.heading !== undefined) target.heading = options.heading;

  return {
    id: reviewRecordIdFor(root.id),
    workflow: DEFAULT_WORKFLOW,
    target,
    comment: root.body,
    status: 'open',
    ts: root.createdAt,
    github: {
      reviewCommentId: root.id,
      isOutdated: isThreadOutdated(thread),
      ...(options.resolution ? { isResolved: options.resolution.isResolved } : {}),
      htmlUrl: root.htmlUrl,
      user: root.user,
      updatedAt: root.updatedAt,
    },
    replies: replies.map((r) => ({
      id: r.id,
      body: r.body,
      user: r.user,
      createdAt: r.createdAt,
      htmlUrl: r.htmlUrl,
    })),
  };
}

/**
 * Re-anchor an outdated thread by its captured snippet — **only** on an exact, unique
 * match (R-6.3 / R-6.4 / R-6.8).
 *
 * Returns the 1-indexed line, or `null` when the snippet occurs zero times or more
 * than once. Both of those land the comment in the document-level list with its
 * captured text, which is an honest place to be.
 *
 * Deliberately not fuzzy. A snippet like "See above." matches six paragraphs, and
 * picking the first is a fabricated claim about what the reviewer meant. Similarity
 * scoring and heading-proximity were both considered and rejected for the same
 * reason: each adds a way to be confidently wrong, and the fallback list costs the
 * reader one extra glance.
 */
export function reanchorBySnippet(documentText: string, snippet: string): number | null {
  const needle = clampSnippet(snippet);
  if (!needle) return null;
  const lines = documentText.split('\n');
  let found: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    // Compare like against like: the snippet was clamped when it was captured, so a
    // line longer than the budget must be clamped too or it could never match itself.
    // Both effects of the clamp fail safe — collapsing whitespace or truncating can
    // only make two lines look equal, and equal means ambiguous, which means no anchor.
    if (clampSnippet(lines[i] ?? '') !== needle) continue;
    if (found !== null) return null; // more than one match — ambiguous, so no anchor
    found = i + 1;
  }
  return found;
}

/**
 * R-6.7 — character budget for a captured snippet.
 *
 * Deliberately the same 160 as `anchor-resolution.ts`'s `TARGET_TEXT_MAX`, which is
 * itself local mode's `snippet` budget: one product, one idea of how much text a
 * comment carries. It is copied rather than imported because `anchor-resolution.ts`
 * serves the retired JSON document format and is slated for deletion; an import would
 * turn a scheduled removal into a breakage.
 */
export const SNIPPET_MAX = 160;

/** Flatten whitespace and clamp to the snippet budget. */
export function clampSnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX) : flat;
}

/**
 * The clamped text at a 1-indexed line of `fileText`, or `''` when there is none.
 *
 * `''` is the honest answer for a line past the end of the blob — which happens, since
 * the blob being read is an old commit's and nothing guarantees it is still that long.
 * An empty snippet re-anchors to nothing, so the comment stays document-level.
 */
export function snippetAtLine(fileText: string, line: number): string {
  if (!Number.isInteger(line) || line < 1) return '';
  return clampSnippet(fileText.split('\n')[line - 1] ?? '');
}

/**
 * The nearest Markdown heading at or above `line`, or `null` when there is none.
 *
 * Captured because `resolveMarkdownAnchors` falls back to matching heading *text* when
 * `data-vs-loc` finds no block at the line — the document may have been re-rendered
 * since. The value is the heading's text without its `#`s, because that fallback
 * compares against `textContent`.
 *
 * Fenced code is skipped: a `# comment` inside a shell block is not a heading, and
 * anchoring by it would name a section that does not exist. This is a *display hint*,
 * never a position — heading proximity may not re-anchor anything (R-6.8).
 */
export function headingAbove(documentText: string, line: number): string | null {
  const lines = documentText.split('\n');
  const limit = Math.min(Math.max(line, 1), lines.length);
  let fence: string | null = null;
  let heading: string | null = null;
  for (let i = 0; i < limit; i += 1) {
    const raw = lines[i] ?? '';
    const mark = /^ {0,3}(```+|~~~+)/.exec(raw)?.[1] ?? null;
    if (fence !== null) {
      // A closing fence is the same character, at least as long as the opening one.
      if (mark !== null && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (mark !== null) {
      fence = mark;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})\s+(.*)$/.exec(raw);
    if (atx) heading = atx[2]?.replace(/\s+#+\s*$/, '').trim() || null;
  }
  return heading;
}

/**
 * Stage two: project a thread **against the document text** (R-6.2 … R-6.4, R-6.9).
 *
 * Three outcomes, and no fourth:
 *   - a current line          → `kind: 'range'` where GitHub says, plus a heading;
 *   - outdated, snippet found exactly once → `kind: 'range'` at the match, heading
 *     captured, and `github.isOutdated` **still true** (R-6.3, R-6.10);
 *   - outdated with no match, an ambiguous match, or no snippet at all → `kind: 'file'`
 *     carrying whatever snippet was captured, so the reader sees the comment and the
 *     text it was written about even though nothing can place it (R-6.4).
 *
 * File-level threads pass through untouched: they are anchored to the document by
 * construction and were never outdated (R-6.12).
 */
export function projectReviewThreadInDocument(
  thread: ReviewThread,
  documentText: string,
  options: { snippet?: string; resolution?: ThreadResolution } = {},
): ReviewThreadRecord {
  const record = projectReviewThread(thread, {
    ...(options.snippet ? { snippet: options.snippet } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
  });

  if (isThreadOutdated(thread) && options.snippet) {
    const line = reanchorBySnippet(documentText, options.snippet);
    if (line !== null) {
      // A single line, not a range: the extent the reviewer selected lived in a commit
      // that is gone, and inventing an end line would be inventing a claim.
      record.target = { path: thread.root.path, kind: 'range', startLine: line, snippet: options.snippet };
    }
  }

  if (record.target.kind === 'range' && typeof record.target.startLine === 'number') {
    record.target.heading = headingAbove(documentText, record.target.startLine);
  }
  return record;
}
