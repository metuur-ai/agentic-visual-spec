/**
 * indicator-layer.test.ts
 *
 * Subsystem A — inline indicators + reverse navigation.
 * Convention: pure-function tests + source-assertions (no jsdom).
 *
 * Covers:
 *   R-1.5  multiple comments on one line collapse into a single group (count).
 *   R-1.3  only line-anchored open comments produce indicators (no-startLine skipped).
 *   R-1.8  indicators render in View components only, never Edit components.
 *   R-1.6  a single shared rAF loop positions all indicators.
 *   R-2.1/R-2.2  clicking an indicator activates + scrolls the sidebar row.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CommentRecord } from '../core/editing/comment-doc';
import { groupByStartLine } from './indicator-model';

function src(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

const rec = (over: Partial<CommentRecord> = {}): CommentRecord => ({
  id: 'c-00000001',
  workflow: 'visual-spec',
  target: { path: 'a.md', kind: 'range', startLine: 10, snippet: 's' },
  comment: 'x',
  status: 'open',
  ts: '2026-07-01T00:00:00Z',
  ...over,
});

describe('A1.4/R-1.5 — groupByStartLine (pure)', () => {
  it('collapses multiple comments on the same line into one group', () => {
    const groups = groupByStartLine([
      rec({ id: 'c-1', target: { path: 'a.md', kind: 'range', startLine: 10 } }),
      rec({ id: 'c-2', target: { path: 'a.md', kind: 'range', startLine: 10 } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.comments.map((c) => c.id)).toEqual(['c-1', 'c-2']);
  });

  it('orders groups by line ascending', () => {
    const groups = groupByStartLine([
      rec({ id: 'c-a', target: { path: 'a.md', kind: 'range', startLine: 30 } }),
      rec({ id: 'c-b', target: { path: 'a.md', kind: 'range', startLine: 5 } }),
    ]);
    expect(groups.map((g) => g.line)).toEqual([5, 30]);
  });

  it('skips comments with no start line (whole-file/folder targets) — R-1.3', () => {
    const groups = groupByStartLine([
      rec({ id: 'c-file', target: { path: 'a.md', kind: 'file' } }),
      rec({ id: 'c-line', target: { path: 'a.md', kind: 'range', startLine: 7 } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.line).toBe(7);
  });

  it('carries the first comment heading onto the group', () => {
    const groups = groupByStartLine([
      rec({ target: { path: 'a.md', kind: 'range', startLine: 4, heading: 'Intro' } }),
    ]);
    expect(groups[0]!.heading).toBe('Intro');
  });
});

describe('R-1.8 — indicators render in View mode only', () => {
  const view = ['./markdown-editor.tsx', './generic-editor.tsx'];
  const edit = ['./markdown-doc-editor.tsx', './wysiwyg-editor.tsx', './source-editor.tsx'];

  for (const f of view) {
    it(`${f} (View) mounts IndicatorLayer`, () => {
      expect(src(f)).toMatch(/<IndicatorLayer\b/);
    });
  }
  for (const f of edit) {
    it(`${f} (Edit) does NOT reference IndicatorLayer`, () => {
      expect(src(f)).not.toMatch(/IndicatorLayer/);
    });
  }
});

describe('R-1.6 — one shared rAF loop; resolver reuse', () => {
  const layer = src('./indicator-layer.tsx');
  it('uses a single requestAnimationFrame tracking loop', () => {
    expect((layer.match(/requestAnimationFrame/g) ?? []).length).toBe(1);
    expect(layer).toContain('cancelAnimationFrame');
  });
  it('resolves anchors via the shared resolver, not ad-hoc queries', () => {
    expect(layer).toContain('resolveMarkdownAnchors');
    expect(layer).toContain('resolveCodeAnchors');
    expect(layer).not.toMatch(/querySelector/);
  });
});

describe('R-2.1/R-2.2 — indicator activates + sidebar scrolls', () => {
  const layer = src('./indicator-layer.tsx');
  const panel = src('./comment-panel.tsx');
  const generic = src('./generic-panel.tsx');

  it('indicator click sets the active comment', () => {
    expect(layer).toContain('useActiveComment');
    expect(layer).toMatch(/setActiveId\(/);
  });

  it('comment list highlights and scrolls the active row', () => {
    expect(panel).toContain('useActiveComment');
    expect(panel).toMatch(/scrollIntoView/);
    expect(panel).toContain('cardActive');
  });

  it('generic (code/file) list also highlights and scrolls the active row', () => {
    expect(generic).toContain('useActiveComment');
    expect(generic).toMatch(/scrollIntoView/);
    expect(generic).toContain('cardActive');
  });
});
