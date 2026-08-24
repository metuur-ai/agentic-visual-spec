/**
 * review-view.tsx — read the proposal, refine it, then explicitly approve.
 *
 * THE PATCH IS THE DECISION, SO THE PATCH IS THE PAGE. Everything else in the envelope —
 * interpretation, strategy, reasoning, assumptions, ambiguities, alternatives, impact
 * (R-4.1–R-4.6) — is context for a judgement whose *subject* is the diff, and
 * `POST /approve` runs `git apply` on those exact bytes and nothing else (R-6.2). So the
 * diff opens the body at full width, and the model's prose sits under it in a smaller,
 * quieter block. Put the prose first and the reader arrives at the diff already
 * persuaded, which is the failure this whole flow exists to prevent.
 *
 * APPROVAL IS TWO ACTS, NOT ONE. "Approve" arms a confirmation and the second press
 * writes — the same shape the panel already uses for deleting a comment, for the same
 * reason: this is the one control in the view that changes a file (R-6.1). It is never
 * the default focus and never fires on Enter.
 *
 * A DRAWER, NOT A PANE. The comment sidebar is ~320px and a diff is not readable in it.
 * The drawer idiom is `collab-drawer.tsx`'s, deliberately: a detour that keeps the work
 * behind it on screen. It is lighter than that one — closing the view is safe here,
 * because the session lives on the server and the panel keeps the stream open, so ✕ and
 * Escape put the view away while Cancel is the control that ends the session.
 */
import { useEffect, useRef, useState } from 'react';

import { PatchView } from './patch-view';
import type { Proposal, ReviewEndReason, ReviewSession } from './review-session';
import { Spinner } from './spinner';
import { Z } from '../core/app/lib/z-layers';

/** What the session is doing, in the reader's words. */
function phaseLabel(session: ReviewSession): string {
  const { phase, proposal } = session.state;
  if (phase === 'ended') return 'Session ended';
  if (phase === 'awaiting-input') return 'Waiting for you';
  if (phase === 'proposing') return proposal ? 'Revising the proposal…' : 'Working out a proposal…';
  return 'Not started';
}

/**
 * How a session ended, said in terms of what it means for the file.
 *
 * `idle` is the one that has to be told apart from a crash: nobody asked for it — the
 * server reaps an abandoned session after 15 minutes (R-7.6) — so reporting it as a
 * failure would have the user hunting for a fault that is not there.
 */
const ENDINGS: Record<ReviewEndReason, { tone: 'ok' | 'warn' | 'bad'; text: string }> = {
  applied: { tone: 'ok', text: 'Approved and applied. The patch above is what landed.' },
  cancelled: { tone: 'warn', text: 'Cancelled. Nothing was written and the comment is still open.' },
  idle: { tone: 'warn', text: 'Ended after being left idle — nothing was written. Start the review again when you are ready.' },
  // R-7.9 — its own sentence, because "idle" would tell a user who was mid-conversation
  // something untrue and "failed" would tell them something worse.
  expired: { tone: 'warn', text: 'Ended at its time limit — nothing was written. Start the review again to carry on.' },
  exit: { tone: 'bad', text: 'The review process exited before you approved. Nothing was written.' },
  error: { tone: 'bad', text: 'The review process failed. Nothing was written.' },
};

export function ReviewDrawer({ session, label }: { session: ReviewSession; label?: string }) {
  const { state } = session;
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const ended = state.phase === 'ended';
  const waiting = state.phase === 'awaiting-input';
  const hasProposal = state.proposal !== null;

  // A fresh proposal supersedes whatever was being confirmed; re-approval (R-6.3) has to
  // be a new decision about the new diff rather than a click that was already halfway in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision counter IS the trigger
  useEffect(() => setConfirming(false), [state.revision, state.drift]);

  // Escape puts the view away. It does not cancel — the session outlives the drawer, and
  // a stray key must not kill a running review.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') session.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const submit = () => {
    const t = text.trim();
    if (!t || session.busy || ended) return;
    setText('');
    void session.send(t);
  };

  return (
    <div style={scrim} data-vs-review-scrim onMouseDown={(e) => e.stopPropagation()}>
      <div role="dialog" aria-modal="true" aria-label="Review this comment" data-vs-review style={panel}>
        <header style={head}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {state.phase === 'proposing' ? <Spinner size={12} /> : <Dot ended={ended} waiting={waiting} />}
            <strong style={{ fontSize: 13 }}>{phaseLabel(session)}</strong>
            {label && <span style={headSub}>{label}</span>}
          </span>
          <button ref={closeRef} type="button" onClick={session.close} style={iconBtn} title="Close this view (the session keeps running)" aria-label="Close">
            ✕
          </button>
        </header>

        <div ref={bodyRef} style={body}>
          {session.problem && (
            <p style={{ ...banner, ...bannerBad }} data-vs-review-problem>
              {session.problem.message}
            </p>
          )}

          {/* R-6.3 — drift is not a generic failure. It says: the file moved, decide again. */}
          {state.drift && (
            <p style={{ ...banner, ...bannerWarn }} data-vs-review-drift>
              <strong>Re-approval needed.</strong> {state.drift} Nothing was written. Ask for an updated
              proposal below, then approve that one.
            </p>
          )}

          {state.applied && (
            <p style={{ ...banner, ...bannerOk }} data-vs-review-applied>
              <strong>Applied to {state.applied.path}.</strong> {state.applied.result}
            </p>
          )}

          {ended && state.ended && !state.applied && (
            <p style={{ ...banner, ...toneStyle(ENDINGS[state.ended.reason].tone) }} data-vs-review-ended={state.ended.reason}>
              {ENDINGS[state.ended.reason].text}
            </p>
          )}

          {state.proposal ? (
            <>
              <PatchView patch={state.proposal.patch} />
              <ProposalContext proposal={state.proposal} revision={state.revision} />
            </>
          ) : (
            <div style={waitingBox} data-vs-review-waiting>
              {ended ? 'No proposal was produced.' : 'Reading the comment and its target…'}
            </div>
          )}

          {state.rows.length > 0 && <Activity rows={state.rows} />}
        </div>

        <footer style={foot}>
          {/* R-5.1/R-5.3 — the refinement channel. Present from the first turn: asking a
              question before the proposal lands is a legitimate use of the session. */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
            }}
            disabled={ended}
            placeholder={ended ? 'The session has ended.' : 'Ask a question or redirect the change (⌘/Ctrl+Enter)…'}
            rows={2}
            style={input}
            data-vs-review-input
          />
          <div style={footRow}>
            {/* R-5.4 — the waiting state comes from the server's `awaiting-input` frame,
                not from a guess about whether the last POST has landed. */}
            <span style={hintText}>
              {waiting ? 'Waiting for your next message.' : state.phase === 'proposing' ? 'Working…' : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={submit} disabled={!text.trim() || ended || session.busy !== null} style={plainBtn} data-vs-review-send>
              Send
            </button>
            {!ended && (
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  void session.cancel();
                }}
                disabled={session.busy !== null}
                style={cancelBtn}
                title="Kill the session. Nothing is written."
                data-vs-review-cancel
              >
                Cancel session
              </button>
            )}
            {!ended &&
              (confirming ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, color: '#475569' }}>Apply this patch?</span>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                      void session.approve();
                    }}
                    disabled={session.busy !== null}
                    style={approveBtn}
                    data-vs-review-approve-confirm
                  >
                    Yes, apply
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} style={plainBtn}>
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!hasProposal || session.busy !== null}
                  style={{ ...approveBtn, opacity: hasProposal ? 1 : 0.5 }}
                  title={hasProposal ? 'Write the patch above to disk' : 'Nothing to approve yet'}
                  data-vs-review-approve
                >
                  Approve
                </button>
              ))}
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * R-4.1–R-4.4 / R-4.6 — the model's account of itself, under the diff and quieter than it.
 *
 * Empty lists render nothing rather than an empty heading: "Assumptions" over a blank
 * space reads as a missing answer, and `[]` here means the model genuinely had none —
 * `alternatives` in particular is specified as faithful surfacing, so an empty one is a
 * statement that it saw a single reasonable approach.
 */
function ProposalContext({ proposal, revision }: { proposal: Proposal; revision: number }) {
  return (
    <section style={context} data-vs-review-context>
      <div style={contextHead}>
        Why this change{revision > 1 ? ` · revision ${revision}` : ''}
      </div>
      <Field label="Interpretation">{proposal.interpretation}</Field>
      <Field label="Strategy">{proposal.strategy}</Field>
      <Field label="Reasoning">{proposal.reasoning}</Field>
      <Field label="Impact">{proposal.impact}</Field>
      <Bullets label="Assumptions" items={proposal.assumptions} />
      <Bullets label="Ambiguities" items={proposal.ambiguities} />
      {proposal.alternatives.length > 0 && (
        <div style={fieldBlock}>
          <div style={fieldLabel}>Alternatives considered</div>
          <ul style={list}>
            {proposal.alternatives.map((a) => (
              <li key={a.summary} style={{ marginBottom: 4 }}>
                {a.summary}
                <span style={{ color: '#94a3b8' }}> — {a.tradeoff}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: string }) {
  if (!children) return null;
  return (
    <div style={fieldBlock}>
      <div style={fieldLabel}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Bullets({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={fieldBlock}>
      <div style={fieldLabel}>{label}</div>
      <ul style={list}>
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/** The turn-by-turn log: what you said, what the tools did, what went wrong. */
function Activity({ rows }: { rows: { kind: 'user' | 'note' | 'error'; text: string }[] }) {
  return (
    <section style={context} data-vs-review-activity>
      <div style={contextHead}>Session log</div>
      <ul style={{ ...list, listStyle: 'none', paddingLeft: 0 }}>
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only feed
          <li key={i} style={{ color: r.kind === 'error' ? '#b91c1c' : r.kind === 'user' ? '#0f172a' : '#64748b' }}>
            <span style={{ color: '#cbd5e1' }}>{r.kind === 'user' ? '›' : r.kind === 'error' ? '!' : '·'} </span>
            {r.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dot({ ended, waiting }: { ended: boolean; waiting: boolean }) {
  const color = ended ? '#94a3b8' : waiting ? '#f59e0b' : '#2563eb';
  return <span style={{ width: 8, height: 8, borderRadius: 99, background: color, display: 'inline-block', flexShrink: 0 }} aria-hidden />;
}

function toneStyle(tone: 'ok' | 'warn' | 'bad'): React.CSSProperties {
  return tone === 'ok' ? bannerOk : tone === 'warn' ? bannerWarn : bannerBad;
}

const scrim: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  justifyContent: 'flex-end',
  zIndex: Z.CHROME,
};
const panel: React.CSSProperties = {
  width: 'min(780px, 100vw)',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: '#f8fafc',
  borderLeft: '1px solid #e5e7eb',
  boxShadow: '-16px 0 40px rgba(15,23,42,0.18)',
  font: '13px system-ui',
};
const head: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 12px',
  borderBottom: '1px solid #e5e7eb',
  background: 'white',
};
const headSub: React.CSSProperties = { color: '#64748b', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const body: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'grid', gap: 12, alignContent: 'start' };
const foot: React.CSSProperties = { borderTop: '1px solid #e5e7eb', background: 'white', padding: 10, display: 'grid', gap: 8 };
const footRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', font: 'inherit', padding: 6, border: '1px solid #cbd5e1', borderRadius: 6, resize: 'vertical' };
const hintText: React.CSSProperties = { fontSize: 12, color: '#64748b' };
const btnBase: React.CSSProperties = { padding: '5px 12px', borderRadius: 6, cursor: 'pointer', font: '600 12px system-ui', flexShrink: 0 };
const plainBtn: React.CSSProperties = { ...btnBase, border: '1px solid #d1d5db', background: 'white', color: '#334155' };
const cancelBtn: React.CSSProperties = { ...btnBase, border: '1px solid #fecaca', background: 'white', color: '#b91c1c' };
const approveBtn: React.CSSProperties = { ...btnBase, border: '1px solid #15803d', background: '#15803d', color: 'white' };
const iconBtn: React.CSSProperties = { ...btnBase, border: '1px solid transparent', background: 'transparent', color: '#64748b' };
const banner: React.CSSProperties = { margin: 0, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5, border: '1px solid' };
const bannerOk: React.CSSProperties = { borderColor: '#bbf7d0', background: '#f0fdf4', color: '#166534' };
const bannerWarn: React.CSSProperties = { borderColor: '#fde68a', background: '#fffbeb', color: '#92400e' };
const bannerBad: React.CSSProperties = { borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c' };
const waitingBox: React.CSSProperties = { padding: '18px 12px', border: '1px dashed #cbd5e1', borderRadius: 8, color: '#64748b', textAlign: 'center', background: 'white' };
const context: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 8, background: 'white', padding: '8px 10px', fontSize: 12.5, lineHeight: 1.55, color: '#334155' };
const contextHead: React.CSSProperties = { font: '700 12px system-ui', color: '#0f172a', marginBottom: 6 };
const fieldBlock: React.CSSProperties = { marginBottom: 6 };
const fieldLabel: React.CSSProperties = { font: '600 11px system-ui', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 };
const list: React.CSSProperties = { margin: '2px 0 0', paddingLeft: 16 };
