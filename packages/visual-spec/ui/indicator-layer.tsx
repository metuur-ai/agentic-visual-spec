/**
 * indicator-layer.tsx — subtle inline markers showing where open comments live
 * in the currently displayed file, independent of the sidebar (Subsystem A).
 *
 * Rendered only by View-mode components (markdown-editor, generic-editor's code
 * view), so it never appears in Edit modes (R-1.8). Anchors reuse the shared
 * resolver (data-vs-loc for markdown, data-line for code). A single shared rAF
 * loop batches every marker's position so they stay glued as layout shifts
 * without per-indicator tracking (R-1.5, R-1.6). Clicking a marker activates the
 * corresponding comment in the sidebar (R-2.1).
 */
import { useEffect, useMemo, useState } from 'react';
import { useComments } from '../core/app';
import { resolveCodeAnchors, resolveMarkdownAnchors } from './anchor-resolver';
import { useActiveComment } from './active-comment';
import { groupByStartLine, type IndicatorGroup } from './indicator-model';

type Placed = { group: IndicatorGroup; top: number; left: number };

export function IndicatorLayer({ path, mode }: { path: string; mode: 'markdown' | 'code' }) {
  const { comments } = useComments(path);
  const { activeId, setActiveId } = useActiveComment();
  const groups = useMemo(
    () => groupByStartLine(comments.filter((c) => c.target.path === path && c.status === 'open')),
    [comments, path],
  );

  const [placed, setPlaced] = useState<Placed[]>([]);
  useEffect(() => {
    if (!groups.length) {
      setPlaced([]);
      return;
    }
    let raf = 0;
    const track = () => {
      const next: Placed[] = [];
      for (const g of groups) {
        const els =
          mode === 'markdown'
            ? resolveMarkdownAnchors({ startLine: g.line, heading: g.heading })
            : resolveCodeAnchors(g.line);
        const el = els[0];
        if (!el || !el.isConnected) continue; // unresolved target → omit, no error (R-1.9)
        const r = el.getBoundingClientRect();
        if (r.height === 0 && r.width === 0) continue;
        next.push({ group: g, top: r.top + 2, left: Math.max(2, r.left - 16) });
      }
      setPlaced(next);
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [groups, mode]);

  if (!placed.length) return null;
  return (
    <div style={overlay}>
      {placed.map(({ group, top, left }) => {
        const first = group.comments[0]!;
        const count = group.comments.length;
        const isActive = group.comments.some((c) => c.id === activeId);
        return (
          <button
            key={first.id}
            type="button"
            onClick={() => setActiveId(first.id)}
            title={
              count > 1
                ? `${count} comments on line ${group.line} — show in sidebar`
                : `Comment on line ${group.line} — show in sidebar`
            }
            aria-label={`${count} pending comment${count > 1 ? 's' : ''} on line ${group.line}`}
            style={{ ...mark, top, left, ...(isActive ? markActive : {}) }}
          >
            {count > 1 ? count : ''}
          </button>
        );
      })}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  // Below InspectOverlay (2147483000) so an active inspector still wins hit-testing.
  zIndex: 2147482000,
};

// Amber, deliberately distinct from the blue selection frames and blue flash (R-1.7).
const mark: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'auto',
  minWidth: 14,
  height: 14,
  padding: 0,
  border: '1px solid #f59e0b',
  borderRadius: 7,
  background: '#fbbf24',
  color: '#78350f',
  font: '9px/14px ui-monospace, monospace',
  fontWeight: 700,
  textAlign: 'center',
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(120,53,15,0.25)',
};
const markActive: React.CSSProperties = {
  background: '#f59e0b',
  boxShadow: '0 0 0 3px rgba(245,158,11,0.35)',
};
