/**
 * spinner.tsx — the one busy indicator, for every control that waits on a request.
 *
 * WHY IT EXISTS. Nearly every asynchronous control in this app already had a busy state,
 * and nearly none of it was visible: the button disabled itself and its label changed a
 * word, which on a 12px control reads as nothing happening at all. A reviewer who pressed
 * `Send` and saw no motion pressed it again. The state was there; the *signal* was not.
 *
 * A MOVING THING, NOT A CHANGED WORD. Motion is what the eye catches without being
 * pointed at it, and it is the one channel a disabled-and-relabelled button does not use.
 * The word still changes where there is room for it — "Sending…" says what is happening,
 * which a ring cannot — but the ring is what says that *something* is.
 *
 * IT INHERITS ITS COLOUR (`currentColor`), so one component works on the white buttons,
 * the blue primary ones and the red destructive ones without a variant per palette.
 *
 * REDUCED MOTION GETS A PULSE, NOT NOTHING. The alternative to spinning is not stillness —
 * a static ring beside a disabled button is indistinguishable from an icon — so the
 * opacity breathes instead. It still says "waiting" without anything travelling.
 */

import { useLayoutEffect } from 'react';

const CSS =
  '@keyframes vs-spin{to{transform:rotate(360deg)}}' +
  '@keyframes vs-spin-pulse{0%,100%{opacity:1}50%{opacity:0.3}}' +
  '.vs-spinner{animation:vs-spin 700ms linear infinite;transform-origin:50% 50%}' +
  '@media (prefers-reduced-motion: reduce){.vs-spinner{animation:vs-spin-pulse 1200ms ease-in-out infinite}}';

/**
 * `role="status"` rather than nothing: the control it sits in is disabled while it spins,
 * so a screen reader gets no other announcement that the press was received.
 */
const STYLE_ID = 'vs-spinner-css';

/**
 * The rules go in `<head>`, once, rather than in a `<style>` beside each ring.
 *
 * The elements this sits inside are buttons, and a `<style>` child is part of their
 * `textContent` — so every spinning button was carrying a keyframes declaration in its
 * text, which anything reading a label out of the DOM would have to strip. Browsers skip
 * `display:none` subtrees when computing an accessible name, so it was never *read*
 * aloud; it was still the wrong place to put it.
 */
function useSpinnerCss(): void {
  useLayoutEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
    // Deliberately never removed: the next spinner would only put it straight back, and
    // the rules are inert while nothing carries the class.
  }, []);
}

export function Spinner({ size = 12, label = 'Working…' }: { size?: number; label?: string }) {
  useSpinnerCss();
  return (
    <>
      <svg
        className="vs-spinner"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        role="status"
        aria-label={label}
        data-vs-spinner
        style={{ display: 'block', flexShrink: 0 }}
      >
        {/* The track, so the moving arc reads as a ring rather than a stray mark. */}
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </>
  );
}

/**
 * A button's contents while it may be busy: the ring, then the label.
 *
 * The label is the caller's to change — "Send" becomes "Sending…" — because only the
 * caller knows the verb. What this centralises is the layout, so a spinner never shifts
 * the text it sits beside and every busy control in the product lines up the same way.
 */
export function BusyLabel({ busy, children, size = 12 }: { busy: boolean; children: React.ReactNode; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
      {busy && <Spinner size={size} />}
      {children}
    </span>
  );
}

/**
 * The placeholder a surface shows while a read is in flight.
 *
 * The bare word "Loading…" is indistinguishable from a label that was left there, which is
 * exactly the complaint the spinner exists to answer: on a slow route the screen looked
 * static and finished. This pairs the word with the one thing that says it is still going.
 */
export function LoadingLine({ children = 'Loading…', style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ display: 'flex', alignItems: 'center', gap: 7, opacity: 0.65, margin: 0, ...style }}>
      <Spinner size={13} />
      {children}
    </p>
  );
}
