import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CommentRecord, anchorLabelOf, historyFor } from './comment-doc';

const rec = (over: Partial<CommentRecord> = {}): CommentRecord => ({
  id: 'c-11112222',
  workflow: 'visual-spec',
  target: { path: 'tasks/post-it-notes.md', kind: 'range', startLine: 42, snippet: 'The user can pin a note' },
  comment: 'also cover the keyboard shortcut',
  status: 'open',
  ts: '2026-06-20T00:00:00Z',
  ...over,
});

describe('historyFor', () => {
  it('returns only applied comments for the given path (R-3.2)', () => {
    const comments = [
      rec({ id: 'c-1', status: 'applied', ts: '2026-06-21T00:00:00Z' }),
      rec({ id: 'c-2', status: 'open', ts: '2026-06-22T00:00:00Z' }),
      rec({ id: 'c-3', status: 'applied', target: { path: 'other.md', kind: 'file' }, ts: '2026-06-23T00:00:00Z' }),
    ];
    const result = historyFor(comments, 'tasks/post-it-notes.md');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c-1');
  });

  it('excludes open comments (R-3.3)', () => {
    const comments = [
      rec({ id: 'c-open', status: 'open' }),
      rec({ id: 'c-applied', status: 'applied', ts: '2026-06-21T00:00:00Z' }),
    ];
    const result = historyFor(comments, 'tasks/post-it-notes.md');
    expect(result.map((c) => c.id)).not.toContain('c-open');
    expect(result.map((c) => c.id)).toContain('c-applied');
  });

  it('sorts by ts descending — most recent first (R-3.4)', () => {
    const comments = [
      rec({ id: 'c-old', status: 'applied', ts: '2026-06-10T00:00:00Z' }),
      rec({ id: 'c-new', status: 'applied', ts: '2026-06-20T00:00:00Z' }),
      rec({ id: 'c-mid', status: 'applied', ts: '2026-06-15T00:00:00Z' }),
    ];
    const result = historyFor(comments, 'tasks/post-it-notes.md');
    expect(result.map((c) => c.id)).toEqual(['c-new', 'c-mid', 'c-old']);
  });

  it('does not mutate the input array', () => {
    const comments = [
      rec({ id: 'c-old', status: 'applied', ts: '2026-06-10T00:00:00Z' }),
      rec({ id: 'c-new', status: 'applied', ts: '2026-06-20T00:00:00Z' }),
    ];
    const originalOrder = comments.map((c) => c.id);
    historyFor(comments, 'tasks/post-it-notes.md');
    expect(comments.map((c) => c.id)).toEqual(originalOrder);
  });

  it('returns empty array when no applied comments exist for path (R-3.8)', () => {
    const comments = [rec({ status: 'open' })];
    expect(historyFor(comments, 'tasks/post-it-notes.md')).toEqual([]);
    expect(historyFor([], 'tasks/post-it-notes.md')).toEqual([]);
  });

  it('a record flipping open→applied moves from open filter to history filter (R-3.1/R-3.9)', () => {
    const openComment = rec({ id: 'c-flip', status: 'open' });
    const appliedComment = { ...openComment, status: 'applied' as const, ts: '2026-06-21T00:00:00Z' };

    // When open: not in history
    const openList = historyFor([openComment], 'tasks/post-it-notes.md');
    expect(openList).toHaveLength(0);

    // When applied: in history, not in open
    const historyList = historyFor([appliedComment], 'tasks/post-it-notes.md');
    expect(historyList).toHaveLength(1);
    expect(historyList[0]!.id).toBe('c-flip');
  });
});

describe('anchorLabelOf', () => {
  it('returns heading when heading is present (R-3.7)', () => {
    const c = rec({ target: { path: 'a.md', kind: 'range', heading: 'Acceptance Criteria', startLine: 5 } });
    expect(anchorLabelOf(c)).toBe('Acceptance Criteria');
  });

  it('returns line label when only startLine is present (R-3.7)', () => {
    const c = rec({ target: { path: 'a.md', kind: 'range', startLine: 10 } });
    expect(anchorLabelOf(c)).toBe('L10');
  });

  it('returns line range label when startLine and endLine are present (R-3.7)', () => {
    const c = rec({ target: { path: 'a.md', kind: 'range', startLine: 10, endLine: 20 } });
    expect(anchorLabelOf(c)).toBe('L10–20');
  });

  it('falls back to path when neither heading nor startLine is present (R-3.7)', () => {
    const c = rec({ target: { path: 'tasks/notes.md', kind: 'file' } });
    expect(anchorLabelOf(c)).toBe('tasks/notes.md');
  });

  it('heading wins over startLine when both are present (R-3.7)', () => {
    const c = rec({ target: { path: 'a.md', kind: 'range', heading: 'Summary', startLine: 3 } });
    expect(anchorLabelOf(c)).toBe('Summary');
  });

  it('ignores empty heading and falls back to line label (R-3.7)', () => {
    const c = rec({ target: { path: 'a.md', kind: 'range', heading: '', startLine: 7 } });
    expect(anchorLabelOf(c)).toBe('L7');
  });

  it('ignores null heading and falls back to line label (R-3.7)', () => {
    const c = rec({ target: { path: 'a.md', kind: 'range', heading: null, startLine: 7 } });
    expect(anchorLabelOf(c)).toBe('L7');
  });
});

describe('CommentHistoryList source assertions', () => {
  const src = readFileSync(
    new URL('../../ui/comment-history-list.tsx', import.meta.url).pathname,
    'utf8'
  );

  it('renders "—" as the fallback when result field is empty/missing (R-3.6)', () => {
    expect(src).toContain("'—'");
  });

  it('has a defined empty-state string (R-3.8)', () => {
    expect(src).toContain('No applied comments yet.');
  });

  it('does NOT reference removeComment or patchComment — read-only (R proof)', () => {
    expect(src).not.toMatch(/removeComment|patchComment/);
  });

  it('does NOT call comments.remove or comments.patch — read-only (R proof)', () => {
    expect(src).not.toMatch(/\.remove\s*\(|\.patch\s*\(/);
  });
});
