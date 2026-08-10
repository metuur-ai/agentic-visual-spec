/**
 * review-drafts.test.ts — the store runs against a real temp directory rather than a
 * mocked `node:fs`. The behaviours that matter here are all filesystem behaviours:
 * "no file yet" must be a normal read, the JSON must survive a round trip through disk,
 * and `.gitignore` must exist before the first draft does. A mocked fs would assert the
 * calls this module makes, which is the one thing already visible in the source.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  type ReviewDraftScope,
} from './review-drafts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

/** The repository every call in this file is about, unless it is about two of them. */
const REPO = { owner: 'acme', repo: 'specs' } as const;

describe('review-drafts', () => {
  let base: string;
  /** The served directory and the repository, which together address a drafts file. */
  let at: ReviewDraftScope;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-drafts-'));
    at = { baseDir: base, repo: REPO };
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('readReviewDrafts', () => {
    it('answers an empty list for a PR nobody has commented on, rather than throwing', async () => {
      await expect(readReviewDrafts(at, 7)).resolves.toEqual([]);
    });
  });

  describe('addReviewDraft', () => {
    it('round-trips a range draft through disk at .visual-spec/reviews/pr-<n>.json', async () => {
      const created = await addReviewDraft(at, 42, {
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
      expect(await readReviewDrafts(at, 42)).toEqual([created]);
      const raw = await readFile(join(base, reviewDraftsRelPath(REPO, 42)), 'utf8');
      expect(JSON.parse(raw)).toMatchObject({ version: 1, pullNumber: 42 });
    });

    it('makes a file-level target when no line is given, and drops a redundant endLine', async () => {
      const fileLevel = await addReviewDraft(at, 42, {
        path: 'README.md',
        comment: 'wrong title',
        headSha: HEAD,
      });
      expect(fileLevel.target).toEqual({ path: 'README.md', kind: 'file' });

      const single = await addReviewDraft(at, 42, {
        path: 'README.md',
        startLine: 3,
        endLine: 3,
        comment: 'typo',
        headSha: HEAD,
      });
      expect(single.target).toEqual({ path: 'README.md', kind: 'range', startLine: 3 });
    });

    it('appends rather than replacing, keeping creation order', async () => {
      const first = await addReviewDraft(at, 42, { path: 'a.ts', comment: 'one', headSha: HEAD });
      const second = await addReviewDraft(at, 42, { path: 'b.ts', comment: 'two', headSha: HEAD });
      expect((await readReviewDrafts(at, 42)).map((d) => d.id)).toEqual([first.id, second.id]);
    });

    it('gitignores .visual-spec/ before the first draft lands', async () => {
      await addReviewDraft(at, 42, { path: 'a.ts', comment: 'one', headSha: HEAD });
      expect(await readFile(join(base, '.gitignore'), 'utf8')).toContain('.visual-spec/');
    });

    it('refuses a target path that escapes the worktree root', async () => {
      await expect(
        addReviewDraft(at, 42, { path: '../../etc/passwd', comment: 'x', headSha: HEAD }),
      ).rejects.toThrow('invalid path');
    });
  });

  describe('markDraftPublished', () => {
    it('keeps the record and stores the id GitHub returned', async () => {
      const draft = await addReviewDraft(at, 42, { path: 'a.ts', startLine: 1, comment: 'x', headSha: HEAD });
      const { draft: published, alreadyPublished } = await markDraftPublished(at, 42, draft.id, {
        reviewCommentId: 99001,
        htmlUrl: 'https://github.com/o/r/pull/42#discussion_r99001',
      });

      expect(alreadyPublished).toBe(false);
      expect(published.status).toBe('published');
      expect(published.published?.reviewCommentId).toBe(99001);

      // Not deleted: the surviving record is what a later publish attempt reads.
      const stored = await readReviewDrafts(at, 42);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe('published');
    });

    it('is idempotent — a second publish writes nothing and reports the first marker', async () => {
      const draft = await addReviewDraft(at, 42, { path: 'a.ts', startLine: 1, comment: 'x', headSha: HEAD });
      const first = await markDraftPublished(at, 42, draft.id, {
        reviewCommentId: 99001,
        htmlUrl: 'https://github.com/o/r/pull/42#discussion_r99001',
      });

      // The retry carries a *different* GitHub id, as a duplicate POST would have. The
      // store must not adopt it: doing so would leave the second comment's link on disk
      // and hide the fact that only the first publish was ever meant to happen.
      const second = await markDraftPublished(at, 42, draft.id, {
        reviewCommentId: 99002,
        htmlUrl: 'https://github.com/o/r/pull/42#discussion_r99002',
      });

      expect(second.alreadyPublished).toBe(true);
      expect(second.draft.published).toEqual(first.draft.published);
      expect((await readReviewDrafts(at, 42))[0]?.published?.reviewCommentId).toBe(99001);
    });

    it('throws for an id that is not in the file', async () => {
      await addReviewDraft(at, 42, { path: 'a.ts', comment: 'x', headSha: HEAD });
      await expect(
        markDraftPublished(at, 42, 'd-deadbeef', { reviewCommentId: 1, htmlUrl: 'u' }),
      ).rejects.toThrow('unknown draft');
    });
  });

  describe('deleteReviewDraft', () => {
    it('removes an unpublished draft and leaves the others', async () => {
      const doomed = await addReviewDraft(at, 42, { path: 'a.ts', comment: 'one', headSha: HEAD });
      const kept = await addReviewDraft(at, 42, { path: 'b.ts', comment: 'two', headSha: HEAD });

      expect(await deleteReviewDraft(at, 42, doomed.id)).toBe(true);
      expect((await readReviewDrafts(at, 42)).map((d) => d.id)).toEqual([kept.id]);
    });

    it('answers false for an id that is already gone', async () => {
      expect(await deleteReviewDraft(at, 42, 'd-deadbeef')).toBe(false);
    });

    it('refuses to delete a published draft — that record is the idempotency guard', async () => {
      const draft = await addReviewDraft(at, 42, { path: 'a.ts', comment: 'x', headSha: HEAD });
      await markDraftPublished(at, 42, draft.id, { reviewCommentId: 1, htmlUrl: 'u' });
      await expect(deleteReviewDraft(at, 42, draft.id)).rejects.toThrow('cannot delete a published draft');
      expect(await readReviewDrafts(at, 42)).toHaveLength(1);
    });
  });

  describe('isStale', () => {
    it('flags a draft written against a head the PR has moved off', async () => {
      const draft = await addReviewDraft(at, 42, { path: 'a.ts', startLine: 4, comment: 'x', headSha: HEAD });
      expect(isStale(draft, HEAD)).toBe(false);
      expect(isStale(draft, OTHER_HEAD)).toBe(true);

      // The head survives the round trip — staleness has to be answerable after a
      // restart, not only for the object the caller just created.
      const stored = (await readReviewDrafts(at, 42))[0];
      expect(stored && isStale(stored, OTHER_HEAD)).toBe(true);
    });
  });

  /* ================================================================== *
   * R-W3.6 — a held comment is addressed by repository AND number
   * ================================================================== */
  /** A repository this server was not started against — the case Unit 3 exists for. */
  const other: ReviewDraftScope = { baseDir: '', repo: { owner: 'other', repo: 'tools' } };

  describe('R-W3.6 — two repositories’ #42 are two sets of held comments', () => {
    it('keeps each repository’s drafts in its own file, neither overwriting the other', async () => {
      const mine = await addReviewDraft(at, 42, { path: 'a.ts', comment: 'on specs', headSha: HEAD });
      const theirs = await addReviewDraft({ ...other, baseDir: base }, 42, {
        path: 'a.ts',
        comment: 'on tools',
        headSha: HEAD,
      });

      // The failure this guards is not an exception — it is one file, written twice, with
      // the second write silently carrying the first repository's comments away.
      expect((await readReviewDrafts(at, 42)).map((d) => d.comment)).toEqual(['on specs']);
      expect((await readReviewDrafts({ ...other, baseDir: base }, 42)).map((d) => d.comment)).toEqual(['on tools']);
      expect(mine.id).not.toBe(theirs.id);

      expect(reviewDraftsRelPath(REPO, 42)).toBe('.visual-spec/reviews/acme/specs/pr-42.json');
      expect(reviewDraftsRelPath(other.repo, 42)).toBe('.visual-spec/reviews/other/tools/pr-42.json');
    });

    it('refuses an owner or a repository that would not stay inside the reviews directory', () => {
      for (const repo of [
        { owner: '..', repo: 'specs' },
        { owner: 'acme', repo: '..' },
        { owner: 'acme', repo: '.' },
        { owner: 'acme', repo: 'a/b' },
        { owner: 'acme', repo: '' },
      ]) {
        expect(() => reviewDraftsRelPath(repo, 42), `${repo.owner}/${repo.repo}`).toThrow(/invalid (owner|repo)/);
      }
    });
  });

  describe('R-W3.6 — the pre-scoping file is adopted by the configured repository', () => {
    /** Write a drafts file where the store kept them before a review named its repository. */
    async function seedLegacy(pullNumber: number, comment: string): Promise<void> {
      await mkdir(join(base, '.visual-spec/reviews'), { recursive: true });
      await writeFile(
        join(base, `.visual-spec/reviews/pr-${pullNumber}.json`),
        `${JSON.stringify({
          version: 1,
          pullNumber,
          drafts: [
            {
              id: 'd-0000beef',
              pullNumber,
              headSha: HEAD,
              target: { path: 'a.ts', kind: 'file' },
              comment,
              status: 'published',
              ts: '2026-01-01T00:00:00.000Z',
              published: { reviewCommentId: 99001, htmlUrl: 'u', ts: '2026-01-01T00:00:00.000Z' },
            },
          ],
        })}\n`,
        'utf8',
      );
    }

    /*
     * The record being `published` is the point. Abandoning the pre-scoping file loses no
     * bytes — it stays on disk — but it loses the answer to "did this comment already go
     * out?", which is exactly what stops a publish being repeated (R-13.16). An upgrade
     * that dropped it would silently re-arm every duplicate the guard exists to prevent.
     */
    it('adopts it for the repository entitled to it, published records and all', async () => {
      await seedLegacy(42, 'written before repositories were named');
      const adopted = await readReviewDrafts({ ...at, adoptLegacy: true }, 42);
      expect(adopted.map((d) => d.status)).toEqual(['published']);

      // Moved, not copied: a second, diverging copy of the same drafts is the one outcome
      // worse than not migrating at all.
      await expect(readFile(join(base, '.visual-spec/reviews/pr-42.json'), 'utf8')).rejects.toThrow();
      const raw = await readFile(join(base, reviewDraftsRelPath(REPO, 42)), 'utf8');
      expect(JSON.parse(raw)).toMatchObject({ pullNumber: 42 });
    });

    it('never lets a repository that is not entitled to it claim it', async () => {
      await seedLegacy(42, 'belongs to the configured repository');
      // The reviewed repository is not the configured one, so it has no claim: adopting
      // here would put one project's review comments into another project's review, which
      // is the exact failure repository-scoped drafts exist to prevent.
      expect(await readReviewDrafts({ ...other, baseDir: base }, 42)).toEqual([]);
      // And the file is still there for the repository that does have a claim.
      expect((await readReviewDrafts({ ...at, adoptLegacy: true }, 42))).toHaveLength(1);
    });

    it('never overwrites drafts already written under the new name', async () => {
      const written = await addReviewDraft(at, 42, { path: 'b.ts', comment: 'written after', headSha: HEAD });
      await seedLegacy(42, 'written before');
      expect((await readReviewDrafts({ ...at, adoptLegacy: true }, 42)).map((d) => d.id)).toEqual([written.id]);
      // The pre-scoping file is left alone rather than deleted: this store does not throw
      // bytes away to tidy up, and the file is the only copy of whatever is in it.
      await expect(readFile(join(base, '.visual-spec/reviews/pr-42.json'), 'utf8')).resolves.toContain('written before');
    });
  });

  describe('pullNumber validation', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses pullNumber %s before touching the disk', async (n) => {
      await expect(readReviewDrafts(at, n)).rejects.toThrow('invalid pullNumber');
      await expect(addReviewDraft(at, n, { path: 'a.ts', comment: 'x', headSha: HEAD })).rejects.toThrow(
        'invalid pullNumber',
      );
      await expect(deleteReviewDraft(at, n, 'd-deadbeef')).rejects.toThrow('invalid pullNumber');
      await expect(
        markDraftPublished(at, n, 'd-deadbeef', { reviewCommentId: 1, htmlUrl: 'u' }),
      ).rejects.toThrow('invalid pullNumber');
      await expect(readFile(join(base, '.gitignore'), 'utf8')).rejects.toThrow();
    });
  });
});
