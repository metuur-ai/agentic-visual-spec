/**
 * review-comments.test.ts — R-12.4, R-12.10, R-12.11.
 *
 * The fixtures are not hand-written. They are the verbatim responses GitHub returned
 * for `metuur-ai/visual-spec-collaboration-test#9`, a Pull Request built to produce
 * exactly the states this module has to survive: a thread anchored inside the diff, a
 * file-level thread created after a `422` on an out-of-diff line, a reply, a reply to
 * a reply, and then an edit that outdated everything line-anchored.
 *
 * That matters because every hard case here is a GitHub behaviour we do not control.
 * A hand-authored fixture would encode what we believe GitHub does; these encode what
 * it did.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ReviewComment,
  SNIPPET_MAX,
  groupIntoThreads,
  headingAbove,
  isThreadOutdated,
  projectReviewThread,
  projectReviewThreadInDocument,
  reanchorBySnippet,
  snippetAtLine,
  reviewCommentIdFor,
  reviewRecordIdFor,
  targetForThread,
  toReviewComment,
} from './review-comments';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const recorded = (): ReviewComment[] =>
  (fixture('review-comments-list.json') as Record<string, unknown>[]).map(toReviewComment);

/** Minimal comment for the shape-driven cases the recording does not contain. */
const comment = (over: Partial<ReviewComment> & { id: number }): ReviewComment => ({
  inReplyToId: null,
  path: 'doc.md',
  line: 10,
  startLine: null,
  originalLine: 10,
  side: 'RIGHT',
  subjectType: 'line',
  commitId: 'aaa',
  originalCommitId: 'aaa',
  diffHunk: '',
  body: 'body',
  user: 'someone',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  htmlUrl: 'https://example.test/c',
  ...over,
});

describe('toReviewComment', () => {
  it('maps the recorded payload without inventing a position', () => {
    const all = recorded();
    expect(all).toHaveLength(4);

    const outdated = all.find((c) => c.line === null && c.inReplyToId === null);
    expect(outdated).toBeDefined();
    // The whole point: the line is gone and only the original survives.
    expect(outdated?.originalLine).toBe(23);
    // And its commit is frozen at the one it was written against — an outdated
    // comment stops tracking head entirely, so `commitId` is no more current than
    // `originalLine` is. Neither may be read as "where this is now".
    expect(outdated?.commitId).toBe(outdated?.originalCommitId);
  });

  it('shows a file-level comment still tracking head after the same edit', () => {
    const fileLevel = recorded().find((c) => c.subjectType === 'file');
    expect(fileLevel).toBeDefined();
    // Recorded from the same PR, after the commit that outdated every line thread:
    // this one advanced its commitId past the commit it was created on, which is
    // what "not outdated" looks like on the wire (R-6.12).
    expect(fileLevel?.commitId).not.toBe(fileLevel?.originalCommitId);
    expect(fileLevel?.line).not.toBeNull();
  });

  it('carries subject_type, so a file-level thread is distinguishable', () => {
    expect(recorded().filter((c) => c.subjectType === 'file')).toHaveLength(1);
  });

  it('reports no resolution — REST does not carry it (R-5.12)', () => {
    const raw = fixture('review-comments-list.json') as Record<string, unknown>[];
    for (const c of raw) {
      expect(Object.keys(c).some((k) => /resolv/i.test(k))).toBe(false);
    }
  });
});

describe('groupIntoThreads', () => {
  it('reconstructs the recorded conversation as two threads', () => {
    const threads = groupIntoThreads(recorded());
    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.replies.length).sort()).toEqual([0, 2]);
  });

  it('attaches a reply-to-a-reply to the root, because GitHub flattens', () => {
    const threads = groupIntoThreads(recorded());
    const withReplies = threads.find((t) => t.replies.length > 0);
    // Both replies name the root; neither names the other.
    for (const r of withReplies?.replies ?? []) {
      expect(r.inReplyToId).toBe(withReplies?.root.id);
    }
  });

  it('groups over the whole list, not per page (R-5.17)', () => {
    const root = comment({ id: 1, createdAt: '2026-01-01T00:00:00Z' });
    const reply = comment({ id: 2, inReplyToId: 1, createdAt: '2026-01-02T00:00:00Z' });

    // Page-at-a-time would make the reply an orphan thread of its own.
    expect(groupIntoThreads([root])).toHaveLength(1);
    expect(groupIntoThreads([reply])).toHaveLength(1);
    // Accumulated, it is one thread with one reply.
    const together = groupIntoThreads([root, reply]);
    expect(together).toHaveLength(1);
    expect(together[0]?.replies.map((r) => r.id)).toEqual([2]);
  });

  it('promotes a reply whose root was deleted rather than dropping it (R-5.18)', () => {
    const orphanA = comment({ id: 5, inReplyToId: 99, createdAt: '2026-01-01T00:00:00Z' });
    const orphanB = comment({ id: 6, inReplyToId: 99, createdAt: '2026-01-02T00:00:00Z' });
    const threads = groupIntoThreads([orphanB, orphanA]);
    // One thread, not two: siblings of one deleted root stay together.
    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.id).toBe(5); // earliest becomes the root
    expect(threads[0]?.replies.map((r) => r.id)).toEqual([6]);
  });

  it('orders replies by creation regardless of input order', () => {
    const root = comment({ id: 1 });
    const late = comment({ id: 2, inReplyToId: 1, createdAt: '2026-03-01T00:00:00Z' });
    const early = comment({ id: 3, inReplyToId: 1, createdAt: '2026-02-01T00:00:00Z' });
    const [thread] = groupIntoThreads([root, late, early]);
    expect(thread?.replies.map((r) => r.id)).toEqual([3, 2]);
  });
});

describe('isThreadOutdated', () => {
  it('is true for a line thread that lost its line', () => {
    const threads = groupIntoThreads(recorded());
    const lineThread = threads.find((t) => t.root.subjectType === 'line');
    expect(isThreadOutdated(lineThread!)).toBe(true);
  });

  it('is false for a file-level thread — it never had a line to lose (R-6.12)', () => {
    const threads = groupIntoThreads(recorded());
    const fileThread = threads.find((t) => t.root.subjectType === 'file');
    expect(fileThread).toBeDefined();
    expect(isThreadOutdated(fileThread!)).toBe(false);
  });
});

describe('targetForThread', () => {
  it('produces a range for an anchored thread', () => {
    const [thread] = groupIntoThreads([comment({ id: 1, line: 42, startLine: 40 })]);
    expect(targetForThread(thread!)).toEqual({ path: 'doc.md', kind: 'range', startLine: 40, endLine: 42 });
  });

  it('omits endLine for a single-line anchor', () => {
    const [thread] = groupIntoThreads([comment({ id: 1, line: 42 })]);
    expect(targetForThread(thread!)).toEqual({ path: 'doc.md', kind: 'range', startLine: 42 });
  });

  it('never uses original_line as a current position (R-6.5)', () => {
    const [thread] = groupIntoThreads([comment({ id: 1, line: null, originalLine: 23 })]);
    const target = targetForThread(thread!);
    expect(target.kind).toBe('file');
    expect(target.startLine).toBeUndefined();
    expect(JSON.stringify(target)).not.toContain('23');
  });

  it('carries the captured snippet on an outdated target', () => {
    const [thread] = groupIntoThreads([comment({ id: 1, line: null })]);
    expect(targetForThread(thread!, 'texto original').snippet).toBe('texto original');
  });
});

describe('projectReviewThread', () => {
  it('projects the recorded thread into a CommentRecord shape', () => {
    const threads = groupIntoThreads(recorded());
    const lineThread = threads.find((t) => t.root.subjectType === 'line')!;
    const record = projectReviewThread(lineThread);

    expect(record.id).toBe(reviewRecordIdFor(lineThread.root.id));
    expect(reviewCommentIdFor(record.id)).toBe(lineThread.root.id);
    expect(record.comment).toBe(lineThread.root.body);
    expect(record.github.reviewCommentId).toBe(lineThread.root.id);
    expect(record.github.isOutdated).toBe(true);
    expect(record.replies).toHaveLength(2);
  });

  it('reports status open regardless of GitHub state (R-5.21)', () => {
    const [thread] = groupIntoThreads([comment({ id: 1 })]);
    const resolved = projectReviewThread(thread!, {
      resolution: { rootCommentId: 1, isResolved: true, isOutdated: false },
    });
    // `applied` means the local apply agent acted. Resolution must not leak into it.
    expect(resolved.status).toBe('open');
    expect(resolved.github.isResolved).toBe(true);
  });

  it('leaves isResolved undefined when resolution was not read (R-4.12 / R-5.15)', () => {
    const [thread] = groupIntoThreads([comment({ id: 1 })]);
    const record = projectReviewThread(thread!);
    // Absent must not collapse to false — "could not tell" is a third answer.
    expect('isResolved' in record.github).toBe(false);
    expect(record.github.isResolved).toBeUndefined();
  });

  it('does not project a reply as an independent record (R-5.20)', () => {
    const records = groupIntoThreads(recorded()).map((t) => projectReviewThread(t));
    expect(records).toHaveLength(2);
    const replyIds = records.flatMap((r) => r.replies.map((x) => x.id));
    expect(replyIds).toHaveLength(2);
    // No reply may also appear as a record of its own.
    for (const id of replyIds) {
      expect(records.some((r) => r.github.reviewCommentId === id)).toBe(false);
    }
  });
});

describe('reanchorBySnippet', () => {
  const doc = ['# Title', '', 'Un párrafo único.', '', 'Repetido.', '', 'Repetido.', ''].join('\n');

  it('anchors on an exact unique match (R-6.3)', () => {
    expect(reanchorBySnippet(doc, 'Un párrafo único.')).toBe(3);
  });

  it('refuses an ambiguous match rather than picking one (R-6.4 / R-6.8)', () => {
    expect(reanchorBySnippet(doc, 'Repetido.')).toBeNull();
  });

  it('returns null when the text is gone', () => {
    expect(reanchorBySnippet(doc, 'Ya no existe.')).toBeNull();
  });

  it('ignores surrounding whitespace but not content', () => {
    expect(reanchorBySnippet(doc, '  Un párrafo único.  ')).toBe(3);
    expect(reanchorBySnippet(doc, 'Un párrafo unico.')).toBeNull();
  });

  it('returns null for an empty snippet instead of matching a blank line', () => {
    expect(reanchorBySnippet(doc, '   ')).toBeNull();
  });

  it('matches a line longer than the snippet budget against its clamped capture', () => {
    const long = `${'a'.repeat(200)} cola`;
    // Captured text is clamped, so the comparison must clamp the line too or a long
    // paragraph could never re-anchor to itself.
    expect(reanchorBySnippet(`# T\n\n${long}\n`, snippetAtLine(long, 1))).toBe(3);
  });

  it('stays ambiguous when two long lines share their clamped prefix', () => {
    const a = `${'a'.repeat(200)} uno`;
    const b = `${'a'.repeat(200)} dos`;
    // Truncation can only ever create ambiguity, and ambiguity means no anchor.
    expect(reanchorBySnippet(`${a}\n${b}\n`, snippetAtLine(a, 1))).toBeNull();
  });
});

describe('snippetAtLine', () => {
  const file = ['# Titulo', '', 'Texto   con   espacios', ''].join('\n');

  it('reads the 1-indexed line and flattens its whitespace', () => {
    expect(snippetAtLine(file, 3)).toBe('Texto con espacios');
  });

  it('clamps to SNIPPET_MAX, the same budget local mode gives a snippet', () => {
    expect(SNIPPET_MAX).toBe(160);
    expect(snippetAtLine('x'.repeat(500), 1)).toHaveLength(SNIPPET_MAX);
  });

  it('returns empty for a line past the end, or a nonsense line number', () => {
    // An old blob is not guaranteed to still be as long as original_line.
    expect(snippetAtLine(file, 99)).toBe('');
    expect(snippetAtLine(file, 0)).toBe('');
    expect(snippetAtLine(file, -1)).toBe('');
  });
});

describe('headingAbove', () => {
  const doc = [
    '# Uno', // 1
    '', // 2
    'cuerpo', // 3
    '', // 4
    '## Dos ##', // 5
    '', // 6
    '```sh', // 7
    '# no es un titulo', // 8
    '```', // 9
    'final', // 10
  ].join('\n');

  it('finds the nearest heading at or above the line, without its hashes', () => {
    expect(headingAbove(doc, 3)).toBe('Uno');
    expect(headingAbove(doc, 6)).toBe('Dos');
    expect(headingAbove(doc, 1)).toBe('Uno');
  });

  it('ignores a hash inside a fenced code block', () => {
    expect(headingAbove(doc, 10)).toBe('Dos');
  });

  it('returns null when nothing above the line is a heading', () => {
    expect(headingAbove('solo texto\notra linea', 2)).toBeNull();
  });
});

describe('projectReviewThreadInDocument', () => {
  it('anchors a current line and captures its heading (R-6.2)', () => {
    const doc = ['# Intro', '', 'uno', 'dos', 'tres'].join('\n');
    const [thread] = groupIntoThreads([comment({ id: 1, line: 4, startLine: 3 })]);
    const record = projectReviewThreadInDocument(thread!, doc);
    expect(record.target).toEqual({ path: 'doc.md', kind: 'range', startLine: 3, endLine: 4, heading: 'Intro' });
    expect(record.github.isOutdated).toBe(false);
  });

  it('re-anchors an outdated thread on a unique match and keeps the flag (R-6.3)', () => {
    const doc = ['# Seccion', '', 'texto original', ''].join('\n');
    const [thread] = groupIntoThreads([comment({ id: 1, line: null })]);
    const record = projectReviewThreadInDocument(thread!, doc, { snippet: 'texto original' });
    expect(record.target).toEqual({
      path: 'doc.md',
      kind: 'range',
      startLine: 3,
      snippet: 'texto original',
      heading: 'Seccion',
    });
    expect(record.github.isOutdated).toBe(true);
  });

  it('stays file-level with its snippet when the match is ambiguous or absent (R-6.4)', () => {
    const [thread] = groupIntoThreads([comment({ id: 1, line: null })]);
    for (const doc of ['dos veces\notra\ndos veces', 'nada parecido']) {
      const record = projectReviewThreadInDocument(thread!, doc, { snippet: 'dos veces' });
      expect(record.target).toEqual({ path: 'doc.md', kind: 'file', snippet: 'dos veces' });
      expect(record.github.isOutdated).toBe(true);
    }
  });

  it('stays file-level when no snippet was captured at all', () => {
    const [thread] = groupIntoThreads([comment({ id: 1, line: null })]);
    const record = projectReviewThreadInDocument(thread!, 'cualquier cosa');
    expect(record.target).toEqual({ path: 'doc.md', kind: 'file' });
  });

  it('never re-anchors by heading proximity (R-6.8)', () => {
    // Same heading, snippet nowhere: a heading match must not become a position.
    const doc = ['# Seccion', '', 'otro texto'].join('\n');
    const [thread] = groupIntoThreads([comment({ id: 1, line: null })]);
    const record = projectReviewThreadInDocument(thread!, doc, { snippet: 'texto original' });
    expect(record.target.kind).toBe('file');
    expect(record.target.heading).toBeUndefined();
  });
});
