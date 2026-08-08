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
 *
 * **Anchor source (task 7.3, R-7.4).** Placement and rendering are one component,
 * `Markers`; how a group of comments finds its element is an `IndicatorTarget`
 * supplied by the caller. Local mode builds those targets from `groupByStartLine`
 * + the line resolvers, exactly as before — the props it is mounted with, the
 * hooks it runs, the grouping, the resolver calls and the emitted DOM are all
 * unchanged. A second surface (collaboration) supplies targets that resolve by
 * node identity instead; nothing about that keying is known to this file, which
 * is why local mode cannot regress through it.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useComments } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import { resolveCodeAnchors, resolveMarkdownAnchors } from './anchor-resolver';
import { useActiveComment } from './active-comment';
import { groupByStartLine, type IndicatorGroup } from './indicator-model';

/**
 * One placeable marker: the comments it stands for, the text it announces, and how
 * to find the element it pins to. `element()` is called every frame by the shared
 * rAF loop and must return `null` — never throw — when the target is not on screen.
 */
export type IndicatorTarget = {
  comments: CommentRecord[];
  title: string;
  ariaLabel: string;
  /**
   * Presentation variant. Omitted in local mode, so its markers carry no extra
   * attribute and no extra style. `'stale'` means the block moved on under the
   * comment (collaboration's outdated state).
   */
  state?: 'stale';
  element: () => HTMLElement | null;
};

export type IndicatorLayerProps =
  | { path: string; mode: 'markdown' | 'code'; targets?: undefined }
  | { targets: IndicatorTarget[]; path?: undefined; mode?: undefined };

export function IndicatorLayer(props: IndicatorLayerProps) {
  return props.targets ? <Markers targets={props.targets} /> : <LineIndicators path={props.path} mode={props.mode} />;
}

/** The local-mode source: open comments on this path, grouped and resolved by line. */
function LineIndicators({ path, mode }: { path: string; mode: 'markdown' | 'code' }) {
  const { comments } = useComments(path);
  const groups = useMemo(
    () => groupByStartLine(comments.filter((c) => c.target.path === path && c.status === 'open')),
    [comments, path],
  );
  const targets = useMemo(() => groups.map((g) => lineTarget(g, mode)), [groups, mode]);
  return <Markers targets={targets} />;
}

function lineTarget(group: IndicatorGroup, mode: 'markdown' | 'code'): IndicatorTarget {
  const count = group.comments.length;
  return {
    comments: group.comments,
    title:
      count > 1
        ? `${count} comments on line ${group.line} — show in sidebar`
        : `Comment on line ${group.line} — show in sidebar`,
    ariaLabel: `${count} pending comment${count > 1 ? 's' : ''} on line ${group.line}`,
    element: () => {
      const els =
        mode === 'markdown'
          ? resolveMarkdownAnchors({ startLine: group.line, heading: group.heading })
          : resolveCodeAnchors(group.line);
      return els[0] ?? null;
    },
  };
}

/**
 * A tracked target and the block's own viewport box. Both the badge and the shading are
 * derived from this at render time rather than pre-baked here, so the two stay in the
 * lanes below instead of one being expressed as an offset from the other.
 */
type Placed = { target: IndicatorTarget; top: number; left: number; width: number; height: number };

/*
 * THE GUTTER HAS TWO LANES, AND THEY MUST NOT SHARE.
 *
 * The badge used to sit 16px left of the block while the shading reached 9px back into the
 * same strip, so the shading's left rule ran underneath the badge and out the bottom of it:
 * a round marker on a vertical stem, reading as one lollipop-shaped ornament rather than as
 * a count and a highlighted passage. Each now owns a strip and a gap separates them.
 *
 *   [ badge ][ gap ][ rule ][ pad ][ the block itself ]
 *     14px     4px     3px     9px
 */
const BADGE_SIZE = 14;
const BADGE_INSET = 30;
const RULE_INSET = 12;
const RULE_WIDTH = 3;
const RULE_PAD = RULE_INSET - RULE_WIDTH;

function Markers({ targets }: { targets: IndicatorTarget[] }) {
  const { activeId, setActiveId } = useActiveComment();
  const [placed, setPlaced] = useState<Placed[]>([]);
  useEffect(() => {
    if (!targets.length) {
      setPlaced([]);
      return;
    }
    let raf = 0;
    const track = () => {
      const next: Placed[] = [];
      for (const t of targets) {
        const el = t.element();
        if (!el || !el.isConnected) continue; // unresolved target → omit, no error (R-1.9)
        const r = el.getBoundingClientRect();
        if (r.height === 0 && r.width === 0) continue;
        next.push({ target: t, top: r.top, left: r.left, width: r.width, height: r.height });
      }
      setPlaced(next);
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [targets]);

  if (!placed.length) return null;
  return (
    <div style={overlay}>
      {placed.map(({ target, top, left, width, height }) => {
        const first = target.comments[0]!;
        const count = target.comments.length;
        const isActive = target.comments.some((c) => c.id === activeId);
        return (
          <Fragment key={first.id}>
            {/*
              * The commented area itself, shaded. Never interactive: the inspector
              * hit-tests clicks through this layer to start a comment, and a highlight
              * that swallowed them would make the block underneath uncommentable.
              */}
            <div
              aria-hidden
              data-vs-comment-area={first.id}
              style={{
                ...area,
                top,
                left: Math.max(0, left - RULE_INSET),
                width,
                height,
                paddingLeft: RULE_PAD,
                ...(target.state === 'stale' ? areaStale : {}),
                ...(isActive ? areaActive : {}),
              }}
            />
            <button
            type="button"
            onClick={() => setActiveId(first.id)}
            title={target.title}
            aria-label={target.ariaLabel}
            data-vs-indicator-state={target.state}
            style={{
              ...mark,
              // Centred on the block rather than pinned to its first line: a marker that
              // floats at the top of a tall paragraph reads as belonging to the gap above it.
              top: top + Math.max(0, (height - BADGE_SIZE) / 2),
              left: Math.max(2, left - BADGE_INSET),
              ...(target.state === 'stale' ? markStale : {}),
              ...(isActive ? markActive : {}),
            }}
          >
            {count > 1 ? count : ''}
          </button>
          </Fragment>
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
  minWidth: BADGE_SIZE,
  height: BADGE_SIZE,
  padding: 0,
  border: '1px solid #f59e0b',
  borderRadius: BADGE_SIZE / 2,
  background: '#fbbf24',
  color: '#78350f',
  font: `9px/${BADGE_SIZE}px ui-monospace, monospace`,
  fontWeight: 700,
  textAlign: 'center',
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(120,53,15,0.25)',
};
const markActive: React.CSSProperties = {
  background: '#f59e0b',
  boxShadow: '0 0 0 3px rgba(245,158,11,0.35)',
};
// Hollow + dashed: still amber, but visibly not a settled anchor.
const markStale: React.CSSProperties = {
  border: '1px dashed #b45309',
  background: '#fef3c7',
  color: '#92400e',
};

/*
 * The commented area. Amber like the badge it belongs to (R-1.7 keeps that lane clear of
 * the inspector's blue), but far weaker: this sits under running prose the reader still
 * has to read, so it tints rather than covers. The left rule is what carries at a glance —
 * a block-level "this stretch is under discussion" — and the wash tells you where it ends.
 */
const area: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  background: 'rgba(251,191,36,0.13)',
  borderLeft: `${RULE_WIDTH}px solid rgba(245,158,11,0.55)`,
  borderRadius: 2,
  boxSizing: 'content-box',
  transition: 'background 120ms',
};
/** The thread the sidebar has focused: same shape, enough contrast to find by eye. */
const areaActive: React.CSSProperties = {
  background: 'rgba(251,191,36,0.28)',
  borderLeft: `${RULE_WIDTH}px solid #f59e0b`,
};
/** Dashed rule, matching the badge: anchored, but the block moved on under it (R-6.3). */
const areaStale: React.CSSProperties = {
  background: 'rgba(251,191,36,0.08)',
  borderLeft: `${RULE_WIDTH}px dashed #b45309`,
};
