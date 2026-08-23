/**
 * routes/review.ts — the interactive review session hub + its HTTP surface.
 *
 * A review session is the *single-comment* counterpart to `routes/apply.ts`: the
 * user asks for one comment to be applied, gets a proposal back, refines it over
 * several turns, and only then authorises the write. Nothing here writes to disk.
 *
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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { setStatus } from '../../editing/comment-doc';
import { type ApplyEvent, type ClaudeChild, type RouteResult, summarize } from './apply';
import type { CommentDocStore } from './comments';
import { conflictFor, type RunLock, sharedRunLock } from './run-lock';

/** Activity rows `summarize()` can produce. `start`/`done` are apply-shaped and never
 *  reach a review stream, so they are excluded rather than left as unreachable cases. */
export type ReviewLogEvent = Exclude<ApplyEvent, { type: 'start' } | { type: 'done' }>;

/** Why a session ended — the UI messages cancel differently from a crash. */
export type ReviewEndReason = 'cancelled' | 'exit' | 'error';

/** A frame pushed to subscribers as it happens. */
export type ReviewEvent =
  | ReviewLogEvent
  | { type: 'review-start'; commentId: string; startedAt: number }
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

/** The comment a session is about, in the shape the hub needs — never the store record. */
export type ResolvedComment = {
  id: string;
  comment: string;
  workflow: string;
  path: string;
  startLine?: number;
  snippet?: string;
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
}

/* ------------------------------------------------------------------ *
 * Local implementation
 * ------------------------------------------------------------------ */

export type ReadTargetFile = (path: string) => Promise<string | null>;

export interface ReviewDeps {
  /** Directory the session runs in — the project root, where the sidecar lives. */
  cwd: string;
  comments: CommentDocStore;
  /** Override the child for tests; absent means the transport is not wired yet. */
  spawnSession?: ReviewSpawn;
  /** Override target reads for tests; defaults to reading from disk under `cwd`. */
  readTargetFile?: ReadTargetFile;
  now?: () => number;
}

/** A session child. Same shape as the apply child plus the in-channel apply lacks. */
export interface ReviewChild extends ClaudeChild {
  stdin?: NodeJS.WritableStream | null;
}

/** Injected the way `apply.ts` injects `spawnClaude`. The real spawn lands in B1.3. */
export type ReviewSpawn = (comment: ResolvedComment, cwd: string) => ReviewChild;

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
    async resolve(commentId) {
      const doc = await getDeps().comments.read();
      const c = doc.comments.find((r) => r.id === commentId);
      if (!c) return null;
      return {
        id: c.id,
        comment: c.comment,
        workflow: c.workflow,
        path: c.target.path,
        ...(c.target.startLine !== undefined ? { startLine: c.target.startLine } : {}),
        ...(c.target.snippet !== undefined ? { snippet: c.target.snippet } : {}),
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

  /** The one exit. Every path that stops a session comes through here (R-7.8). */
  const end = (ok: boolean, reason: ReviewEndReason, exitCode?: number | null) => {
    if (phase === 'idle' || phase === 'ended') return;
    phase = 'ended';
    child = null;
    located = null;
    comment = null;
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
        for (const f of summarize(line)) {
          if (f.type === 'start' || f.type === 'done') continue; // apply-shaped, never emitted here
          broadcast(f);
        }
      }
    });
    c.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) broadcast({ type: 'log', kind: 'error', text: text.slice(0, 1000) });
    });
    c.on('error', (err) => {
      broadcast({ type: 'error', message: err.message.includes('ENOENT') ? 'claude CLI not found on PATH' : err.message });
      end(false, 'error');
    });
    c.on('close', (code) => end(code === 0, 'exit', code));
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
    // The transport itself is B1.3; until it is injected there is nothing to talk to.
    if (!deps.spawnSession) {
      broadcast({ type: 'error', message: 'review transport is not wired yet' });
      return end(false, 'error');
    }
    try {
      child = deps.spawnSession(resolved, deps.cwd);
    } catch (err) {
      broadcast({ type: 'error', message: `Could not start claude: ${(err as Error).message}` });
      return end(false, 'error');
    }
    pipeOutput(child);
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
      res.on('close', () => subs.delete(res));
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
      void begin(id).catch((err) => {
        broadcast({ type: 'error', message: (err as Error).message });
        end(false, 'error');
      });
      return { status: 200, json: { ok: true } };
    },

    message(text) {
      const guard = noSession(phase);
      if (guard) return guard;
      if (!text) return { status: 400, json: { error: 'missing text' } };
      if (!child?.stdin) return { status: 409, json: { error: 'the review session has no input channel', code: 'session-ended' } };
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      phase = 'proposing';
      return { status: 200, json: { ok: true } };
    },

    approve() {
      const guard = noSession(phase);
      if (guard) return guard;
      if (!located || !comment) return { status: 409, json: { error: 'the review session has ended', code: 'session-ended' } };
      // Drift is checked before anything is authorised, so a stale proposal cannot land.
      // The write itself — applying the approved patch — is B4.1.
      const pinned = located;
      void ops.checkDrift(pinned).then((d) => {
        if (d.drifted) broadcast({ type: 'drift', message: d.reason });
      });
      return { status: 409, json: { error: 'no proposal to approve yet', code: 'no-proposal' } };
    },

    cancel() {
      const guard = noSession(phase);
      if (guard) return guard;
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
  if (phase === 'ended') return { status: 409, json: { error: 'the review session has ended', code: 'session-ended' } };
  return null;
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
