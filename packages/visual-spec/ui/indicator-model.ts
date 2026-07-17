/**
 * indicator-model.ts — pure grouping logic for inline comment indicators.
 * Kept DOM-free so it is testable without jsdom (package convention).
 */
import type { CommentRecord } from '../core/editing/comment-doc';

export type IndicatorGroup = {
  line: number;
  heading: string | null;
  comments: CommentRecord[];
};

/**
 * Group open, line-anchored comments by their start line so multiple comments
 * on one line collapse into a single indicator (R-1.5). Comments without a
 * start line (whole-file / folder targets) have no inline anchor and are
 * skipped. Returned groups are sorted by line ascending.
 */
export function groupByStartLine(comments: CommentRecord[]): IndicatorGroup[] {
  const byLine = new Map<number, CommentRecord[]>();
  for (const c of comments) {
    const line = c.target.startLine;
    if (line == null) continue;
    const bucket = byLine.get(line);
    if (bucket) bucket.push(c);
    else byLine.set(line, [c]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, cs]) => ({ line, heading: cs[0]!.target.heading ?? null, comments: cs }));
}
