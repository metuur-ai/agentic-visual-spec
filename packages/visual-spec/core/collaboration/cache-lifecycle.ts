/**
 * cache-lifecycle.ts — the lifetime of the local comment cache (task 5.3).
 *
 * In collaboration mode `visual-spec-comments.json` is a cache and nothing else
 * (R-5.3, LLD §5 "Sidecar demoted to cache"). Two rules govern it, and they only
 * make sense together:
 *
 *   R-5.9 — GitHub wins. `githubCommentStore.read()` already goes straight to the
 *           API and never consults the cache, so there is no reconciliation step
 *           to write here: disagreement is impossible to observe because the cache
 *           is never an input. `assertCacheNeverRead` below states that as an
 *           executable claim rather than a comment.
 *   R-5.8 — the cache is deleted when the PR merges, so it can never outlive the
 *           conversation and drift into being a competing source of truth.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING PROBLEM
 * ---------------------------------------------------------------------------
 *
 * The cache exists so an agent can read the whole conversation when writing the
 * PR summary and changelog without re-fetching (LLD §5). R-5.8 destroys it at
 * merge — which is exactly the moment that changelog gets written. Taken
 * literally, the rule deletes the input to the step that follows it.
 *
 * The resolution is that the cache holds nothing of its own. It is a mirror of
 * what GitHub returned, so the conversation is always recoverable from the system
 * of record. `mergeAndDropCommentCache` therefore does three things in a fixed
 * order:
 *
 *   1. **Read the conversation from GitHub** — not from the cache, and before the
 *      merge, so the snapshot handed to the changelog is the authoritative one
 *      (R-5.9) rather than whatever the cache last happened to hold.
 *   2. **Merge.**
 *   3. **Delete the cache, and only if the merge actually merged.** A merge that
 *      GitHub refused (conflict, checks, permissions) leaves the PR open and the
 *      cache intact — deleting it there would throw away a warm cache for a
 *      conversation that is still live.
 *
 * The snapshot from step 1 is returned, so the caller writes its changelog from a
 * value it holds rather than from a file that is about to be removed. Nothing is
 * ever read out of the cache, so nothing is lost when it goes.
 *
 * This module is Node-reachable from the CLI: no react, no `@lyfie/luthor`.
 */
import { rm } from 'node:fs/promises';
import type { CommentDoc } from '../editing/comment-doc';
import type { CommentDocStore } from '../vite/routes/comments';
import type { MergeResult } from './github-adapter';

/**
 * R-5.8 — remove the cache file. Missing is success: the cache is disposable by
 * definition, and a merge must not fail because there was nothing to delete.
 */
export async function deleteCommentCache(cachePath: string): Promise<void> {
  await rm(cachePath, { force: true });
}

export type MergeAndDropCacheInput = {
  /** The GitHub-backed store. Read for the pre-merge snapshot — never the cache. */
  store: Pick<CommentDocStore, 'read'>;
  /** Performs the merge. Injected so this module never owns merge policy. */
  merge: () => Promise<MergeResult>;
  /** Absolute path of the cache file. Omit when the session runs without one. */
  cachePath?: string;
};

export type MergeAndDropCacheResult = {
  merge: MergeResult;
  /**
   * The conversation as GitHub had it immediately before the merge — the input the
   * PR summary and changelog need, captured before R-5.8 removes the cache.
   */
  conversation: CommentDoc;
  /** Whether the cache file was actually removed. False when the merge did not merge. */
  cacheDeleted: boolean;
};

/**
 * R-5.8 — merge the PR and drop the local comment cache, in the order the
 * changelog needs (see the header). Returns the pre-merge conversation so the
 * caller never has to reach for the file that just went away.
 */
export async function mergeAndDropCommentCache(input: MergeAndDropCacheInput): Promise<MergeAndDropCacheResult> {
  const { store, merge, cachePath } = input;
  // 1. Snapshot from the system of record, before anything is destroyed (R-5.9).
  const conversation = await store.read();
  // 2. Merge.
  const result = await merge();
  // 3. Only a real merge retires the cache.
  const cacheDeleted = result.merged && cachePath !== undefined;
  if (cacheDeleted) await deleteCommentCache(cachePath as string);
  return { merge: result, conversation, cacheDeleted };
}

/**
 * R-5.9 — a `CommentDocStore` that fails loudly if anything reads it. Wrap the
 * cache in this and hand it to `githubCommentStore({ cache })`: any code path that
 * tried to answer a read from the cache throws instead of silently returning stale
 * state. Writes pass through, because mirroring is the cache's whole job.
 */
export function assertCacheNeverRead(cache: CommentDocStore): CommentDocStore {
  return {
    read() {
      return Promise.reject(new Error('R-5.9: the local comment cache is never read; GitHub is the system of record'));
    },
    write: (doc) => cache.write(doc),
  };
}
