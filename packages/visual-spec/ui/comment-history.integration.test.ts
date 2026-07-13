/**
 * comment-history.integration.test.ts
 *
 * Source-assertion + pure-function tests locking in the safety and availability
 * guarantees for the comment-history feature.
 *
 * Technique: read source files as plain strings, assert on stable identifiers.
 * No jsdom / testing-library — these tests run in Node via vitest.
 *
 * Requirements covered:
 *   TASK 2.4  R-2.6  Applied records are never deleted by any history path.
 *   TASK 5    R-5.1  HistoryButton + History tab are always available (both modes).
 *             R-5.3  Cross-tab / focus refresh wires through useComments in every view.
 *             R-5.4  History views are read-only — no mutators reachable from them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CommentRecord, historyFor } from '../core/editing/comment-doc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function src(relPath: string): string {
  const abs = fileURLToPath(new URL(relPath, import.meta.url));
  return readFileSync(abs, 'utf8');
}

const historyListSrc = src('./comment-history-list.tsx');
const commentPanelSrc = src('./comment-panel.tsx');
const mainHeaderSrc = src('./ui/../main-header.tsx'); // same dir — kept explicit
const useCommentsSrc = src('../core/app/lib/use-comments.ts');

// ---------------------------------------------------------------------------
// Shared record factory (mirrors existing test files)
// ---------------------------------------------------------------------------

const rec = (over: Partial<CommentRecord> = {}): CommentRecord => ({
  id: 'c-00000001',
  workflow: 'visual-spec',
  target: { path: 'tasks/spec.md', kind: 'range', startLine: 10, snippet: 'The system shall' },
  comment: 'Cover edge case',
  status: 'open',
  ts: '2026-07-01T00:00:00Z',
  ...over,
});

// ---------------------------------------------------------------------------
// TASK 2.4 — R-2.6: Applied records are never deleted via any history path
// ---------------------------------------------------------------------------

describe('TASK 2.4 / R-2.6 — history paths never delete applied records', () => {
  // ---- 2.4-A: comment-history-list.tsx contains no reference to the delete fn ----
  it('comment-history-list.tsx does NOT import or call removeComment (R-2.6)', () => {
    expect(historyListSrc).not.toMatch(/removeComment/);
  });

  it('comment-history-list.tsx has no delete or remove handler (R-2.6)', () => {
    // No call to comments.remove(), no "delete" aria-label, no delete-style method
    expect(historyListSrc).not.toMatch(/\.remove\s*\(/);
    expect(historyListSrc).not.toMatch(/\.delete\s*\(/);
    expect(historyListSrc).not.toMatch(/removeComment/);
  });

  // ---- 2.4-B: main-header.tsx history region wires CommentHistoryList, not removeComment ----
  it('main-header.tsx HistoryButton renders CommentHistoryList (R-2.6)', () => {
    // HistoryButton must reference CommentHistoryList
    expect(mainHeaderSrc).toContain('HistoryButton');
    expect(mainHeaderSrc).toContain('CommentHistoryList');
  });

  it('main-header.tsx does NOT wire removeComment into the history UI (R-2.6)', () => {
    expect(mainHeaderSrc).not.toMatch(/removeComment/);
  });

  // ---- 2.4-C: removeComment appears in comment-panel.tsx but NOT in comment-history-list.tsx ----
  it('removeComment (via comments.remove) is called only in comment-panel.tsx open list, never in history paths (R-2.6)', () => {
    // The open-comment delete affordance in CommentList calls comments.remove()
    expect(commentPanelSrc).toMatch(/comments\.remove\s*\(/);

    // The history view must NOT call it
    expect(historyListSrc).not.toMatch(/comments\.remove\s*\(/);

    // main-header.tsx (which hosts the history popover) must NOT call it
    expect(mainHeaderSrc).not.toMatch(/comments\.remove\s*\(/);
  });

  // ---- 2.4-D: pure — historyFor is non-destructive; input array unchanged after call ----
  it('historyFor does not mutate the input array (non-destructive, R-2.6)', () => {
    const input: CommentRecord[] = [
      rec({ id: 'c-new', status: 'applied', ts: '2026-07-13T00:00:00Z' }),
      rec({ id: 'c-old', status: 'applied', ts: '2026-07-01T00:00:00Z' }),
      rec({ id: 'c-open', status: 'open',    ts: '2026-07-10T00:00:00Z' }),
    ];
    const snapshotIds = input.map((c) => c.id);
    const snapshotStatuses = input.map((c) => c.status);

    historyFor(input, 'tasks/spec.md');

    // Array identity: same length, same order, same values
    expect(input.map((c) => c.id)).toEqual(snapshotIds);
    expect(input.map((c) => c.status)).toEqual(snapshotStatuses);
  });

  it('historyFor returns a sorted copy without touching original objects (R-2.6)', () => {
    const c1 = rec({ id: 'c-a', status: 'applied', ts: '2026-07-01T00:00:00Z' });
    const c2 = rec({ id: 'c-b', status: 'applied', ts: '2026-07-10T00:00:00Z' });
    const input = [c1, c2];

    const result = historyFor(input, 'tasks/spec.md');

    // Result is newest-first
    expect(result.map((c) => c.id)).toEqual(['c-b', 'c-a']);
    // Input remains oldest-first (original order)
    expect(input.map((c) => c.id)).toEqual(['c-a', 'c-b']);
    // Result is a different array instance
    expect(result).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// TASK 5 / R-5.4 — History views are read-only (no mutators reachable)
// ---------------------------------------------------------------------------

describe('TASK 5 / R-5.4 — history view is read-only (no mutators)', () => {
  // The full set of exported mutator identifiers from comment-doc.ts
  const mutators = ['addComment', 'removeComment', 'setStatus'];

  for (const mutator of mutators) {
    it(`comment-history-list.tsx does NOT reference mutator "${mutator}" (R-5.4)`, () => {
      expect(historyListSrc).not.toContain(mutator);
    });
  }

  it('comment-history-list.tsx does NOT import any mutator from comment-doc (R-5.4)', () => {
    // The import line from comment-doc must only pull in read-only utilities
    const importLine = historyListSrc.match(/from ['"].*comment-doc['"]/g) ?? [];
    // Either there is exactly one import line pulling in only anchorLabelOf + historyFor,
    // or there is no import of addComment/removeComment/setStatus anywhere in the file.
    for (const mutator of mutators) {
      expect(historyListSrc).not.toContain(mutator);
    }
    // Confirm the read-only helpers ARE present (regression guard)
    expect(historyListSrc).toContain('historyFor');
    expect(historyListSrc).toContain('anchorLabelOf');
    // Satisfy linter — importLine used
    expect(Array.isArray(importLine)).toBe(true);
  });

  it('main-header.tsx HistoryButton does NOT call add/remove/setStatus mutators (R-5.4)', () => {
    for (const mutator of mutators) {
      expect(mainHeaderSrc).not.toContain(mutator);
    }
  });
});

// ---------------------------------------------------------------------------
// TASK 5 / R-5.3 — Cross-tab + focus refresh wires through useComments
// ---------------------------------------------------------------------------

describe('TASK 5 / R-5.3 — cross-tab and focus refresh via useComments', () => {
  it('useComments subscribes to the "vs:comments-changed" cross-tab event (R-5.3)', () => {
    // This is the exact custom event string dispatched by apply.ts on job completion
    expect(useCommentsSrc).toContain('vs:comments-changed');
    expect(useCommentsSrc).toMatch(/addEventListener\s*\(\s*['"]vs:comments-changed['"]/);
  });

  it('useComments subscribes to the "focus" window event for cross-tab refresh (R-5.3)', () => {
    expect(useCommentsSrc).toContain("addEventListener('focus'");
  });

  it('useComments subscribes to visibilitychange for background-tab awareness (R-5.3)', () => {
    expect(useCommentsSrc).toContain('visibilitychange');
  });

  it('comment-panel.tsx obtains its comment data via useComments (R-5.3)', () => {
    // The panel must import and call useComments so it gets the refresh subscription
    expect(commentPanelSrc).toContain('useComments');
  });

  it('main-header.tsx obtains its comment data via useComments (R-5.3)', () => {
    // The header cart + HistoryButton both receive comments from useComments()
    expect(mainHeaderSrc).toContain('useComments');
    // The destructuring call must appear in MainHeader
    expect(mainHeaderSrc).toMatch(/useComments\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// TASK 5 / R-5.1 — HistoryButton and History tab always available (both modes)
// ---------------------------------------------------------------------------

describe('TASK 5 / R-5.1 — history always reachable in view and edit modes', () => {
  it('main-header.tsx renders HistoryButton unconditionally — not gated by withInspector (R-5.1)', () => {
    // In MainHeader, HistoryButton must NOT be inside an `{withInspector &&` block.
    // Extract the JSX block around HistoryButton and confirm withInspector does not guard it.
    const histIdx = mainHeaderSrc.indexOf('<HistoryButton');
    expect(histIdx).toBeGreaterThan(-1);
    // The 120 chars before <HistoryButton must not include "withInspector &&"
    const preceding = mainHeaderSrc.slice(Math.max(0, histIdx - 120), histIdx);
    expect(preceding).not.toMatch(/withInspector\s*&&/);
  });

  it('main-header.tsx renders HistoryButton not gated by mode === "view" (R-5.1)', () => {
    const histIdx = mainHeaderSrc.indexOf('<HistoryButton');
    expect(histIdx).toBeGreaterThan(-1);
    const preceding = mainHeaderSrc.slice(Math.max(0, histIdx - 120), histIdx);
    // mode guard would look like: mode === 'view' && or {mode === 'view' &&
    expect(preceding).not.toMatch(/mode\s*===\s*['"]view['"]\s*&&/);
  });

  it('comment-panel.tsx TabBar appears in the inactive-inspector return path (R-5.1)', () => {
    // The !active branch renders TabBar so the History tab is reachable even
    // when the inspector is not active (view-only sidebar mode).
    // We confirm TabBar appears before the `if (!active) return` block closes
    // by checking that the source contains TabBar in the !active JSX block.
    // Simple proxy: "!active" and "<TabBar" both appear; we verify that the
    // substring between the `if (!active)` check and the closing `}` includes TabBar.
    const inactiveMatch = mainHeaderSrc.match(/if\s*\(!active\)/);
    // (This guard lives in comment-panel.tsx, not main-header.tsx)
    const panelInactiveIdx = commentPanelSrc.indexOf('if (!active)');
    expect(panelInactiveIdx).toBeGreaterThan(-1);
    // TabBar must appear after the !active guard (covers the inactive branch)
    const afterInactive = commentPanelSrc.slice(panelInactiveIdx);
    expect(afterInactive).toContain('<TabBar');
    // Suppress unused-var warning for inactiveMatch
    expect(inactiveMatch).toBeNull(); // main-header does NOT have !active guard (expected)
  });

  it('comment-panel.tsx TabBar also appears in the active-inspector return path (R-5.1)', () => {
    // The active (editing) branch also needs a TabBar so History is reachable
    // when the user is actively commenting.
    // Strategy: count <TabBar occurrences — must be >= 2 (one per branch).
    const matches = commentPanelSrc.match(/<TabBar/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('comment-panel.tsx History tab content (CommentHistoryList) rendered in both branches (R-5.1)', () => {
    // Both the active and inactive return paths render CommentHistoryList for the history tab.
    const matches = commentPanelSrc.match(/CommentHistoryList/g) ?? [];
    // Import counts as 1; each usage in JSX adds more — at least 3 total (import + 2 uses)
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
