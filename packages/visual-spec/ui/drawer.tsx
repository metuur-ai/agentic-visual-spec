/**
 * drawer.tsx — the right-side modal panel, as a shell two panels now share.
 *
 * WHY THIS EXISTS. `collab-drawer.tsx` had the scrim, the entry animation and — the part
 * that matters — a focus trap standing in for a missing Escape key. The before/after
 * comparison wants the same panel, and a second hand-rolled focus trap is the kind of
 * thing that is correct on the day it is written and silently rots afterwards. One trap,
 * two callers.
 *
 * DISMISSAL IS A POLICY, NOT A DEFAULT. The two panels genuinely disagree, so the
 * disagreement is a prop rather than a fork of the file:
 *
 *   - The collaboration picker runs git on click — a checkout, a `POST /__vs/collab/open`.
 *     A stray Escape or a click on the scrim mid-request would tear the surface down
 *     around a call in flight, so `dismissible: false` leaves the ✕ as the only way out
 *     and the focus trap pays for the missing keyboard route.
 *   - The comparison is read-only. Nothing is in flight, the reader is glancing at what a
 *     line used to say, and trapping them behind an opaque scrim with no Escape would be
 *     rudeness with no purchase behind it. `dismissible: true`.
 *
 * The trap runs either way: with `dismissible` the Tab wrap is a convenience, without it
 * the wrap is the contract.
 */
import { useEffect, useRef } from 'react';

import { Z } from '../core/app/lib/z-layers';

export type DrawerProps = {
  /**
   * Names the dialog, and is shown as its title.
   *
   * Deliberately one string for both: a drawer titled differently from the control that
   * opened it reads as a second place, and the reader has to check they landed where they
   * meant to.
   */
  label: string;
  /** Whether Escape and a click on the scrim dismiss — see the header note. */
  dismissible: boolean;
  /** CSS width for the panel. Callers size to their content, not to a house default. */
  width: string;
  /** Kebab slug behind `data-vs-{slug}` and the animation class. */
  slug: string;
  onClose: () => void;
  children: React.ReactNode;
};

export function Drawer({ label, dismissible, width, slug, onClose, children }: DrawerProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement | null>(null);
  /*
   * Read by the keydown handler, which is bound once. Without this the listener would
   * close over the first `onClose` it saw and keep calling a stale one after a re-render.
   */
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (dismissible && e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
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
  }, [dismissible]);

  return (
    <div
      style={scrim}
      /*
       * Either a dismissal or an absorbed click, but never a pass-through: the surface
       * below is a file tree, and picking files through an opaque overlay is not a thing
       * the reader can have meant.
       */
      onMouseDown={(e) => {
        e.stopPropagation();
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      {...{ [`data-vs-${slug}-scrim`]: '' }}
    >
      <style>{anim(slug)}</style>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        {...{ [`data-vs-${slug}`]: '' }}
        style={{ ...panelStyle, width }}
        className={`vs-drawer vs-${slug}`}
      >
        <header style={head}>
          <span style={title}>{label}</span>
          <button
            ref={closeBtn}
            type="button"
            onClick={onClose}
            // The dialog carries the name; repeating it here would only make the one
            // control on the panel's chrome announce a paragraph.
            aria-label="Close"
            title="Close"
            className="vs-focus-ring vs-drawer-close"
            style={closeButton}
          >
            <CloseIcon />
          </button>
        </header>
        <div style={body}>{children}</div>
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
const anim = (slug: string) =>
  '@keyframes vs-drawer-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}' +
  `.vs-${slug}{animation:vs-drawer-in 220ms cubic-bezier(0.16,1,0.3,1)}` +
  `@media (prefers-reduced-motion: reduce){.vs-${slug}{animation:none}}` +
  // The only control on the panel's chrome, so it says so on hover rather than staying flat.
  '.vs-drawer-close:hover{background:#f1f5f9;border-color:#e2e8f0;color:#0f172a}';

const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  justifyContent: 'flex-end',
  // Peer of the header: the scrim covers it, and DOM order settles the tie.
  zIndex: Z.CHROME,
};

const panelStyle: React.CSSProperties = {
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

const body: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' };
