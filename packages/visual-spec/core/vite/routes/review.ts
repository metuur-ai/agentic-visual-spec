/**
 * routes/review.ts — the interactive review session hub + its HTTP surface.
 *
 * A review session is the *single-comment* counterpart to `routes/apply.ts`: the
 * user asks for one comment to be applied, gets a proposal back, refines it over
 * several turns, and only then authorises the write. Nothing here writes to disk.
 *
 *   GET  /__vs/review         → { running, startedAt, commentId } status snapshot
 *   GET  /__vs/review/events  → text/event-stream: a `sync` snapshot, then live frames
 *   POST /__vs/review/start   → begin a session (409 if the shared lock is held)
 *   POST /__vs/review/message → deliver a follow-up turn to the running session
 *   POST /__vs/review/approve → authorise the write
 *   POST /__vs/review/cancel  → SIGKILL the child, discard the session
 *
 * WHY THIS SITS BESIDE `ApplyHub` RATHER THAN REUSING `core/collaboration/job-hub.ts`.
 * `job-hub.ts` says in its own header that it mirrors `createApplyHub`'s discipline but
 * **deliberately not its shape**: it is a registry keyed by document, several jobs
 * running at once, no global "one run at a time". A review session is the opposite —
 * exactly one, process-wide, mutually exclusive with a bulk apply through the shared
 * `RunLock`. Reusing the registry would mean building the single-slot rule on top of a
 * container whose whole purpose is to not have one. It also costs more than shape:
 * `job-hub.ts` is keyed by a collaboration document identity, and importing it here would
 * drag that identity onto the local review path, which `local-mode.regression.test.ts`
 * (R-10.5) forbids for this module by name.
 *
 * WHY THE SESSION OPERATIONS ARE AN INTERFACE. A collaborative review differs from a
 * local one in five places — where the comment comes from, how the target is located,
 * what "drifted" means, what the terminal state is, and whether the scoped-apply
 * fallback exists at all. Threading a `mode` string through the route body, the hub and
 * the write path produces `if (mode === 'collab')` at five sites. `ReviewSessionOps`
 * below is that difference, named once; the hub calls it and never asks which arm it
 * holds. Two members, two implementations, no registry — Phase C adds the second one.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { setStatus } from '../../editing/comment-doc';
import {
  buildReviewPrompt,
  type Proposal,
  PROPOSAL_SCHEMA_ARGS,
  proposalFromLine,
  type ReviewPromptOptions,
} from '../../editing/review-prompt';
import { type ApplyEvent, type ClaudeChild, type RouteResult, summarize } from './apply';
import type { CommentDocStore } from './comments';
import { conflictFor, type RunLock, sharedRunLock } from './run-lock';

/** Activity rows `summarize()` can produce. `start`/`done` are apply-shaped and never
 *  reach a review stream, so they are excluded rather than left as unreachable cases. */
export type ReviewLogEvent = Exclude<ApplyEvent, { type: 'start' } | { type: 'done' }>;

/**
 * Why a session ended — the UI messages cancel differently from a crash, and `idle`
 * differently from both: nobody asked for it, so it is neither the user's act nor a
 * failure of the child (R-7.6).
 */
export type ReviewEndReason = 'cancelled' | 'exit' | 'error' | 'idle';

/** A frame pushed to subscribers as it happens. */
export type ReviewEvent =
  | ReviewLogEvent
  | { type: 'review-start'; commentId: string; startedAt: number }
  /** A turn the user sent, echoed back by `--replay-user-messages` (R-8.7). */
  | { type: 'user-turn'; text: string }
  /** The pinned envelope for a turn — interpretation, reasoning, and the applicable patch. */
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'awaiting-input' }
  | { type: 'drift'; message: string }
  | { type: 'ended'; ok: boolean; reason: ReviewEndReason; exitCode?: number | null };

/** Where a session is in its lifecycle. */
export type ReviewPhase = 'idle' | 'proposing' | 'awaiting-input' | 'ended';

/** The first frame a subscriber receives, so a tab joining mid-session catches up (R-3.6). */
export type ReviewSync = {
  type: 'sync';
  running: boolean;
  phase: ReviewPhase;
  commentId: string | null;
  startedAt: number | null;
  events: ReviewEvent[];
};

/* ------------------------------------------------------------------ *
 * The session interface — the local/collab seam (LLD decision (b))
 * ------------------------------------------------------------------ */

/**
 * The comment a session is about, in the shape the hub needs — never the store record.
 *
 * It carries the whole anchor (`heading`, both snippets, both line numbers) rather than
 * just the start, because the prompt locates the target by snippet + heading and a
 * half-carried anchor would silently degrade that ladder to a line number the file may
 * have drifted past.
 */
export type ResolvedComment = {
  id: string;
  comment: string;
  workflow: string;
  path: string;
  kind?: 'file' | 'range' | 'folder';
  startLine?: number;
  endLine?: number;
  snippet?: string;
  endSnippet?: string;
  heading?: string | null;
};

/** The located target plus the state pinned at propose time, which `checkDrift` compares. */
export type LocatedTarget = { path: string; startLine?: number; pin: string | null };

/** Drift is a yes/no with a sentence the UI can show; the reason differs per arm. */
export type DriftCheck = { drifted: false } | { drifted: true; reason: string };

/** What the session records when it completes. */
export type ReviewOutcome = { result: string };

/**
 * The five local-vs-collaborative differences, as one interface. `createLocalSessionOps`
 * is the only implementation today; Phase C adds the collaborative one and the hub does
 * not change.
 */
export interface ReviewSessionOps {
  /** Comment source. Local reads the sidecar; collab is handed the projected record. */
  resolve(commentId: string): Promise<ResolvedComment | null>;
  /** Target resolution. Local is path + snippet/heading; collab is an exact node lookup. */
  locate(comment: ResolvedComment): Promise<LocatedTarget | null>;
  /** Staleness. Local compares the pinned target bytes; collab compares the branch head. */
  checkDrift(located: LocatedTarget): Promise<DriftCheck>;
  /** Terminal state. Local flips the comment to `applied`; collab writes no status at all. */
  finish(comment: ResolvedComment, outcome: ReviewOutcome): Promise<void>;
  /** Whether the scoped re-derive pass exists as a fallback. Local yes, collab no. */
  readonly fallbackAvailable: boolean;
  /**
   * R-3.8 — which arm of the prompt this session runs. The origin of a comment picks the
   * implementation, and the implementation carries its own prompt mode, so the hub never
   * reads a `mode` field and no route body carries one. The plain discriminant survives
   * only inside the prompt, which is where the LLD leaves it.
   */
  readonly promptMode: ReviewPromptOptions;
}

/* ------------------------------------------------------------------ *
 * Local implementation
 * ------------------------------------------------------------------ */

export type ReadTargetFile = (path: string) => Promise<string | null>;

/** An opaque timer handle. Tests hand back whatever their fake scheduler uses. */
export type TimerHandle = unknown;

export interface ReviewDeps {
  /** Directory the session runs in — the project root, where the sidecar lives. */
  cwd: string;
  comments: CommentDocStore;
  /** Override the child for tests; defaults to the real persistent `claude` session. */
  spawnSession?: ReviewSpawn;
  /** Override target reads for tests; defaults to reading from disk under `cwd`. */
  readTargetFile?: ReadTargetFile;
  now?: () => number;
  /**
   * R-7.6 — how long a session may sit with no subscribed client and no input before it
   * is reaped. Same shape as `ApplyDeps.timeoutMs`, and the same 15-minute default: this
   * is the review counterpart of apply's hard SIGKILL ceiling.
   */
  idleTimeoutMs?: number;
  /** Timer injection, for the same reason `now` exists — tests must not sleep. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** The abandonment bound (R-7.6), matching the 15-minute ceiling `apply.ts` already uses. */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

/** `unref` so a pending reap timer never keeps a dev server alive on its own. */
const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
};
const defaultClearTimer = (handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>);

/** A session child. Same shape as the apply child plus the in-channel apply lacks. */
export interface ReviewChild extends ClaudeChild {
  stdin?: NodeJS.WritableStream | null;
}

/** Injected the way `apply.ts` injects `spawnClaude`. */
export type ReviewSpawn = (comment: ResolvedComment, cwd: string) => ReviewChild;

/* ------------------------------------------------------------------ *
 * The transport (R-3.3, R-3.7, R-8.3)
 * ------------------------------------------------------------------ */

/**
 * The CLI invocation a review session runs, spelled out so a test can assert it rather
 * than infer it. Each flag is load-bearing:
 *
 * - `--print` + `--input-format stream-json` + `--output-format stream-json` (R-3.3):
 *   a persistent process reading turns off stdin and emitting frames on stdout. Spike 0.1
 *   confirmed the process survives its first `result` frame and answers a second turn on
 *   the same session id, which is the whole basis for the multi-turn refine phase.
 * - `--replay-user-messages` (R-8.7): the CLI echoes each delivered turn back on stdout,
 *   so the user's own words land in the same ordered stream as the model's — one log,
 *   not a client-side interleave of two sources.
 * - `--permission-mode plan` (R-3.7, R-4.7): the edit gate, enforced at the permission
 *   layer instead of by asking the model nicely. NOTE, from spike 0.1: plan mode is
 *   *workspace*-scoped, not a process-wide no-write — the CLI still writes its own plan
 *   files under `~/.claude/plans/`. The invariant to assert is that the target file and
 *   the served directory are unchanged, never that zero writes happened anywhere.
 * - `--verbose`: `--print` with stream-json output requires it.
 *
 * `ExitPlanMode` is not available in `--print` sessions (spike 0.1), so nothing here
 * depends on the model calling it; approval is a server-side act (B4.1).
 *
 * `--json-schema` is spawned alongside these but lives in `review-prompt.ts` next to the
 * schema it carries — see `PROPOSAL_SCHEMA_ARGS`. It is the envelope's flag, not the
 * transport's, and this list stays the transport.
 */
export const REVIEW_CLI_ARGS: readonly string[] = [
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--replay-user-messages',
  '--permission-mode',
  'plan',
  '--verbose',
];

/**
 * Spawn the persistent session. The one difference from `defaultSpawnClaude` that matters
 * is `stdio[0]`: apply passes `'ignore'` because print mode takes its prompt as an
 * argument and must never block on stdin, whereas a review session's stdin *is* the
 * in-channel every follow-up turn travels down (R-8.3).
 */
export const defaultSpawnReviewSession: ReviewSpawn = (_comment, cwd) =>
  spawn('claude', [...REVIEW_CLI_ARGS, ...PROPOSAL_SCHEMA_ARGS], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/** One turn, in the frame shape spike 0.1 verified the CLI accepts on stdin. */
export function userTurnFrame(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/**
 * `--replay-user-messages` echoes a delivered turn back as a `user` frame. `summarize()`
 * reads `user` frames only for `tool_result` blocks (its `agent-done` lane), so the echoed
 * text would fall on the floor and R-8.7's single ordered log would be missing half its
 * turns. This pulls out that one field and hands every other frame shape to the shared
 * reader untouched — it is a field accessor, not a second parser.
 */
export function replayedUserText(raw: string): string | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (ev.type !== 'user') return null;
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = (content as Array<Record<string, unknown>>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('\n')
    .trim();
  return text || null;
}

/**
 * Does this line close a turn? A `result` frame is the CLI's end-of-turn marker on a
 * persistent stream-json session (spike 0.1: the process stays alive past it and answers
 * the next turn), so it is the moment the session stops working and starts waiting —
 * which is what R-5.4 asks to be visible.
 *
 * `summarize()` cannot answer this: it maps a `result` frame to a `log` row *only when it
 * carries a prose `result` string*, and the envelope turns (spike 2.1) carry
 * `structured_output` instead, so the turn boundary would be invisible on exactly the
 * turns that matter. Like `replayedUserText`, this reads one field off one frame shape and
 * hands everything else to the shared reader — a field accessor, not a second parser.
 */
export function isTurnEnd(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { type?: unknown }).type === 'result';
  } catch {
    return false;
  }
}

/** Read a target relative to `cwd`, returning null when it is gone. */
function fsReader(cwd: string): ReadTargetFile {
  return async (path) => {
    try {
      return await readFile(isAbsolute(path) ? path : resolvePath(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
}

/** A missing file pins as `null`, which is distinguishable from "pinned as empty". */
function pinOf(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}

/**
 * The local arm. The comment comes from the sidecar, the target is the file it names,
 * drift is that file's bytes changing between propose and approve, the terminal state is
 * `open → applied` with a result, and the scoped apply pass is available as a fallback.
 *
 * The drift check here is the *pinned-state* comparison the interface asks for. It is not
 * the whole story: once approval applies a patch (B4.1), the patch refusing to apply is
 * the primary, unfakeable signal — this one is the cheap pre-check in front of it.
 */
export function createLocalSessionOps(getDeps: () => ReviewDeps): ReviewSessionOps {
  const read = (path: string) => {
    const deps = getDeps();
    return (deps.readTargetFile ?? fsReader(deps.cwd))(path);
  };
  return {
    fallbackAvailable: true,
    // The sidecar only ever holds local comments, so a comment resolved from it is local
    // by construction — this is the origin, not a guess at it (R-3.8).
    promptMode: { mode: 'local' },
    async resolve(commentId) {
      const doc = await getDeps().comments.read();
      const c = doc.comments.find((r) => r.id === commentId);
      if (!c) return null;
      return {
        id: c.id,
        comment: c.comment,
        workflow: c.workflow,
        path: c.target.path,
        kind: c.target.kind,
        ...(c.target.startLine !== undefined ? { startLine: c.target.startLine } : {}),
        ...(c.target.endLine !== undefined ? { endLine: c.target.endLine } : {}),
        ...(c.target.snippet !== undefined ? { snippet: c.target.snippet } : {}),
        ...(c.target.endSnippet !== undefined ? { endSnippet: c.target.endSnippet } : {}),
        ...(c.target.heading !== undefined ? { heading: c.target.heading } : {}),
      };
    },
    async locate(comment) {
      const content = await read(comment.path);
      if (content === null) return null;
      return {
        path: comment.path,
        ...(comment.startLine !== undefined ? { startLine: comment.startLine } : {}),
        pin: pinOf(content),
      };
    },
    async checkDrift(located) {
      const pin = pinOf(await read(located.path));
      if (pin === null) return { drifted: true, reason: `${located.path} no longer exists` };
      if (pin !== located.pin) return { drifted: true, reason: `${located.path} changed since the proposal` };
      return { drifted: false };
    },
    async finish(comment, outcome) {
      const store = getDeps().comments;
      const doc = await store.read();
      await store.write(setStatus(doc, comment.id, 'applied', outcome.result));
    },
  };
}

/* ------------------------------------------------------------------ *
 * The hub
 * ------------------------------------------------------------------ */

/** One session at a time, many subscribers, replayable history. */
export interface ReviewHub {
  /** Attach an SSE subscriber (writes headers + a `sync` snapshot, then streams). */
  subscribe(res: ServerResponse): void;
  start(commentId: string | undefined): RouteResult;
  message(text: string | undefined): RouteResult;
  approve(): RouteResult;
  cancel(): RouteResult;
  snapshot(): { running: boolean; startedAt: number | null; commentId: string | null; phase: ReviewPhase };
}

/**
 * Build the hub. `getDeps` is a thunk for the same reason `createApplyHub`'s is: the
 * served directory is mutable at runtime.
 *
 * `lock` is the shared run lock (R-8.5), held as `'review'` for the whole session, so a
 * bulk apply started meanwhile is refused with a body naming this holder — and vice
 * versa. Every terminal path below goes through `end()`, which is the only place the
 * lock is released.
 *
 * Those paths are cancel, child `close`, child `error`, a spawn that throws, a follow-up
 * turn that cannot be delivered, and the abandonment bound (R-7.8). The last one is the
 * only one nobody asks for: a browser tab that goes away takes its `EventSource` with it
 * and nothing else would ever notice, so a session left with no subscriber and no input
 * reaps itself rather than holding the single slot until the server restarts (R-7.6).
 */
export function createReviewHub(
  getDeps: () => ReviewDeps,
  lock: RunLock = sharedRunLock,
  makeOps: (getDeps: () => ReviewDeps) => ReviewSessionOps = createLocalSessionOps,
): ReviewHub {
  let events: ReviewEvent[] = [];
  let phase: ReviewPhase = 'idle';
  let commentId: string | null = null;
  let startedAt: number | null = null;
  let child: ReviewChild | null = null;
  let located: LocatedTarget | null = null;
  let comment: ResolvedComment | null = null;
  /**
   * The latest envelope this session produced — what B4.1's approval applies.
   *
   * "Latest" is the whole point. Every turn's `result` frame carries a full envelope
   * (spike 2.1), so a refinement does not amend the previous proposal, it *supersedes* it:
   * this slot is overwritten on each `proposal` frame and nothing keeps the older ones.
   * R-6.2 requires approval to apply "the latest proposal presented in the session at
   * approval time", and this single, always-overwritten slot is that guarantee — there is
   * no list for approval to pick the wrong element from.
   */
  let proposal: Proposal | null = null;
  /**
   * R-7.7 — whether the child is still writable. `close`/`error` clear it *before* `end()`
   * releases the slot, so a `message`/`approve` landing in that window is answered as a
   * dead session rather than being written into a broken pipe.
   */
  let childAlive = false;
  let idleTimer: TimerHandle | null = null;
  const subs = new Set<ServerResponse>();
  const ops = makeOps(getDeps);

  const frame = (res: ServerResponse, f: ReviewEvent | ReviewSync) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(f)}\n\n`);
  };
  const broadcast = (e: ReviewEvent) => {
    events.push(e);
    for (const res of subs) frame(res, e);
  };

  const running = () => phase === 'proposing' || phase === 'awaiting-input';

  const clearIdle = () => {
    if (idleTimer === null) return;
    (getDeps().clearTimer ?? defaultClearTimer)(idleTimer);
    idleTimer = null;
  };

  /**
   * R-7.6. The bound is armed only while the session is running *and* nobody is watching:
   * a subscribed tab is a live client, and a delivered turn is input. A dropped tab
   * therefore starts the clock, and reconnecting or typing stops it — the slot cannot be
   * wedged by a closed browser until a server restart.
   */
  const armIdle = () => {
    clearIdle();
    if (!running() || subs.size > 0) return;
    const deps = getDeps();
    idleTimer = (deps.setTimer ?? defaultSetTimer)(onIdle, deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  };

  function onIdle() {
    idleTimer = null;
    if (!running()) return;
    broadcast({ type: 'log', kind: 'system', text: 'No client and no input — ending the abandoned review session.' });
    childAlive = false;
    child?.kill?.('SIGKILL');
    end(false, 'idle');
  }

  /** The one exit. Every path that stops a session comes through here (R-7.8). */
  const end = (ok: boolean, reason: ReviewEndReason, exitCode?: number | null) => {
    if (phase === 'idle' || phase === 'ended') return;
    phase = 'ended';
    clearIdle();
    childAlive = false;
    child = null;
    located = null;
    comment = null;
    proposal = null;
    broadcast({ type: 'ended', ok, reason, ...(exitCode !== undefined ? { exitCode } : {}) });
    lock.release('review');
  };

  /** Feed the child's stdout through the apply reader (R-8.6) — one parser, not two. */
  const pipeOutput = (c: ReviewChild) => {
    let buf = '';
    c.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: streaming line split
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // R-8.7: the replayed turn goes into the log at the position the CLI echoed it,
        // ahead of whatever the same line yields through the shared reader.
        const echoed = replayedUserText(line);
        if (echoed) broadcast({ type: 'user-turn', text: echoed.slice(0, 2000) });
        // R-4.1–R-4.6: the envelope `--json-schema` pinned, read off the turn's result
        // frame. Spike 2.1 confirmed the CLI populates `structured_output` on EVERY turn,
        // so a refined proposal (R-5.2) arrives by exactly this path — there is no
        // prose-parsing lane behind it, and a turn without an envelope emits no proposal.
        const p = proposalFromLine(line);
        if (p) {
          proposal = p;
          broadcast({ type: 'proposal', proposal: p });
        }
        for (const f of summarize(line)) {
          if (f.type === 'start' || f.type === 'done') continue; // apply-shaped, never emitted here
          broadcast(f);
        }
        // R-5.4: the turn is over, so the session is waiting on the user — said out loud
        // in the stream, after the turn's own frames, rather than left as the absence of
        // activity. Nothing is applied here or anywhere else on this path: the phase is a
        // statement about the session, not a trigger.
        if (isTurnEnd(line) && phase === 'proposing') {
          phase = 'awaiting-input';
          broadcast({ type: 'awaiting-input' });
          armIdle();
        }
      }
    });
    c.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) broadcast({ type: 'log', kind: 'error', text: text.slice(0, 1000) });
    });
    // R-7.7: liveness drops before the slot does, on both death paths.
    c.on('error', (err) => {
      childAlive = false;
      broadcast({ type: 'error', message: err.message.includes('ENOENT') ? 'claude CLI not found on PATH' : err.message });
      end(false, 'error');
    });
    c.on('close', (code) => {
      childAlive = false;
      end(code === 0, 'exit', code);
    });
  };

  /** Resolve → locate → spawn. Any failure ends the session and frees the slot. */
  const begin = async (id: string) => {
    const deps = getDeps();
    const resolved = await ops.resolve(id);
    if (!resolved) {
      broadcast({ type: 'error', message: `no comment with id ${id}` });
      return end(false, 'error');
    }
    const target = await ops.locate(resolved);
    if (!target) {
      broadcast({ type: 'error', message: `could not locate the target of ${id}` });
      return end(false, 'error');
    }
    comment = resolved;
    located = target;
    try {
      child = (deps.spawnSession ?? defaultSpawnReviewSession)(resolved, deps.cwd);
    } catch (err) {
      broadcast({ type: 'error', message: `Could not start claude: ${(err as Error).message}` });
      return end(false, 'error');
    }
    childAlive = true;
    pipeOutput(child);
    // The opening turn: one comment, its anchor, and what the proposal must contain. The
    // arm is the ops implementation's, not a field on the request (R-3.8) — nothing above
    // this line knows whether the session is local or collaborative.
    child.stdin?.write(userTurnFrame(buildReviewPrompt(resolved, ops.promptMode)));
  };

  return {
    subscribe(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      frame(res, { type: 'sync', running: running(), phase, commentId, startedAt, events });
      subs.add(res);
      // R-7.6: a watching client suspends the abandonment bound; losing the last one
      // starts it. Subscribing with no session is legal and simply arms nothing.
      armIdle();
      res.on('close', () => {
        subs.delete(res);
        armIdle();
      });
    },

    start(id) {
      if (!id) return { status: 400, json: { error: 'missing commentId' } };
      // R-3.4 / R-8.5: one slot for review and bulk apply together, and the 409 names
      // which of the two holds it.
      if (!lock.acquire('review')) return conflictFor(lock.heldBy() ?? 'review');
      events = [];
      phase = 'proposing';
      commentId = id;
      startedAt = (getDeps().now ?? Date.now)();
      broadcast({ type: 'review-start', commentId: id, startedAt });
      armIdle();
      void begin(id).catch((err) => {
        broadcast({ type: 'error', message: (err as Error).message });
        end(false, 'error');
      });
      return { status: 200, json: { ok: true } };
    },

    // R-5.1 / R-5.3: a follow-up turn goes down the same in-channel the opening turn used,
    // as many times as the user likes — the session is not consumed by its first answer.
    message(text) {
      const guard = noSession(phase);
      if (guard) return guard;
      if (!text) return { status: 400, json: { error: 'missing text' } };
      if (!childAlive || !child?.stdin) return deadSession();
      try {
        child.stdin.write(userTurnFrame(text));
      } catch (err) {
        // The dead-child race, observed rather than inferred: the pipe broke under us
        // (R-7.7). End the session so the slot goes back, and say so distinguishably.
        childAlive = false;
        broadcast({ type: 'error', message: `could not deliver the turn: ${(err as Error).message}` });
        end(false, 'error');
        return deadSession();
      }
      // R-5.2: the answer arrives as a whole new envelope on this turn's result frame, so
      // the session is working again until that frame lands.
      phase = 'proposing';
      armIdle();
      return { status: 200, json: { ok: true } };
    },

    approve() {
      const guard = noSession(phase);
      if (guard) return guard;
      if (!childAlive) return deadSession();
      if (!located || !comment) return deadSession();
      // Nothing to approve until a turn has produced an envelope: approval means "apply
      // this patch", and with no patch there is nothing that could be applied without
      // re-deriving the change — which is the defect the envelope exists to prevent.
      if (!proposal) return { status: 409, json: { error: 'no proposal to approve yet', code: 'no-proposal' } };
      // Drift is checked before anything is authorised, so a stale proposal cannot land.
      const pinned = located;
      void ops.checkDrift(pinned).then((d) => {
        if (d.drifted) broadcast({ type: 'drift', message: d.reason });
      });
      // The write itself — `git apply` of `proposal.patch` through the GitExecutor — is
      // B4.1. Refusing here is deliberate: the one thing that must never happen in the
      // meantime is a write that re-derives the change and calls it the approved diff.
      return { status: 501, json: { error: 'applying an approved patch is not implemented yet', code: 'not-implemented' } };
    },

    cancel() {
      const guard = noSession(phase);
      if (guard) return guard;
      childAlive = false;
      child?.kill?.('SIGKILL');
      broadcast({ type: 'log', kind: 'system', text: 'Cancelling…' });
      end(false, 'cancelled');
      return { status: 200, json: { ok: true } };
    },

    snapshot() {
      return { running: running(), startedAt, commentId, phase };
    },
  };
}

/**
 * R-7.5: message/approve/cancel with no session are a conflict, not the start of work.
 * `ended` is reported separately from `idle` so the UI can tell "your session died" from
 * "there was never one" (R-7.7).
 */
function noSession(phase: ReviewPhase): RouteResult | null {
  if (phase === 'idle') return { status: 409, json: { error: 'no active review session', code: 'no-session' } };
  if (phase === 'ended') return deadSession();
  return null;
}

/**
 * R-7.7 — the answer for a session whose child is gone, in the window before the phase
 * catches up. It carries `session-ended` rather than `no-session` precisely so the UI can
 * say "your session died" instead of "there was never one"; keeping the two bodies
 * identical is what makes the window invisible to the client.
 */
function deadSession(): RouteResult {
  return { status: 409, json: { error: 'the review session has ended', code: 'session-ended' } };
}

/* ------------------------------------------------------------------ *
 * The route surface (R-8.1) — one handler, both hosts (R-8.2)
 * ------------------------------------------------------------------ */

/** `streamed` means the handler already wrote to `sse`; otherwise send the JSON. */
export type ReviewRouteResult = RouteResult | { streamed: true };

export type ReviewRequest = {
  method: string;
  /** The path *below* `/__vs/review` — `''`, `'/events'`, `'/start'`, … */
  pathname: string;
  body: Record<string, unknown>;
  sse: ServerResponse;
};

/**
 * The whole `/__vs/review` surface. Both hosts do nothing but slice the prefix off the
 * path and call this, exactly as they do for `/__vs/collab` — so neither host owns any
 * review logic of its own and R-8.2 is one registration, twice.
 */
export function handleReviewRequest(hub: ReviewHub, req: ReviewRequest): ReviewRouteResult {
  const sub = req.pathname === '/' ? '' : req.pathname;
  // R-8.9. A tab that reloads mid-session has to learn a session exists *before* it opens
  // an `EventSource` — the `sync` frame answers the same question but only to a client
  // that has already subscribed, and R-7.6's abandonment timer counts subscribers. Shape
  // mirrors `GET /__vs/apply`, plus the comment id, since a review is about one comment.
  if (req.method === 'GET' && sub === '') {
    const s = hub.snapshot();
    return { status: 200, json: { running: s.running, startedAt: s.startedAt, commentId: s.commentId } };
  }
  if (req.method === 'GET' && sub === '/events') {
    hub.subscribe(req.sse);
    return { streamed: true };
  }
  if (req.method === 'POST' && sub === '/start') {
    const id = typeof req.body.commentId === 'string' ? req.body.commentId : undefined;
    return hub.start(id);
  }
  if (req.method === 'POST' && sub === '/message') {
    const text = typeof req.body.text === 'string' ? req.body.text : undefined;
    return hub.message(text);
  }
  if (req.method === 'POST' && sub === '/approve') return hub.approve();
  if (req.method === 'POST' && sub === '/cancel') return hub.cancel();
  return { status: 404, json: { error: `no route: ${req.method} /__vs/review${sub}` } };
}
