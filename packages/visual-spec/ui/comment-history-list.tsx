import { useState } from 'react';
import type { CommentRecord } from '../core/editing/comment-doc';
import { anchorLabelOf, historyFor } from '../core/editing/comment-doc';
import { resolveMarkdownAnchors } from './anchor-resolver';

/** Flash a set of blocks (scrolls the first into view), restoring their inline styles after. */
export function flash(els: HTMLElement[]) {
  if (!els.length) return;
  els[0]!.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = els.map((el) => el.style.cssText);
  for (const el of els) {
    el.style.transition = 'background-color 0.2s, box-shadow 0.2s';
    el.style.backgroundColor = 'rgba(59,130,246,0.18)';
    el.style.boxShadow = '0 0 0 4px rgba(59,130,246,0.18)';
    el.style.borderRadius = '4px';
  }
  window.setTimeout(() => {
    for (const el of els) {
      el.style.backgroundColor = '';
      el.style.boxShadow = '';
    }
    window.setTimeout(() => { els.forEach((el, i) => { el.style.cssText = prev[i]!; }); }, 250);
  }, 1400);
}

/**
 * Scroll the markdown surface to the block(s) a comment was anchored to and flash them.
 * Shared by CommentPanel and CommentHistoryList.
 */
export function locate(target: { heading?: string | null; startLine?: number; endLine?: number }) {
  flash(resolveMarkdownAnchors(target));
}

const EMPTY_STATE = 'No applied comments yet.';

/**
 * `restore` is collaboration's, and optional for the same reason `reply` is on the panel
 * source: resolving there posts a marker reply and markers accumulate (R-5.14), so
 * reopening is an ordinary act with a route behind it. Local mode's remove deletes the
 * sidecar record outright — there is nothing to restore — so it passes nothing and this
 * list stays read-only. Confirm-then-act mirrors Resolve in the open list, because both
 * write a comment to the pull request that every participant sees.
 */
export function CommentHistoryList({
  path,
  comments,
  restore,
}: { path: string; comments: CommentRecord[]; restore?: (id: string) => Promise<void> }) {
  const entries = historyFor(comments, path);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!entries.length) {
    return <p style={emptyState}>{EMPTY_STATE}</p>;
  }
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>{entries.length} applied on this file</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        {entries.map((c) => (
          <li key={c.id} style={card}>
            <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {anchorLabelOf(c)}
            </div>
            <div style={{ margin: '2px 0' }}>{c.comment}</div>
            <div style={{ fontSize: 12, color: '#475569', marginTop: 4, fontStyle: 'italic' }}>
              {c.result || '—'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => locate(c.target)}
                title="Show where this comment was added in the file"
                aria-label="Show in file"
                style={locateBtn}
              >
                <LocateIcon />
              </button>
              {restore &&
                (confirmId === c.id ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: '#475569' }}>Unresolve?</span>
                    <button
                      type="button"
                      data-vs-unresolve-confirm={c.id}
                      onClick={() => { void restore(c.id); setConfirmId(null); }}
                      style={confirmYes}
                    >
                      Yes
                    </button>
                    <button type="button" onClick={() => setConfirmId(null)} style={confirmNo}>No</button>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-vs-unresolve={c.id}
                    onClick={() => setConfirmId(c.id)}
                    title="Reopen this comment — posts a reply on the pull request"
                    aria-label="Unresolve comment"
                    style={textBtn}
                  >
                    Unresolve
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LocateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="7" />
      <line x1="12" y1="1" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="23" />
      <line x1="1" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="23" y2="12" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const emptyState: React.CSSProperties = { padding: 12, opacity: 0.6, fontSize: 13, fontStyle: 'italic' };
const card: React.CSSProperties = { border: '1px solid #f1f5f9', borderRadius: 8, padding: 8, overflowWrap: 'anywhere' };
const locateBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer' };

/*
 * Local rather than imported from `comment-panel.tsx`: that module imports this one, so
 * reaching back would close a cycle. Deliberately not the panel's red confirm either —
 * that red says "destructive", and reopening a thread destroys nothing. It posts a reply
 * the other participants will see, which is worth a confirm, not a warning.
 */
const confirmYes: React.CSSProperties = {
  padding: '2px 8px',
  border: '1px solid #2563eb',
  borderRadius: 4,
  background: '#eff6ff',
  color: '#1d4ed8',
  font: '12px system-ui',
  cursor: 'pointer',
};
const confirmNo: React.CSSProperties = {
  padding: '2px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  background: 'white',
  color: '#475569',
  font: '12px system-ui',
  cursor: 'pointer',
};
/** Same reason as the panel's: a worded button cannot live in a 22×22 icon square. */
const textBtn: React.CSSProperties = { ...locateBtn, width: 'auto', height: 22, padding: '0 6px', whiteSpace: 'nowrap', font: '12px system-ui' };
