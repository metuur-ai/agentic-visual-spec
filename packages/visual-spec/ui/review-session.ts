/**
 * review-session.ts — the browser half of the interactive review session.
 *
 * The server (`core/vite/routes/review.ts`) holds exactly one session, process-wide, and
 * every tab watches the same stream. This module is the client of that: a reducer over
 * the streamed frames and a hook that owns the `EventSource`, the four POSTs, and the
 * reconnect probe.
 *
 * WHY THE SUBSCRIPTION IS ALWAYS ON, LIKE `ApplyButton`'s. Activity is shared, not
 * per-view: a session started in one tab is visible in the next, and a view that only
 * subscribed while it was open would make a running session look absent to a tab that
 * had not opened it yet. It also matters for R-7.6 — the server arms the abandonment
 * timer when the last *subscriber* leaves, so subscribing from the panel rather than
 * from the drawer means closing the drawer does not start reaping the session.
 *
 * WHY A STATUS PROBE AS WELL AS `sync` (R-8.9). The `sync` frame answers "is a session
 * running" only to a client that has already subscribed, which is one round trip too
 * late to decide whether to *show* the view on load. `GET /__vs/review` answers it
 * before the stream opens, so a reloaded tab comes back to its in-flight review instead
 * of appearing to have none.
 *
 * WHY FRAMES ARE DISPATCHED SYNCHRONOUSLY. `ApplyButton` coalesces its stream into one
 * `requestAnimationFrame` because a whole-workspace apply run emits hundreds of tool
 * rows. A review session is one comment and a handful of turns; the batching machinery
 * would cost more to read than the renders it saves.
 *
 * TYPES COME FROM THE SERVER MODULE AS `import type` ONLY. `review.ts` imports
 * `node:child_process`; a value import here would drag a Node builtin into the browser
 * bundle and `ui/browser-safety.test.ts` would (correctly) fail. Type-only edges are
 * erased, which is why that guard follows value imports alone.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { Proposal } from '../core/editing/review-prompt';
import type { ReviewEndReason, ReviewEvent, ReviewPhase, ReviewSync } from '../core/vite/routes/review';

export type { Proposal, ReviewEndReason, ReviewPhase };

/** Everything the stream can deliver: the opening snapshot, then live frames. */
export type ReviewFrame = ReviewSync | ReviewEvent;

/** One line in the activity log beside the proposal. */
export type ReviewRow = { kind: 'user' | 'note' | 'error'; text: string };

export type ReviewState = {
  phase: ReviewPhase;
  commentId: string | null;
  startedAt: number | null;
  /**
   * The latest proposal, and only the latest: the server keeps one slot and each turn
   * overwrites it, so "the proposal at approval time" is a property of the storage on
   * both sides rather than a choice this reducer makes.
   */
  proposal: Proposal | null;
  /** How many proposals have arrived — lets the view say "revised" rather than "new". */
  revision: number;
  rows: ReviewRow[];
  /** R-6.3 — set by a `drift` frame, cleared by the proposal that supersedes it. */
  drift: string | null;
  applied: { commentId: string; path: string; result: string } | null;
  ended: { ok: boolean; reason: ReviewEndReason } | null;
};

export const REVIEW_INIT: ReviewState = {
  phase: 'idle',
  commentId: null,
  startedAt: null,
  proposal: null,
  revision: 0,
  rows: [],
  drift: null,
  applied: null,
  ended: null,
};

const ROW_CAP = 200;
const addRow = (s: ReviewState, row: ReviewRow): ReviewState => ({ ...s, rows: [...s.rows.slice(-ROW_CAP), row] });

/** `Read package.json` / `Editing…` — the same shape `ApplyButton` gives its feed. */
function logText(e: Extract<ReviewEvent, { type: 'log' }>): string {
  if (e.tool) return e.target ? `${e.tool} ${e.target}` : e.tool;
  return e.text ?? '';
}

export function reviewReduce(s: ReviewState, e: ReviewFrame): ReviewState {
  switch (e.type) {
    case 'sync': {
      // Rebuild from the snapshot, so an `EventSource` reconnect is idempotent rather
      // than additive. The snapshot's own `phase` wins over anything the replay implied.
      let st: ReviewState = { ...REVIEW_INIT, commentId: e.commentId, startedAt: e.startedAt };
      for (const ev of e.events) st = reviewReduce(st, ev);
      return { ...st, phase: e.phase, commentId: e.commentId ?? st.commentId, startedAt: e.startedAt ?? st.startedAt };
    }
    case 'review-start':
      return { ...REVIEW_INIT, phase: 'proposing', commentId: e.commentId, startedAt: e.startedAt };
    case 'user-turn':
      return addRow({ ...s, phase: 'proposing' }, { kind: 'user', text: e.text });
    case 'proposal':
      // A fresh proposal is what re-approval after drift is approving, so it is also
      // what clears the drift banner (R-6.3). Nothing else does.
      return { ...s, proposal: e.proposal, revision: s.revision + 1, drift: null };
    case 'awaiting-input':
      return { ...s, phase: 'awaiting-input' };
    case 'drift':
      return { ...s, drift: e.message };
    case 'applied':
      return { ...s, applied: { commentId: e.commentId, path: e.path, result: e.result }, drift: null };
    case 'ended':
      return { ...s, phase: 'ended', ended: { ok: e.ok, reason: e.reason } };
    case 'log': {
      const text = logText(e);
      return text ? addRow(s, { kind: 'note', text }) : s;
    }
    case 'error':
      return addRow(s, { kind: 'error', text: e.message });
    default:
      // `agent-start` / `agent-done` — sub-agent bookkeeping the review view does not show.
      return s;
  }
}

/** A refusal from one of the POSTs, already turned into a sentence for the user. */
export type ReviewProblem = { code?: string; message: string };

/**
 * The server's refusal codes, said in the second person.
 *
 * `drift` is deliberately absent: the `drift` frame arrives over the stream and the view
 * renders it as a re-approval banner, so mapping the 409 as well would put the same fact
 * on screen twice, once as a state and once as an error.
 */
function refusal(status: number, body: { error?: string; code?: string; holder?: string }): ReviewProblem {
  if (body.holder === 'apply') return { code: 'locked', message: 'A bulk apply is running. Wait for it to finish, then start the review again.' };
  if (body.holder === 'review') return { code: 'locked', message: 'A review is already running. Only one session runs at a time.' };
  switch (body.code) {
    case 'no-proposal':
      return { code: body.code, message: 'There is no proposal to approve yet.' };
    case 'approving':
      return { code: body.code, message: 'An approval is already in flight.' };
    // R-7.7 — the child died, which is not the same as never having had a session.
    case 'session-ended':
      return { code: body.code, message: 'The review process stopped. Nothing was written; start the review again.' };
    case 'no-session':
      return { code: body.code, message: 'No review session is running.' };
    default:
      return { code: body.code, message: body.error ?? `The server refused the request (${status}).` };
  }
}

async function post(path: string, body: Record<string, unknown>): Promise<ReviewProblem | null> {
  let res: Response;
  try {
    res = await fetch(`/__vs/review/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { message: 'Could not reach the visual-spec server.' };
  }
  if (res.ok) return null;
  const parsed = await res.json().catch(() => ({}));
  return refusal(res.status, parsed as { error?: string; code?: string; holder?: string });
}

export type ReviewSession = {
  state: ReviewState;
  /** Whether the review view is on screen. Independent of whether a session is running. */
  open: boolean;
  /** Which POST is in flight, so the view can disable exactly one control. */
  busy: 'start' | 'message' | 'approve' | 'cancel' | null;
  problem: ReviewProblem | null;
  /**
   * Begin a session on one comment.
   *
   * `extra` is what a collaborative start adds (R-8.8): the document path and the
   * projected record, which exist only in this browser's projection and cannot be
   * resolved from the id. It is an opaque bag rather than a typed second parameter
   * because this module has no business knowing what kinds of session the server runs —
   * the caller that has a collaborative record is the one that knows how to describe it.
   * A local start passes nothing and the body is exactly what it always was.
   */
  start: (commentId: string, extra?: Record<string, unknown>) => Promise<void>;
  send: (text: string) => Promise<void>;
  approve: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Put the view away. Does NOT touch the session — that is what Cancel is for. */
  close: () => void;
};

export function useReviewSession(): ReviewSession {
  const [state, dispatch] = useReducer(reviewReduce, REVIEW_INIT);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ReviewSession['busy']>(null);
  const [problem, setProblem] = useState<ReviewProblem | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // R-8.9 — learn about an in-flight session before subscribing, so a reload comes back
  // to the review it left rather than to an empty panel with a session running behind it.
  useEffect(() => {
    void fetch('/__vs/review')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { running?: boolean } | null) => {
        if (live.current && s?.running) setOpen(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource('/__vs/review/events');
    es.onmessage = (ev) => {
      let frame: ReviewFrame;
      try {
        frame = JSON.parse(ev.data) as ReviewFrame;
      } catch {
        return;
      }
      dispatch(frame);
      /*
       * R-6.5's client half. The server's `applied` frame is the only signal that bytes
       * changed on disk; these two events are what the document view and the sidebar
       * already listen to, so the refresh path is the existing one rather than a new one.
       * Guarded on the live frame only — a `sync` replay of a past `applied` would
       * otherwise re-fire the refresh on every reconnect.
       */
      if (frame.type === 'applied') {
        window.dispatchEvent(new CustomEvent('vs:comments-changed'));
        window.dispatchEvent(new CustomEvent('vs:source-changed'));
      }
    };
    return () => es.close();
  }, []);

  const run = useCallback(async (which: NonNullable<ReviewSession['busy']>, path: string, body: Record<string, unknown>) => {
    setBusy(which);
    setProblem(null);
    const failed = await post(path, body);
    if (!live.current) return;
    setBusy(null);
    if (failed) setProblem(failed);
  }, []);

  const start = useCallback(
    async (commentId: string, extra?: Record<string, unknown>) => {
      setOpen(true);
      // Clear the previous session's proposal *before* the request, not when
      // `review-start` comes back: between the click and the first frame the drawer is
      // on screen, and the last session's diff sitting in it reads as this comment's.
      dispatch({ type: 'sync', running: false, phase: 'idle', commentId, startedAt: null, events: [] });
      // `commentId` last, so a caller's bag can never overwrite the one field the server
      // itself reads off the body.
      await run('start', 'start', { ...extra, commentId });
    },
    [run],
  );

  const send = useCallback((text: string) => run('message', 'message', { text }), [run]);
  const approve = useCallback(() => run('approve', 'approve', {}), [run]);
  const cancel = useCallback(() => run('cancel', 'cancel', {}), [run]);
  const close = useCallback(() => setOpen(false), []);

  return { state, open, busy, problem, start, send, approve, cancel, close };
}
