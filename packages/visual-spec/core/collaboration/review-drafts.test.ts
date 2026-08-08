/**
 * review-drafts.test.ts — the store runs against a real temp directory rather than a
 * mocked `node:fs`. The behaviours that matter here are all filesystem behaviours:
 * "no file yet" must be a normal read, the JSON must survive a round trip through disk,
 * and `.gitignore` must exist before the first draft does. A mocked fs would assert the
 * calls this module makes, which is the one thing already visible in the source.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addReviewDraft,
  deleteReviewDraft,
  isStale,
  markDraftPublished,
  readReviewDrafts,
  reviewDraftsRelPath,
} from './review-drafts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

describe('review-drafts', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-drafts-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('readReviewDrafts', () => {
    it('answers an empty list for a PR nobody has commented on, rather than throwing', async () => {
      await expect(readReviewDrafts(base, 7)).resolves.toEqual([]);
    });
  });

  describe('addReviewDraft', () => {
    it('round-trips a range draft through disk at .visual-spec/reviews/pr-<n>.json', async () => {
      const created = await addReviewDraft(base, 42, {
        path: 'src/app.ts',
        startLine: 10,
        endLine: 12,
        snippet: 'const x = 1;',
        heading: null,
        comment: 'this leaks',
        headSha: HEAD,
      });

      expect(created.id).toMatch(/^d-[0-9a-f]{8}$/);
      expect(created.status).toBe('draft');
      expect(created.target).toEqual({
        path: 'src/app.ts',
        kind: 'range',
        startLine: 10,
        endLine: 12,
        snippet: 'const x = 1;',
        heading: null,
      });

      // Read back through a second call — the assertion is about the bytes on disk,
      // not about the object addReviewDraft happened to return.
      expect(await readReviewDrafts(base, 42)).toEqual([created]);
      const raw = await readFile(join(base, reviewDraftsRelPath(42)), 'utf8');
      expect(JSON.parse(raw)).toMatchObject({ version: 1, pullNumber: 42 });
    });

    it('makes a file-level target when no line is given, and drops a redundant endLine', async () => {
      const fileLevel = await addReviewDraft(base, 42, {
        path: 'README.md',
        comment: 'wrong title',
        headSha: HEAD,
      });
      expect(fileLevel.target).toEqual({ path: 'README.md', kind: 'file' });

      const single = await addReviewDraft(base, 42, {
        path: 'README.md',
        startLine: 3,
        endLine: 3,
        comment: 'typo',
        headSha: HEAD,
      });
      expect(single.target).toEqual({ path: 'README.md', kind: 'range', startLine: 3 });
    });

    it('appends rather than replacing, keeping creation order', async () => {
      const first = await addReviewDraft(base, 42, { path: 'a.ts', comment: 'one', headSha: HEAD });
      const second = await addReviewDraft(base, 42, { path: 'b.ts', comment: 'two', headSha: HEAD });
      expect((await readReviewDrafts(base, 42)).map((d) => d.id)).toEqual([first.id, second.id]);
    });

    it('gitignores .visual-spec/ before the first draft lands', async () => {
      await addReviewDraft(base, 42, { path: 'a.ts', comment: 'one', headSha: HEAD });
      expect(await readFile(join(base, '.gitignore'), 'utf8')).toContain('.visual-spec/');
    });

    it('refuses a target path that escapes the worktree root', async () => {
      await expect(
        addReviewDraft(base, 42, { path: '../../etc/passwd', comment: 'x', headSha: HEAD }),
      ).rejects.toThrow('invalid path');
    });
  });

  describe('markDraftPublished', () => {
    it('keeps the record and stores the id GitHub returned', async () => {
      const draft = await addReviewDraft(base, 42, { path: 'a.ts', startLine: 1, comment: 'x', headSha: HEAD });
      const { draft: published, alreadyPublished } = await markDraftPublished(base, 42, draft.id, {
        reviewCommentId: 99001,
        htmlUrl: 'https://github.com/o/r/pull/42#discussion_r99001',
      });

      expect(alreadyPublished).toBe(false);
      expect(published.status).toBe('published');
      expect(published.published?.reviewCommentId).toBe(99001);

      // Not deleted: the surviving record is what a later publish attempt reads.
      const stored = await readReviewDrafts(base, 42);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe('published');
    });

    it('is idempotent — a second publish writes nothing and reports the first marker', async () => {
      const draft = await addReviewDraft(base, 42, { path: 'a.ts', startLine: 1, comment: 'x', headSha: HEAD });
      const first = await markDraftPublished(base, 42, draft.id, {
        reviewCommentId: 99001,
        htmlUrl: 'https://github.com/o/r/pull/42#discussion_r99001',
      });

      // The retry carries a *different* GitHub id, as a duplicate POST would have. The
      // store must not adopt it: doing so would leave the second comment's link on disk
      // and hide the fact that only the first publish was ever meant to happen.
      const second = await markDraftPublished(base, 42, draft.id, {
        reviewCommentId: 99002,
        htmlUrl: 'https://github.com/o/r/pull/42#discussion_r99002',
      });

      expect(second.alreadyPublished).toBe(true);
      expect(second.draft.published).toEqual(first.draft.published);
      expect((await readReviewDrafts(base, 42))[0]?.published?.reviewCommentId).toBe(99001);
    });

    it('throws for an id that is not in the file', async () => {
      await addReviewDraft(base, 42, { path: 'a.ts', comment: 'x', headSha: HEAD });
      await expect(
        markDraftPublished(base, 42, 'd-deadbeef', { reviewCommentId: 1, htmlUrl: 'u' }),
      ).rejects.toThrow('unknown draft');
    });
  });

  describe('deleteReviewDraft', () => {
    it('removes an unpublished draft and leaves the others', async () => {
      const doomed = await addReviewDraft(base, 42, { path: 'a.ts', comment: 'one', headSha: HEAD });
      const kept = await addReviewDraft(base, 42, { path: 'b.ts', comment: 'two', headSha: HEAD });

      expect(await deleteReviewDraft(base, 42, doomed.id)).toBe(true);
      expect((await readReviewDrafts(base, 42)).map((d) => d.id)).toEqual([kept.id]);
    });

    it('answers false for an id that is already gone', async () => {
      expect(await deleteReviewDraft(base, 42, 'd-deadbeef')).toBe(false);
    });

    it('refuses to delete a published draft — that record is the idempotency guard', async () => {
      const draft = await addReviewDraft(base, 42, { path: 'a.ts', comment: 'x', headSha: HEAD });
      await markDraftPublished(base, 42, draft.id, { reviewCommentId: 1, htmlUrl: 'u' });
      await expect(deleteReviewDraft(base, 42, draft.id)).rejects.toThrow('cannot delete a published draft');
      expect(await readReviewDrafts(base, 42)).toHaveLength(1);
    });
  });

  describe('isStale', () => {
    it('flags a draft written against a head the PR has moved off', async () => {
      const draft = await addReviewDraft(base, 42, { path: 'a.ts', startLine: 4, comment: 'x', headSha: HEAD });
      expect(isStale(draft, HEAD)).toBe(false);
      expect(isStale(draft, OTHER_HEAD)).toBe(true);

      // The head survives the round trip — staleness has to be answerable after a
      // restart, not only for the object the caller just created.
      const stored = (await readReviewDrafts(base, 42))[0];
      expect(stored && isStale(stored, OTHER_HEAD)).toBe(true);
    });
  });

  describe('pullNumber validation', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses pullNumber %s before touching the disk', async (n) => {
      await expect(readReviewDrafts(base, n)).rejects.toThrow('invalid pullNumber');
      await expect(addReviewDraft(base, n, { path: 'a.ts', comment: 'x', headSha: HEAD })).rejects.toThrow(
        'invalid pullNumber',
      );
      await expect(deleteReviewDraft(base, n, 'd-deadbeef')).rejects.toThrow('invalid pullNumber');
      await expect(
        markDraftPublished(base, n, 'd-deadbeef', { reviewCommentId: 1, htmlUrl: 'u' }),
      ).rejects.toThrow('invalid pullNumber');
      await expect(readFile(join(base, '.gitignore'), 'utf8')).rejects.toThrow();
    });
  });
});
