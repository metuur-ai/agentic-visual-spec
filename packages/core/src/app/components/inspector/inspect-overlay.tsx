/**
 * inspect-overlay.tsx — hover/click hit-testing when the inspector is active.
 * Resolves the element under the cursor to a source location via data-vs-loc and
 * draws hover (dashed) / selection (solid) frames tracked to the element's rect.
 */
import { useEffect, useRef, useState } from 'react';
import { collectRange, collectSection, headingBlockOf } from '../../lib/inspector/blocks';
import { findSurfaceSource } from '../../lib/inspector/fiber';
import { toSelected, useInspector } from './inspector-provider';

type Rect = { top: number; left: number; width: number; height: number };

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function InspectOverlay({ rootSelector = '[data-inspector-root]' }: { rootSelector?: string }) {
  const { active, surfaceId, selection, setSelection } = useInspector();
  const [hoverRect, setHoverRect] = useState<Rect | null>(null);
  const hoverTarget = useRef<HTMLElement | null>(null);
  // Read the latest selection inside the click handler without re-binding the listener.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!active) {
      setHoverRect(null);
      hoverTarget.current = null;
      return;
    }

    const onMove = (e: MouseEvent) => {
      const stack = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[];
      const el = stack.find((node) => node.closest(rootSelector));
      const loc = findSurfaceSource(el ?? null, surfaceId, { hostOnly: true });
      if (loc) {
        hoverTarget.current = loc.anchor;
        setHoverRect(rectOf(loc.anchor));
      } else {
        hoverTarget.current = null;
        setHoverRect(null);
      }
    };

    const onClick = (e: MouseEvent) => {
      // Let the overlay's own action buttons (e.g. "select section") handle their
      // clicks instead of swallowing them as a re-selection.
      if ((e.target as HTMLElement | null)?.closest?.('[data-vs-action]')) return;
      const stack = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[];
      const el = stack.find((node) => node.closest(rootSelector));
      const loc = findSurfaceSource(el ?? null, surfaceId);
      if (!loc) return;
      e.preventDefault();
      e.stopPropagation();
      const root = loc.anchor.closest(rootSelector) as HTMLElement | null;
      // Alt/Option+click a heading selects its whole section.
      if (e.altKey && root) {
        const section = collectSection(root, loc.anchor);
        if (section.length) {
          setSelection(section);
          return;
        }
      }
      // Shift+click extends a contiguous range from the first selected block to here.
      if (e.shiftKey && root && selectionRef.current.length > 0) {
        const start = selectionRef.current[0]!.anchor;
        if (start.isConnected) {
          const range = collectRange(root, start, loc.anchor);
          if (range.length) {
            setSelection(range);
            return;
          }
        }
      }
      setSelection([toSelected(loc)]);
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
    };
  }, [active, surfaceId, setSelection]);

  // Keep one selection frame glued to each selected block as layout shifts.
  const [selRects, setSelRects] = useState<Rect[]>([]);
  useEffect(() => {
    if (selection.length === 0) {
      setSelRects([]);
      return;
    }
    let raf = 0;
    const track = () => {
      setSelRects(selection.filter((s) => s.anchor.isConnected).map((s) => rectOf(s.anchor)));
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [selection]);

  if (!active) return null;

  const first = selection[0];
  const last = selection[selection.length - 1];
  const label = first
    ? selection.length > 1
      ? `L${first.line}–${last!.line} · ${selection.length} blocks`
      : `L${first.line}:${first.column}`
    : '';

  // When a single heading is selected, offer "select the whole section" right in
  // the main surface (mirrors the same action in the comment panel).
  const selRoot = first?.anchor?.closest(rootSelector) as HTMLElement | null;
  const headingEl = first && selRoot && selection.length === 1 ? headingBlockOf(selRoot, first.anchor) : null;
  const selectSection = () => {
    if (!selRoot || !headingEl) return;
    const section = collectSection(selRoot, headingEl);
    if (section.length > 1) setSelection(section);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483000 }}>
      {hoverRect ? <Frame rect={hoverRect} kind="hover" /> : null}
      {selRects.map((r, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Frame key={i} rect={r} kind="selected" label={i === 0 ? label : undefined} />
      ))}
      {headingEl && selRects[0] ? (
        <button
          type="button"
          data-vs-action="select-section"
          onClick={selectSection}
          title="Extend the selection to every block under this heading"
          style={{
            position: 'absolute',
            top: selRects[0].top + selRects[0].height + 6,
            left: selRects[0].left,
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            border: '1px solid #c7d2fe',
            borderRadius: 6,
            background: '#eef2ff',
            color: '#4338ca',
            cursor: 'pointer',
            font: '12px system-ui',
            fontWeight: 600,
            boxShadow: '0 4px 14px rgba(37,99,235,0.18)',
            whiteSpace: 'nowrap',
          }}
        >
          ⤢ Select all content under this heading
        </button>
      ) : null}
    </div>
  );
}

function Frame({ rect, kind, label }: { rect: Rect; kind: 'hover' | 'selected'; label?: string }) {
  const isSel = kind === 'selected';
  return (
    <div
      style={{
        position: 'absolute',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        border: isSel ? '2px solid #2563eb' : '1px dashed #60a5fa',
        background: isSel ? 'rgba(37,99,235,0.08)' : 'transparent',
        borderRadius: 2,
        transition: 'top 120ms, left 120ms, width 120ms, height 120ms',
        boxSizing: 'border-box',
      }}
    >
      {isSel && label ? (
        <span
          style={{
            position: 'absolute',
            top: -20,
            left: 0,
            font: '11px ui-monospace, monospace',
            background: '#2563eb',
            color: 'white',
            padding: '1px 6px',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
