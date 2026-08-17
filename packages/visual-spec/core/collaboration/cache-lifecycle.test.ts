import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommentDoc, CommentRecord } from '../editing/comment-doc';
import { type CommentDocStore, fileCommentStore } from '../vite/routes/comments';
import { assertCacheNeverRead, deleteCommentCache, mergeAndDropCommentCache } from './cache-lifecycle';
import type { MergeResult } from './github-adapter';

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'vs-cache-'));

const rec = (id: string): CommentRecord => ({
  id,
  workflow: 'visual-spec',
  target: { path: 'docs/spec.md', kind: 'file' },
  comment: 'from GitHub',
  status: 'open',
  ts: '',
});

const doc = (...ids: string[]): CommentDoc => ({ version: 1, comments: ids.map(rec) });

const MERGED: MergeResult = { merged: true, sha: 'abc123', message: 'Pull Request successfully merged' };
const REFUSED: MergeResult = { merged: false, sha: '', message: 'Pull Request is not mergeable' };

/** A store standing in for `githubCommentStore` — its `read()` is the API. */
function githubLike(snapshot: CommentDoc): { store: Pick<CommentDocStore, 'read'>; reads: () => number } {
  let reads = 0;
  return {
    store: {
      async read() {
        reads += 1;
        return snapshot;
      },
    },
    reads: () => reads,
  };
}

describe('deleteCommentCache (R-5.8)', () => {
  it('removes the cache file', async () => {
    const path = join(await tmp(), 'visual-spec-comments.json');
    await writeFile(path, '{}', 'utf8');

    await deleteCommentCache(path);

    expect(existsSync(path)).toBe(false);
  });

  it('treats a missing cache as success — a merge must not fail on nothing to delete', async () => {
    await expect(deleteCommentCache(join(await tmp(), 'never-written.json'))).resolves.toBeUndefined();
  });
});

describe('mergeAndDropCommentCache — ordering (R-5.8)', () => {
  it('snapshots the conversation from GitHub BEFORE the merge, then deletes the cache', async () => {
    const path = join(await tmp(), 'visual-spec-comments.json');
    await writeFile(path, '{"version":1,"comments":[]}', 'utf8');
    const order: string[] = [];
    const gh = githubLike(doc('c-1', 'c-2'));

    const result = await mergeAndDropCommentCache({
      store: {
        async read() {
          order.push('read');
          return gh.store.read();
        },
      },
      merge: async () => {
        order.push('merge');
        // The changelog's input must already be in hand at this point.
        expect(existsSync(path)).toBe(true);
        return MERGED;
      },
      cachePath: path,
    });

    expect(order).toEqual(['read', 'merge']);
    expect(result.cacheDeleted).toBe(true);
    expect(existsSync(path)).toBe(false);
    // The conversation the changelog needs survives the deletion as a value.
    expect(result.conversation.comments.map((c) => c.id)).toEqual(['c-1', 'c-2']);
  });

  it('keeps the cache when the merge did NOT merge — the conversation is still live', async () => {
    const path = join(await tmp(), 'visual-spec-comments.json');
    await writeFile(path, '{"version":1,"comments":[]}', 'utf8');

    const result = await mergeAndDropCommentCache({ store: githubLike(doc()).store, merge: async () => REFUSED, cachePath: path });

    expect(result.merge.merged).toBe(false);
    expect(result.cacheDeleted).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('works with no cache configured at all', async () => {
    const result = await mergeAndDropCommentCache({ store: githubLike(doc('c-1')).store, merge: async () => MERGED });

    expect(result.cacheDeleted).toBe(false);
    expect(result.conversation.comments).toHaveLength(1);
  });

  it('takes the snapshot from GitHub, not from the cache file (R-5.9)', async () => {
    const dir = await tmp();
    const path = join(dir, 'visual-spec-comments.json');
    // A stale cache holding a comment GitHub has never heard of.
    await fileCommentStore(path).write(doc('c-stale'));
    const gh = githubLike(doc('c-1'));

    const result = await mergeAndDropCommentCache({ store: gh.store, merge: async () => MERGED, cachePath: path });

    expect(gh.reads()).toBe(1);
    expect(result.conversation.comments.map((c) => c.id)).toEqual(['c-1']);
  });
});

describe('assertCacheNeverRead (R-5.9)', () => {
  it('throws if anything tries to answer a read from the cache', async () => {
    const path = join(await tmp(), 'visual-spec-comments.json');
    const guarded = assertCacheNeverRead(fileCommentStore(path));

    await expect(guarded.read()).rejects.toThrow(/never read/);
  });

  it('lets writes through — mirroring is the cache’s whole job (R-5.3)', async () => {
    const path = join(await tmp(), 'visual-spec-comments.json');
    const guarded = assertCacheNeverRead(fileCommentStore(path));

    await guarded.write(doc('c-1'));

    expect(JSON.parse(await readFile(path, 'utf8')).comments).toHaveLength(1);
  });
});
