/**
 * review-anchoring.test.ts — the outdated path end to end (R-6.3 … R-6.9).
 *
 * The comment list is the verbatim response GitHub returned for
 * `metuur-ai/visual-spec-collaboration-test#9` after the commit that outdated every
 * line-anchored thread on `spike-doc.md`. So the shape under test — `line: null`,
 * `original_line: 23`, and a `commit_id` frozen at `original_commit_id` — is recorded,
 * not assumed.
 *
 * The blob is stubbed rather than recorded because the adapter is stubbed: what matters
 * is that the fetch asks for `original_commit_id` and reads `original_line` out of *that*
 * commit, which the argument assertions below pin down.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubAdapter } from './github-adapter';
import { captureOutdatedSnippets, loadReviewThreadRecords } from './review-anchoring';
import { type ReviewComment, groupIntoThreads, toReviewComment } from './review-comments';

const REPO = { owner: 'metuur-ai', repo: 'visual-spec-collaboration-test' };

const recorded = (): ReviewComment[] =>
  (
    JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'review-comments-list.json'), 'utf8'),
    ) as Record<string, unknown>[]
  ).map(toReviewComment);

/**
 * The outdated root's original line is 23, so the blob has to be at least that long.
 * Line 23 is the text the reviewer commented on; line 8 repeats it, which is how the
 * ambiguity case is provoked without hand-editing a second fixture.
 */
const blobLines = (line23: string, extra: Record<number, string> = {}): string => {
  const lines = Array.from({ length: 24 }, (_, i) => `linea ${i + 1}`);
  lines[22] = line23;
  for (const [n, text] of Object.entries(extra)) lines[Number(n) - 1] = text;
  return lines.join('\n');
};

const ORIGINAL_TEXT = 'Parrafo modificado de la seccion 2.';

/** An adapter stub with only the two methods this module touches. */
function stubAdapter(over: Partial<GitHubAdapter> = {}): GitHubAdapter {
  return {
    listReviewComments: vi.fn(async () => recorded()),
    getFile: vi.fn(async (_repo, path, _ref) => ({
      path,
      sha: 'blobsha',
      content: blobLines(ORIGINAL_TEXT),
    })),
    ...over,
  } as unknown as GitHubAdapter;
}

describe('captureOutdatedSnippets', () => {
  it('reads original_line from the blob at original_commit_id (R-6.7)', async () => {
    const adapter = stubAdapter();
    const threads = groupIntoThreads(recorded());
    const snippets = await captureOutdatedSnippets(adapter, REPO, threads);

    const outdated = threads.find((t) => t.root.line === null)!;
    expect(snippets.get(outdated.root.id)).toBe(ORIGINAL_TEXT);
    expect(adapter.getFile).toHaveBeenCalledWith(REPO, 'spike-doc.md', outdated.root.originalCommitId);
  });

  it('captures nothing for a file-level thread — it is not outdated (R-6.12)', async () => {
    const threads = groupIntoThreads(recorded());
    const snippets = await captureOutdatedSnippets(stubAdapter(), REPO, threads);
    const fileThread = threads.find((t) => t.root.subjectType === 'file')!;
    expect(snippets.has(fileThread.root.id)).toBe(false);
    // Only the outdated line thread was captured.
    expect(snippets.size).toBe(1);
  });

  it('fetches each path@commit once even across several outdated threads', async () => {
    const adapter = stubAdapter();
    const many = groupIntoThreads(
      recorded().map((c) => ({ ...c, inReplyToId: null })), // every comment its own thread
    );
    await captureOutdatedSnippets(adapter, REPO, many);
    expect(many.filter((t) => t.root.line === null)).toHaveLength(3);
    expect(adapter.getFile).toHaveBeenCalledTimes(1);
  });

  it('clamps a long line to the snippet budget', async () => {
    const long = 'x'.repeat(400);
    const adapter = stubAdapter({ getFile: vi.fn(async () => ({ path: 'p', sha: 's', content: blobLines(long) })) });
    const snippets = await captureOutdatedSnippets(adapter, REPO, groupIntoThreads(recorded()));
    expect([...snippets.values()][0]).toHaveLength(160);
  });

  it('degrades when the blob read throws instead of losing the thread (R-6.9)', async () => {
    const adapter = stubAdapter({
      getFile: vi.fn(async () => {
        throw new Error('404 Not Found');
      }),
    });
    await expect(captureOutdatedSnippets(adapter, REPO, groupIntoThreads(recorded()))).resolves.toEqual(new Map());
  });

  it('degrades when the blob is gone (adapter resolves null)', async () => {
    const adapter = stubAdapter({ getFile: vi.fn(async () => null) });
    expect((await captureOutdatedSnippets(adapter, REPO, groupIntoThreads(recorded()))).size).toBe(0);
  });

  it('degrades when the old blob is shorter than original_line', async () => {
    const adapter = stubAdapter({ getFile: vi.fn(async () => ({ path: 'p', sha: 's', content: 'una sola linea' })) });
    expect((await captureOutdatedSnippets(adapter, REPO, groupIntoThreads(recorded()))).size).toBe(0);
  });
});

describe('loadReviewThreadRecords', () => {
  const outdatedRootId = 3740897151;

  it('re-anchors an outdated thread on a unique match and keeps it flagged (R-6.3)', async () => {
    const doc = ['# Seccion 2', '', ORIGINAL_TEXT, ''].join('\n');
    const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, doc);

    const record = records.find((r) => r.github.reviewCommentId === outdatedRootId)!;
    expect(record.target.kind).toBe('range');
    expect(record.target.startLine).toBe(3);
    expect(record.target.snippet).toBe(ORIGINAL_TEXT);
    // Re-anchored is not "current": the reviewer wrote it against another commit.
    expect(record.github.isOutdated).toBe(true);
    expect(record.target.heading).toBe('Seccion 2');
  });

  it('falls back to file-level with the snippet when the match is ambiguous (R-6.4 / R-6.8)', async () => {
    const doc = [ORIGINAL_TEXT, '', 'otra cosa', '', ORIGINAL_TEXT].join('\n');
    const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, doc);

    const record = records.find((r) => r.github.reviewCommentId === outdatedRootId)!;
    expect(record.target.kind).toBe('file');
    expect(record.target.startLine).toBeUndefined();
    // The comment is not hidden and still says what it was about (R-6.9).
    expect(record.target.snippet).toBe(ORIGINAL_TEXT);
  });

  it('falls back to file-level when the text is gone entirely', async () => {
    const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, '# Otro documento\n\nNada que ver.\n');
    const record = records.find((r) => r.github.reviewCommentId === outdatedRootId)!;
    expect(record.target).toEqual({ path: 'spike-doc.md', kind: 'file', snippet: ORIGINAL_TEXT });
  });

  it('never uses original_line as a position, however the match goes (R-6.5)', async () => {
    for (const doc of ['nada', ORIGINAL_TEXT, [ORIGINAL_TEXT, ORIGINAL_TEXT].join('\n')]) {
      const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, doc);
      const record = records.find((r) => r.github.reviewCommentId === outdatedRootId)!;
      expect(record.target.startLine === 23).toBe(false);
      expect(record.target.endLine).toBeUndefined();
    }
  });

  it('projects every thread even when nothing anchors (R-6.9)', async () => {
    const adapter = stubAdapter({
      getFile: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    const records = await loadReviewThreadRecords(adapter, REPO, 9, 'documento sin relacion');
    // Two threads recorded, two threads projected — a failed capture costs a snippet.
    expect(records).toHaveLength(2);
    const record = records.find((r) => r.github.reviewCommentId === outdatedRootId)!;
    expect(record.target.kind).toBe('file');
    expect(record.target.snippet).toBeUndefined();
    expect(record.replies).toHaveLength(2);
  });

  it('leaves a file-level thread anchored to the document, not to a line (R-6.12)', async () => {
    const doc = ['# Titulo', '', 'cuerpo'].join('\n');
    const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, doc);
    const fileRecord = records.find((r) => r.github.reviewCommentId === 3740897575)!;
    // GitHub reports `line: 1` for it, but a file thread is about the document; it is
    // not outdated and it does not get promoted to a line anchor or a heading hint.
    expect(fileRecord.github.isOutdated).toBe(false);
    expect(fileRecord.target).toEqual({ path: 'spike-doc.md', kind: 'file' });
  });

  it('does not re-anchor a thread whose path is not the open document', async () => {
    const doc = ORIGINAL_TEXT;
    const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, doc, { documentPath: 'otro.md' });
    const record = records.find((r) => r.github.reviewCommentId === outdatedRootId)!;
    // The snippet would have matched uniquely — in the wrong file.
    expect(record.target.kind).toBe('file');
    expect(record.target.snippet).toBe(ORIGINAL_TEXT);
  });

  it('joins resolution by root id and leaves it undefined when not read (R-4.12)', async () => {
    const without = await loadReviewThreadRecords(stubAdapter(), REPO, 9, 'doc');
    expect('isResolved' in without[0]!.github).toBe(false);

    const with_ = await loadReviewThreadRecords(stubAdapter(), REPO, 9, 'doc', {
      resolutions: [{ rootCommentId: outdatedRootId, isResolved: true, isOutdated: true }],
    });
    expect(with_.find((r) => r.github.reviewCommentId === outdatedRootId)?.github.isResolved).toBe(true);
    expect(with_.find((r) => r.github.reviewCommentId === 3740897575)?.github.isResolved).toBeUndefined();
  });

  it('groups over the accumulated list the adapter returns (R-5.17)', async () => {
    const records = await loadReviewThreadRecords(stubAdapter(), REPO, 9, 'doc');
    expect(records).toHaveLength(2);
    expect(records.flatMap((r) => r.replies)).toHaveLength(2);
  });
});
