/**
 * job-hub.ts — per-document lifecycle job hubs (R-8.1 … R-8.4).
 *
 * Mirrors `createApplyHub`'s *discipline* (`core/vite/routes/apply.ts:251`) — one owner
 * per operation, browser tabs subscribe over SSE, the state is replayable — but
 * deliberately **not its shape**. `createApplyHub` is a module-level singleton (`let
 * events`, `let running`, one `subs` Set), so it permits one run at a time *globally*.
 * Collaboration runs jobs for several documents at once, so this is a **registry keyed
 * by `documentId`** where every entry owns its own event log, lifecycle state, running
 * job and subscriber set (R-8.1). No state is shared between documents, and nothing in
 * this module is module-level mutable.
 *
 * **Job bodies live elsewhere.** This module owns the job *kind* vocabulary, the runner
 * and the fan-out; it performs no GitHub work. Tasks 8.2 (create + sync) and 8.3
 * (publish) inject a `JobBody` per start call, so they supply real behaviour without
 * reshaping the hub.
 *
 * **Transition rules live elsewhere too.** `LifecycleState` is the typed vocabulary from
 * LLD §7's state diagram, and the hub *holds and reports* whatever state a job declares.
 * It does not enforce the gates — the Ready gate (R-8.15) and merge-time
 * re-verification (R-8.17) are task 8.4.
 *
 * Node-reachable from the CLI: node builtin types only, no `@lyfie/luthor`, no react
 * (R-3.3 / R-12.6, guarded by `core/bundle-guard.test.ts`).
 */
import { DOCUMENT_ID_RE } from './document-store';

/**
 * LLD §7 — the collaboration lifecycle states, as a closed vocabulary every later task
 * references. One string per node of the state diagram.
 *
 * `ready` is *derived*, not durable (LLD §7): it is re-verified at merge time because a
 * comment can arrive between the poll that computed readiness and the merge request. The
 * hub stores whatever a job last declared; task 8.4 owns re-deriving it.
 */
export type LifecycleState =
  | 'draft'
  | 'pr-open'
  | 'ready'
  | 'publishing'
  | 'verifying'
  | 'published'
  | 'merged'
  | 'closed'
  | 'failed';

/** R-8.3 — every lifecycle transition that runs as a job. One entry per transition. */
export type JobKind =
  | 'create' // create branch + PR, commit the canonical JSON (R-8.5)
  | 'commit' // commit structured JSON to the PR branch
  | 'sync' // pull PR issue comments from GitHub (R-8.6, R-8.7)
  | 'remap' // re-resolve comment anchors after document edits
  | 'resolve' // resolve / unresolve a thread via the reply-marker convention
  | 'publish' // commit the client's final Markdown, then verify it (R-8.9 … R-8.14)
  | 'merge'; // merge the PR — deliberately NOT part of publish (LLD §7)

/** Category of a streamed log row — drives icon + styling, as `ApplyLogKind` does. */
export type JobLogKind = 'system' | 'progress' | 'error';

/** A frame pushed to subscribers as it happens (R-8.2). */
export type JobEvent =
  | { type: 'job-start'; jobId: string; kind: JobKind; startedAt: number; idempotencyKey?: string }
  | { type: 'log'; jobId: string; kind: JobLogKind; text: string }
  | { type: 'state'; jobId: string; state: LifecycleState; at: number }
  | { type: 'job-done'; jobId: string; kind: JobKind; ok: boolean; state: LifecycleState; finishedAt: number; cancelled?: boolean }
  | { type: 'job-error'; jobId: string; kind: JobKind; message: string; at: number };

/** The job currently in flight, or the last one to have run. */
export type JobRecord = {
  jobId: string;
  kind: JobKind;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  idempotencyKey?: string;
};

/**
 * R-8.4 — everything a late subscriber needs to recover current state, independent of
 * the event log. `state`, `running` and `job` are authoritative on their own, so a
 * subscriber that attaches after the log has been trimmed (or after the job finished)
 * still recovers correctly.
 *
 * `droppedEvents` is how many frames the bound discarded, so a client can tell "this is
 * the whole history" from "this is the tail of it".
 */
export type JobSnapshot = {
  documentId: string;
  state: LifecycleState;
  running: boolean;
  job: JobRecord | null;
  events: JobEvent[];
  droppedEvents: number;
};

/** The first frame every subscriber receives — the snapshot, replayed (R-8.4). */
export type JobSync = { type: 'sync' } & JobSnapshot;

/** Mirrors `RouteResult` in `routes/apply.ts` so 7.2 can return these straight through. */
export type JobRouteResult = { status: number; json: unknown };

/**
 * What a job body is handed. Everything a body needs to report progress; nothing that
 * lets it reach another document's hub.
 */
export interface JobContext {
  readonly documentId: string;
  readonly jobId: string;
  readonly kind: JobKind;
  /** Aborted by `cancel()` and by `dispose()`. Long steps should check it. */
  readonly signal: AbortSignal;
  /** The token 8.4 will key idempotency on. Opaque to the hub. */
  readonly idempotencyKey?: string;
  /** Push a log row to every subscriber of this document. */
  log(text: string, kind?: JobLogKind): void;
  /** Declare the lifecycle state reached. Recorded and fanned out. */
  setState(state: LifecycleState): void;
  /** Injected clock — tests pass a fake so no real timers are involved. */
  now(): number;
}

/**
 * R-8.3 — the contract 8.2 / 8.3 write against. A body resolves on success and rejects
 * on failure; the hub turns a rejection into a `job-error` frame plus `state: 'failed'`.
 */
export type JobBody = (ctx: JobContext) => Promise<void>;

/** Argument to `start`. `idempotencyKey` is carried and reported but not yet acted on. */
export type StartJobRequest = {
  kind: JobKind;
  run: JobBody;
  /**
   * R-8.23 — reserved for task 8.4. Threaded through to `JobContext`, the `job-start`
   * event and the snapshot so 8.4 can add de-duplication without a breaking change.
   */
  idempotencyKey?: string;
};

/**
 * The SSE sink. Structurally a subset of `node:http`'s `ServerResponse`, so 7.2 passes
 * the real `res` and tests pass a plain object — no HTTP server in the unit tests.
 */
export interface SseSink {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  on(event: 'close', cb: () => void): unknown;
  end?(): unknown;
  readonly writableEnded?: boolean;
}

export interface JobHubOptions {
  /**
   * Bound on the retained event log per document (default 500). A collaboration session
   * runs for hours and syncs on an interval, so an unbounded log is a slow leak. When
   * the bound is hit the **oldest** frames are dropped and counted in
   * `droppedEvents` — R-8.4 replay is not weakened by this, because `state`, `running`
   * and `job` in the snapshot are tracked separately from the log.
   */
  maxEvents?: number;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
}

/** One document's job hub. Owns its state, log, subscribers and running job. */
export interface DocumentJobHub {
  readonly documentId: string;
  /** Attach an SSE subscriber: writes headers + a `sync` frame, then streams (R-8.2). */
  subscribe(sink: SseSink): void;
  /** Start a job for this document. 409 when one is already running. */
  start(req: StartJobRequest): JobRouteResult;
  /** Abort the running job's signal. 409 when nothing is running. */
  cancel(): JobRouteResult;
  /** `{ status: 200, json: snapshot }` — the route-shaped form of `snapshot()`. */
  status(): JobRouteResult;
  /** R-8.4 — the raw recovery snapshot. */
  snapshot(): JobSnapshot;
  /** Number of attached SSE subscribers. Used by tests to prove isolation. */
  subscriberCount(): number;
  /** Abort any running job, end every subscriber, clear the log. */
  dispose(): void;
}

/** R-8.1 — the registry. Nothing here is module-level; call it once per server. */
export interface JobHubRegistry {
  /** The hub for `documentId`, created on first use. */
  hub(documentId: string): DocumentJobHub;
  /** The hub for `documentId` if one exists — never creates. */
  peek(documentId: string): DocumentJobHub | undefined;
  /** Every documentId with a live hub, sorted. */
  documentIds(): string[];
  /** Dispose one hub and drop it from the registry. */
  dispose(documentId: string): void;
  /** Dispose every hub. Call on server shutdown. */
  disposeAll(): void;
}

const DEFAULT_MAX_EVENTS = 500;

function createDocumentJobHub(documentId: string, maxEvents: number, now: () => number): DocumentJobHub {
  let state: LifecycleState = 'draft';
  let job: JobRecord | null = null;
  let running = false;
  let abort: AbortController | null = null;
  let events: JobEvent[] = [];
  let droppedEvents = 0;
  let seq = 0;
  const subs = new Set<SseSink>();

  const snapshot = (): JobSnapshot => ({
    documentId,
    state,
    running,
    job: job ? { ...job } : null,
    events: [...events],
    droppedEvents,
  });

  const frame = (sink: SseSink, f: JobEvent | JobSync) => {
    if (!sink.writableEnded) sink.write(`data: ${JSON.stringify(f)}\n\n`);
  };

  const broadcast = (e: JobEvent) => {
    events.push(e);
    if (events.length > maxEvents) {
      droppedEvents += events.length - maxEvents;
      events = events.slice(events.length - maxEvents);
    }
    for (const sink of subs) frame(sink, e);
  };

  return {
    documentId,

    subscribe(sink) {
      sink.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      frame(sink, { type: 'sync', ...snapshot() });
      subs.add(sink);
      sink.on('close', () => subs.delete(sink));
    },

    start({ kind, run, idempotencyKey }) {
      // One job per document at a time — a second request is REJECTED, not queued. A
      // queue would let a stale publish land after a sync that invalidated it, and the
      // caller cannot see what it is waiting behind. The client retries after `job-done`.
      if (running) return { status: 409, json: { error: `a ${job?.kind ?? 'job'} is already running for ${documentId}` } };

      seq += 1;
      const jobId = `${documentId}-${seq}`;
      const startedAt = now();
      running = true;
      abort = new AbortController();
      job = { jobId, kind, startedAt, finishedAt: null, ok: null, ...(idempotencyKey ? { idempotencyKey } : {}) };
      broadcast({ type: 'job-start', jobId, kind, startedAt, ...(idempotencyKey ? { idempotencyKey } : {}) });

      const ctx: JobContext = {
        documentId,
        jobId,
        kind,
        signal: abort.signal,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        log(text, logKind = 'system') {
          broadcast({ type: 'log', jobId, kind: logKind, text });
        },
        setState(next) {
          state = next;
          broadcast({ type: 'state', jobId, state: next, at: now() });
        },
        now,
      };

      const settle = (ok: boolean) => {
        running = false;
        const cancelled = abort?.signal.aborted === true;
        abort = null;
        if (job) job = { ...job, finishedAt: now(), ok };
        broadcast({
          type: 'job-done',
          jobId,
          kind,
          ok,
          state,
          finishedAt: now(),
          ...(cancelled ? { cancelled: true } : {}),
        });
      };

      // Invoked synchronously, as `createApplyHub` invokes `runApply`: a body's prologue
      // (notably `signal.addEventListener('abort', …)`) must be in place before `start`
      // returns, or a caller that starts and cancels in one turn loses the abort.
      let settled: Promise<void>;
      try {
        settled = run(ctx);
      } catch (err) {
        settled = Promise.reject(err);
      }
      void settled.then(
        () => settle(true),
        (err: unknown) => {
          // The hub does not own transition rules, but an uncaught rejection is the one
          // transition it must record honestly: the job did not complete.
          state = 'failed';
          broadcast({ type: 'job-error', jobId, kind, message: (err as Error)?.message ?? String(err), at: now() });
          settle(false);
        },
      );

      return { status: 200, json: { ok: true, jobId, kind } };
    },

    cancel() {
      if (!running || !abort) return { status: 409, json: { error: `no job running for ${documentId}` } };
      abort.abort();
      return { status: 200, json: { ok: true, jobId: job?.jobId ?? null } };
    },

    status() {
      return { status: 200, json: snapshot() };
    },

    snapshot,

    subscriberCount() {
      return subs.size;
    },

    dispose() {
      abort?.abort();
      abort = null;
      running = false;
      for (const sink of subs) sink.end?.();
      subs.clear();
      events = [];
      droppedEvents = 0;
    },
  };
}

/**
 * R-8.1 — build the registry. One instance per server; hubs are created lazily per
 * `documentId` and removed by `dispose` / `disposeAll`, so a long session does not
 * accumulate an entry for every document ever opened.
 */
export function createJobHubRegistry(options: JobHubOptions = {}): JobHubRegistry {
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
  const now = options.now ?? Date.now;
  const hubs = new Map<string, DocumentJobHub>();

  return {
    hub(documentId) {
      if (!DOCUMENT_ID_RE.test(documentId)) throw new Error(`invalid documentId: ${documentId}`);
      let existing = hubs.get(documentId);
      if (!existing) {
        existing = createDocumentJobHub(documentId, maxEvents, now);
        hubs.set(documentId, existing);
      }
      return existing;
    },

    peek(documentId) {
      return hubs.get(documentId);
    },

    documentIds() {
      return [...hubs.keys()].sort();
    },

    dispose(documentId) {
      const existing = hubs.get(documentId);
      if (!existing) return;
      existing.dispose();
      hubs.delete(documentId);
    },

    disposeAll() {
      for (const existing of hubs.values()) existing.dispose();
      hubs.clear();
    },
  };
}
