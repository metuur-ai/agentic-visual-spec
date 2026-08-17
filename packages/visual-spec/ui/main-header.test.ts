/**
 * Source-assertion tests for MainHeader (ui/main-header.tsx).
 *
 * No jsdom/testing-library available: assertions read the source file and
 * verify structural properties that the coordinator requires.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  new URL('./main-header.tsx', import.meta.url).pathname,
  'utf8',
);

describe('MainHeader — History control (R-4.x / R-5.x)', () => {
  it('imports CommentHistoryList (reuse, not reimplement)', () => {
    expect(src).toContain("from './comment-history-list'");
    expect(src).toMatch(/\bCommentHistoryList\b/);
  });

  it('imports toPath from md-path to normalise the current-document path', () => {
    expect(src).toContain("from './md-path'");
    expect(src).toMatch(/\btoPath\b/);
  });

  it('renders CommentHistoryList with a toPath(…)-derived path (R-4.1)', () => {
    // The component must call toPath with the file prop and pass the result to
    // CommentHistoryList as its `path` prop.
    expect(src).toMatch(/toPath\s*\(\s*file\s*\)/);
    expect(src).toMatch(/CommentHistoryList[^/]*path\s*=\s*\{toPath\s*\(\s*file\s*\)\}/);
  });

  it('exposes a labelled "History" control (R-4.2)', () => {
    // Either visible text or aria-label must be "History".
    expect(src).toMatch(/History/);
    expect(src).toMatch(/aria-label="History"|>History</);
  });

  it('passes all comments (from useComments) to CommentHistoryList (R-4.3 / R-5.3)', () => {
    // The comments variable from useComments() must be forwarded directly.
    expect(src).toMatch(/CommentHistoryList[^/]*comments\s*=\s*\{comments\}/);
  });

  it('does NOT call removeComment or patchComment — read-only (R-4.x proof)', () => {
    expect(src).not.toMatch(/removeComment|patchComment/);
  });

  it('does NOT call comments.remove or comments.patch in the header — read-only (R-4.x proof)', () => {
    // The header must not mutate the comment list.
    // (CommentHistoryList guarantees this on its own; double-check at the usage site.)
    // Only false positive would be if the *header itself* wired up those calls.
    const historyBtnBlock = src.slice(src.indexOf('function HistoryButton'), src.indexOf('function InspectorToggle'));
    expect(historyBtnBlock).not.toMatch(/\.remove\s*\(|\.patch\s*\(/);
  });

  it('HistoryButton is rendered unconditionally in MainHeader (R-4.4 / R-5.1)', () => {
    // The HistoryButton must NOT be inside an `isMarkdown &&` or `mode === "view" &&` guard.
    // Simplest check: the JSX line that places HistoryButton is not immediately
    // preceded by isMarkdown or mode conditions on the same logical group.
    const headerJSX = src.slice(src.indexOf('export function MainHeader'));
    // It must appear in the JSX block
    expect(headerJSX).toMatch(/<HistoryButton/);
    // And it must not be solely inside an `isMarkdown &&` short-circuit (no `isMarkdown && <HistoryButton`)
    expect(headerJSX).not.toMatch(/isMarkdown\s*&&\s*[^<]*<HistoryButton/);
    expect(headerJSX).not.toMatch(/mode\s*===\s*['"]view['"]\s*&&\s*[^<]*<HistoryButton/);
  });
});
