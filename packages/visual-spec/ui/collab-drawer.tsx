/**
 * collab-drawer.tsx — the collaboration *picker*, as a right-side modal panel.
 *
 * WHY A DRAWER AND NOT A ROUTE. Choosing a pull request is a detour, not a destination:
 * the reviewer is looking at their files, wants to know what is open, and wants to come
 * back. `App.tsx` used to swap its whole shell for `CollabApp` to answer that — the file
 * tree, the open document and the header all unmounted so the user could read a list.
 * The drawer keeps the work behind it on screen and puts the list beside it, and the
 * full-surface swap is reserved for the thing that actually needs the width: the document
 * pane, or a pull request's code.
 *
 * ONLY THE ✕ CLOSES IT (product decision). No Escape, and a click on the scrim is
 * swallowed rather than treated as dismissal. Both are deliberate: `CollabPullsPanel`'s
 * buttons run git — a checkout, a `POST /__vs/collab/open` — and a stray click outside
 * the panel mid-mount would tear the surface down around a request already in flight.
 * The cost is the standard keyboard escape route, so the ✕ is paid for in the other
 * direction: it takes focus on open, it is the first thing in the tab order, and focus
 * cannot leave the panel while it is up.
 *
 * PICKING CLOSES IT. A row's `Resume writing` / `Review the code` hands the result up to
 * `App.tsx`, which dismisses the drawer and mounts the full-width surface. Nothing that
 * needs room is ever rendered in 480px.
 */
import { useEffect, useRef } from 'react';

import type { MountedWorktree, PullRequestSummary } from './collab-client';
import { CollabOpenPanel } from './collab-open-panel';
import { CollabPullsPanel } from './collab-pulls-panel';

export type CollabDrawerProps = {
  /** The ✕, and nothing else. */
  onClose: () => void;
  /** R-7.7 — a pull request that carries a document, opened for writing. */
  onResume: (documentId: string) => void;
  /** R-7.8 — a pull request checked out for reading, with git's own worktree path. */
  onReview: (pull: PullRequestSummary, worktree: MountedWorktree) => void;
};

/**
 * The same sentence the sidebar item is labelled with, deliberately.
 *
 * A drawer titled differently from the control that opened it reads as a second place,
 * and the reviewer has to check they landed where they meant to. One name, said twice.
 */
const PANEL_LABEL = 'Collaborate on pull requests';

export function CollabDrawer({ onClose, onResume, onReview }: CollabDrawerProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement | null>(null);

  /*
   * The focus contract that stands in for Escape.
   *
   * `aria-modal` tells a screen reader the rest of the page is inert but does not make it
   * so for the keyboard, and with no Escape a user who tabbed past the last control would
   * be behind an opaque scrim with no way back. So Tab wraps at both ends, and the element
   * that had focus when the drawer opened gets it back when the drawer goes.
   */
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return; // Escape deliberately does nothing here.
      const root = panel.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      restore?.focus?.();
    };
  }, []);

  return (
    <div
      style={scrim}
      /*
       * The scrim absorbs the click instead of forwarding it to the file tree underneath.
       * It is not a dismissal — see the header note — but it must not be a pass-through
       * either, or the user would be picking files through an opaque overlay.
       */
      onMouseDown={(e) => e.stopPropagation()}
      data-vs-collab-drawer-scrim
    >
      <style>{ANIM}</style>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={PANEL_LABEL}
        data-vs-collab-drawer
        style={panelStyle}
        className="vs-collab-drawer"
      >
        <header style={head}>
          <span style={title}>{PANEL_LABEL}</span>
          <button
            ref={closeBtn}
            type="button"
            onClick={onClose}
            // The dialog carries the name; repeating it here would only make the one
            // control on the panel's chrome announce a paragraph.
            aria-label="Close"
            title="Close"
            className="vs-focus-ring vs-collab-drawer-close"
            style={closeButton}
          >
            <CloseIcon />
          </button>
        </header>
        <div style={body}>
          {/*
            * Same two entries, same order and same reasoning as the full-surface landing
            * page had: the list is the primary path because the server already resolved a
            * `documentId` for every row that has one (R-7.4), and the URL form below is the
            * fallback for a pull request this repository does not list.
            */}
          <CollabPullsPanel onReview={onReview} onResume={onResume} />
          <hr style={rule} />
          <CollabOpenPanel onOpened={onResume} />
        </div>
      </div>
    </div>
  );
}

/** Stroked ✕ at the same weight as the sidebar's icons, so the chrome reads as one set. */
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block' }} aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';

/*
 * Enter from the right edge it is docked to, in one of the platform's shorter durations —
 * this is a panel appearing, not a scene change. `prefers-reduced-motion` gets the panel
 * with none of the travel, which is the state the animation ends in anyway.
 */
const ANIM =
  '@keyframes vs-drawer-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}' +
  '.vs-collab-drawer{animation:vs-drawer-in 220ms cubic-bezier(0.16,1,0.3,1)}' +
  '@media (prefers-reduced-motion: reduce){.vs-collab-drawer{animation:none}}' +
  // The only control on the panel's chrome, so it says so on hover rather than staying flat.
  '.vs-collab-drawer-close:hover{background:#f1f5f9;border-color:#e2e8f0;color:#0f172a}';

const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  justifyContent: 'flex-end',
  // Above the header's tooltips and the unsaved-changes dialogs, which sit at 50.
  zIndex: 60,
};

const panelStyle: React.CSSProperties = {
  width: 'min(480px, 100vw)',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: '#f8fafc',
  borderLeft: '1px solid #e5e7eb',
  boxShadow: '-16px 0 40px rgba(15,23,42,0.18)',
};

const head: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 12px 12px 16px',
  borderBottom: '1px solid #e5e7eb',
  background: 'linear-gradient(180deg, #ffffff 0%, #fbfaff 100%)',
  flexShrink: 0,
};

const title: React.CSSProperties = { flex: 1, font: '700 14px system-ui, sans-serif', color: '#334155' };

/** 36px of target around a 16px glyph — the drawer's only way out deserves the room. */
const closeButton: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 36,
  height: 36,
  flexShrink: 0,
  border: '1px solid transparent',
  borderRadius: 8,
  background: 'transparent',
  color: '#475569',
  cursor: 'pointer',
};

const body: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0 24px' };

const rule: React.CSSProperties = { border: 0, borderTop: '1px solid #e5e7eb', margin: '4px 12px' };
