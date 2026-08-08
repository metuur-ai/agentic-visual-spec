/**
 * review-anchoring.ts — stage one of the outdated path: capturing what a review comment
 * was written about, and handing the whole projection to the routes (R-6.3 … R-6.9).
 *
 * WHY THIS IS A SEPARATE MODULE. `review-comments.ts` is reachable from the browser and
 * may not import a node builtin (`ui/browser-safety.test.ts`, `core/bundle-guard.test.ts`).
 * Capture needs the GitHub adapter, which shells out to `gh`. So the split is drawn at
 * the network: every decision — clamp, exact-unique match, heading — stays pure next
 * door, and the only thing here is fetching blobs and joining the results. Nothing in
 * `ui/` may import this file.
 *
 * WHAT CAPTURE ACTUALLY READS. For an outdated thread GitHub gives `original_line`
 * against `original_commit_id`, and freezes `commit_id` at the same sha — verified on
 * `metuur-ai/visual-spec-collaboration-test#9`. Neither is a current position, and this
 * module never treats them as one (R-6.5). It reads line `original_line` of the blob at
 * `original_commit_id`, which is the one commit where that line number is meaningful,
 * and the result is *text*, not a position. Turning that text back into a position is
 * `reanchorBySnippet`'s job and happens only on an exact unique match (R-6.8).
 *
 * EVERY FAILURE DEGRADES, NONE THROWS (R-6.9). A deleted blob, a rewritten history, a
 * 404, a rate limit — each costs the comment its snippet and nothing else. The comment
 * still projects, still renders, and lands document-level with its GitHub link. Losing a
 * reviewer's words because a fetch failed is the one outcome not on the table.
 */
import type { GitHubAdapter, RepoRef } from './github-adapter';
import {
  type ReviewThread,
  type ReviewThreadRecord,
  type ThreadResolution,
  groupIntoThreads,
  isThreadOutdated,
  projectReviewThread,
  projectReviewThreadInDocument,
  snippetAtLine,
} from './review-comments';

/**
 * Capture the snippet for every outdated thread, keyed by root comment id.
 *
 * Blobs are fetched once per `path@commit` and shared: a thread, its neighbours and the
 * replies around it were all outdated by the same edit, so the recorded PR's three
 * outdated comments name exactly one blob between them. A thread with no entry in the
 * returned map is one whose text could not be read — see the header.
 */
export async function captureOutdatedSnippets(
  adapter: GitHubAdapter,
  repo: RepoRef,
  threads: readonly ReviewThread[],
): Promise<Map<number, string>> {
  const blobs = new Map<string, Promise<string | null>>();
  const snippets = new Map<number, string>();

  const blobFor = (path: string, ref: string): Promise<string | null> => {
    const key = `${ref}:${path}`;
    let pending = blobs.get(key);
    if (!pending) {
      // The catch is the point: a failed read is a missing snippet, not a failed load.
      pending = adapter
        .getFile(repo, path, ref)
        .then((file) => file?.content ?? null)
        .catch(() => null);
      blobs.set(key, pending);
    }
    return pending;
  };

  await Promise.all(
    threads.filter(isThreadOutdated).map(async (thread) => {
      const { root } = thread;
      if (!root.originalCommitId || !root.path) return;
      const content = await blobFor(root.path, root.originalCommitId);
      if (content === null) return;
      // `originalLine` indexes the blob it belongs to, never the current document.
      const snippet = snippetAtLine(content, root.originalLine);
      if (snippet) snippets.set(root.id, snippet);
    }),
  );

  return snippets;
}

/**
 * The whole read path, and what the collaboration routes call: list → thread → capture →
 * re-anchor → project (R-6.1 … R-6.9).
 *
 * `documentText` is the current text of the document under review, and `documentPath`
 * names it. When a path is given, threads on *other* files are projected without it:
 * searching one file's text for another file's snippet could produce an exact unique
 * match and anchor a comment into a document it was never about. Those threads keep
 * their captured snippet and stay in the document-level list, which is where a comment
 * about another file belongs anyway.
 *
 * `resolutions` is optional and stays optional. Absent, every record reports
 * `isResolved: undefined` — "the resolution read did not run", which is a third answer
 * and must not collapse into `false` (R-4.12 / R-5.15).
 */
export async function loadReviewThreadRecords(
  adapter: GitHubAdapter,
  repo: RepoRef,
  pullNumber: number,
  documentText: string,
  options: { documentPath?: string; resolutions?: readonly ThreadResolution[] } = {},
): Promise<ReviewThreadRecord[]> {
  // One accumulated list, then group — a root and its reply can straddle a page (R-5.17).
  const threads = groupIntoThreads(await adapter.listReviewComments(repo, pullNumber));
  const snippets = await captureOutdatedSnippets(adapter, repo, threads);

  const byRoot = new Map<number, ThreadResolution>();
  for (const r of options.resolutions ?? []) byRoot.set(r.rootCommentId, r);

  return threads.map((thread) => {
    const snippet = snippets.get(thread.root.id);
    const resolution = byRoot.get(thread.root.id);
    const opts = {
      ...(snippet ? { snippet } : {}),
      ...(resolution ? { resolution } : {}),
    };
    const inThisDocument =
      options.documentPath === undefined || options.documentPath === thread.root.path;
    return inThisDocument
      ? projectReviewThreadInDocument(thread, documentText, opts)
      : projectReviewThread(thread, opts);
  });
}
