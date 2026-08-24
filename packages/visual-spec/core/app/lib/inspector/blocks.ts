/**
 * blocks.ts — DOM helpers for multi-block selection in the markdown surface.
 * The selectable unit is a "top-level block": a direct child of the inspector
 * root, each stamped with data-vs-loc="<line>:<col>" by the loc-tags transform.
 * Used by the inspect overlay (Cmd/Alt gestures) and the comment panel.
 */
import type { SelectedTarget } from '../../components/inspector/inspector-provider';

/*
 * The range gesture is Cmd (Ctrl off the Mac), not Shift.
 *
 * Shift+click is the browser's own "extend the text selection to here", and it is not
 * ours to borrow: holding it painted a native highlight across the document at the same
 * moment we painted our selection frames, so the surface answered one gesture twice, in
 * two visual languages. The overlay could not take it back either — it acts on `click`,
 * and the browser has already extended the selection on `mousedown`.
 *
 * This lives beside the block helpers rather than in either caller because the markdown
 * overlay and the line gutter must agree on it: one rule the reader learns once, in a
 * single place to change when they disagree.
 */
export function isRangeClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/** How to spell the range modifier for this platform, for UI that teaches the gesture. */
export const RANGE_KEY_LABEL: string =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

/** The direct child of `root` that contains `el` (the top-level block), or null. */
export function topBlock(root: HTMLElement, el: HTMLElement): HTMLElement | null {
  let n: HTMLElement | null = el;
  while (n && n.parentElement && n.parentElement !== root) n = n.parentElement;
  return n && n.parentElement === root ? n : null;
}

/** Heading level (1–6) if `el` is an h1–h6, else null. */
export function headingLevel(el: HTMLElement): number | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

/** Build a SelectedTarget from a block element's data-vs-loc, or null if untagged. */
export function blockTargetFromEl(el: HTMLElement): SelectedTarget | null {
  const raw = el.getAttribute('data-vs-loc');
  if (!raw) return null;
  const [l, c] = raw.split(':');
  const line = Number(l);
  const column = Number(c);
  if (!Number.isFinite(line)) return null;
  return { line, column: Number.isFinite(column) ? column : 0, anchor: el };
}

/** Every top-level block from `a` to `b` inclusive, in document order. */
export function collectRange(root: HTMLElement, a: HTMLElement, b: HTMLElement): SelectedTarget[] {
  const topA = topBlock(root, a);
  const topB = topBlock(root, b);
  if (!topA || !topB) return [];
  const kids = Array.from(root.children) as HTMLElement[];
  let i = kids.indexOf(topA);
  let j = kids.indexOf(topB);
  if (i < 0 || j < 0) return [];
  if (i > j) [i, j] = [j, i];
  const out: SelectedTarget[] = [];
  for (let k = i; k <= j; k++) {
    const t = blockTargetFromEl(kids[k]!);
    if (t) out.push(t);
  }
  return out;
}

/**
 * The whole section under a heading: the heading block plus every following
 * top-level block until the next heading of the same or higher level. Returns []
 * if `heading` is not (inside) a heading block.
 */
export function collectSection(root: HTMLElement, heading: HTMLElement): SelectedTarget[] {
  const top = topBlock(root, heading);
  if (!top) return [];
  const level = headingLevel(top);
  if (level == null) return [];
  const kids = Array.from(root.children) as HTMLElement[];
  const start = kids.indexOf(top);
  if (start < 0) return [];
  const out: SelectedTarget[] = [];
  for (let k = start; k < kids.length; k++) {
    const el = kids[k]!;
    if (k > start) {
      const hl = headingLevel(el);
      if (hl != null && hl <= level) break; // next same-or-higher heading ends the section
    }
    const t = blockTargetFromEl(el);
    if (t) out.push(t);
  }
  return out;
}

/** The heading block enclosing `el` (the top-level block, if it is a heading), else null. */
export function headingBlockOf(root: HTMLElement, el: HTMLElement): HTMLElement | null {
  const top = topBlock(root, el);
  return top && headingLevel(top) != null ? top : null;
}
