/**
 * anchor-resolver.ts — resolve a comment's target to the DOM element(s) it is
 * anchored to, in either the markdown surface ([data-vs-loc] under
 * [data-inspector-root]) or the code view ([data-line]).
 *
 * Shared by locate()/locateLine() (sidebar → document navigation) and the
 * inline-indicator layer (document-side markers) so both use one
 * drift-resilient resolution path instead of duplicating selector logic.
 *
 * The pure range math is exported separately so it is testable without a DOM,
 * matching this package's no-jsdom test convention.
 */

export type AnchorTarget = { heading?: string | null; startLine?: number; endLine?: number };

/** Inclusive list of line numbers a range covers. Pure — no DOM. */
export function rangeLines(startLine: number, endLine?: number): number[] {
  const last = endLine && endLine > startLine ? endLine : startLine;
  const out: number[] = [];
  for (let n = startLine; n <= last; n++) out.push(n);
  return out;
}

/** The markdown surface root the resolver queries, or null when absent. */
export function markdownRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector('[data-inspector-root]') as HTMLElement | null;
}

/**
 * Resolve the markdown block element(s) a comment anchors to. Matches by
 * `[data-vs-loc^="<startLine>:"]`, falling back to a heading-text match when the
 * line has drifted, then extends across sibling blocks within an end-line range.
 * Returns [] when nothing resolves (never throws).
 */
export function resolveMarkdownAnchors(
  target: AnchorTarget,
  root: ParentNode | null = markdownRoot(),
): HTMLElement[] {
  if (!root || target.startLine == null) return [];
  const line = target.startLine;
  let el = root.querySelector(`[data-vs-loc^="${line}:"]`) as HTMLElement | null;
  if (!el && target.heading) {
    const heads = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
    el = heads.find((h) => h.textContent?.trim() === target.heading) ?? null;
  }
  if (!el) return [];
  const els = [el];
  if (target.endLine && target.endLine > line && 'children' in root) {
    for (const kid of Array.from((root as Element).children) as HTMLElement[]) {
      const loc = kid.getAttribute('data-vs-loc');
      const ln = loc ? Number(loc.split(':')[0]) : NaN;
      if (ln > line && ln <= target.endLine) els.push(kid);
    }
  }
  return els;
}

/**
 * Resolve the code-view row element(s) for a 1-indexed line range, by
 * `[data-line]`. Returns [] when nothing resolves (never throws).
 */
export function resolveCodeAnchors(
  startLine: number,
  endLine?: number,
  root: ParentNode | null = typeof document !== 'undefined' ? document : null,
): HTMLElement[] {
  if (!root) return [];
  const els: HTMLElement[] = [];
  for (const n of rangeLines(startLine, endLine)) {
    const el = root.querySelector(`[data-line="${n}"]`) as HTMLElement | null;
    if (el) els.push(el);
  }
  return els;
}
