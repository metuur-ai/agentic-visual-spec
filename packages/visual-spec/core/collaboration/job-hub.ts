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
 * re-verification (R-8.17) live in `core/collaboration/failure-states.ts` (task 8.4),
 * which derives `ready` from GitHub on every ask rather than storing it.
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
  // The three refinements of the diagram's single `Failed` node, added by task 8.4.
  // They are separate strings because a client must be able to tell them apart from
  // each other and from a generic failure without parsing an error message:
  | 'conflicted' // R-8.20 — base moved, the PR cannot merge. No auto-resolution.
  | 'verification-failed' // R-8.21 — the committed blob is not the payload bytes.
  | 'base-diverged' // R-8.22 — base changed the target path since the branch point.
  | 'failed';

/**
 * A rejection from a body that has ALREADY declared, through `ctx.setState`, the state
 * it wants recorded. The hub then leaves that state alone instead of replacing it with
 * `failed`.
 *
 * Two kinds of outcome need this, and neither is "the job blew up":
 *   - a refusal (R-8.15 / R-8.17 / R-8.20) — the job ran correctly and its answer is
 *     "no". The document is still `pr-open` or `conflicted`, and saying `failed` would
 *     invite a retry of something that will refuse again for the same good reason;
 *   - a distinguished failure (R-8.21 / R-8.22) — `verification-failed` and
 *     `base-diverged` exist precisely so a client can tell them apart, and collapsing
 *     them into `failed` would erase that.
 *
 * It is opt-in per error rather than a list of "safe" states, because whether a
 * declared state survives is a property of *why* the body threw, not of the state.
 */
export function markStateDecided<E>(err: E): E {
  if (err && typeof err === 'object') Object.defineProperty(err, 'stateDecided', { value: true, enumerable: false });
  return err;
}

/** True when `err` was marked (or declares) that it already recorded its state. */
export function isStateDecided(err: unknown): boolean {
  return (err as { stateDecided?: unknown } | null)?.stateDecided === true;
}

/** R-8.3 — every lifecycle transition that runs as a job. One entry per transition. */
export type JobKind =
  | 'create' // create branch + PR, commit the canonical JSON (R-8.5)
  | 'commit' // commit structured JSON to the PR branch
  | 'sync' // pull PR issue comments from GitHub (R-8.6, R-8.7)
  | 'remap' // re-resolve comment anchors after document edits
  | 'resolve' // resolve / unresolve a thread via the reply-marker convention
  | 'publish' // commit the client's final Markdown, then verify it (R-8.9 … R-8.14)
  | 'reconcile' // re-derive lifecycle state from GitHub, cleaning an orphan branch (R-8.18)
  | 'ready' // re-derive readiness from GitHub and record `ready` (R-8.15)
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

/** Argument to `start`. `idempotencyKey` de-duplicates a retry (R-8.23). */
export type StartJobRequest = {
  kind: JobKind;
  run: JobBody;
  /**
   * R-8.23 — the token that makes a retry safe. Threaded through to `JobContext`, the
   * `job-start` event and the snapshot, and consulted by `start` **before** the
   * one-job-at-a-time check: see `IDEMPOTENCY_LIMIT` for the exact policy.
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
  /**
   * R-8.23 — how many idempotency keys one document remembers (default 64). An
   * unbounded map is a leak: a long session retries with a fresh key every time, and
   * nothing would ever remove the old ones. See `IDEMPOTENCY_LIMIT`.
   */
  maxIdempotencyKeys?: number;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * R-8.6 — notified whenever a document's SSE subscriber count *changes*, with the new
 * count. The hub reports the fact and takes no view of it; 7.2 is what decides that the
 * fact means "start / stop the interval poller". Repeats are suppressed: a re-`subscribe`
 * of a sink already attached, or a second `close` for one already gone, changes no count
 * and notifies nobody.
 */
export type WatcherListener = (documentId: string, count: number) => void;

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
  /**
   * R-8.6 — register the one listener notified when any document's subscriber count
   * changes. A single slot rather than a set: there is exactly one consumer (7.2's
   * poller wiring), and a set would invite a second owner of the same decision. Read
   * through at notify time, so hubs created before *and* after the call are covered.
   */
  onWatchersChanged(listener: WatcherListener): void;
}

const DEFAULT_MAX_EVENTS = 500;

/**
 * R-8.23 — IDEMPOTENCY POLICY, in one place.
 *
 * WHAT A KEY MEANS. One key identifies one *logical* lifecycle request, not one HTTP
 * call. A client that times out and retries sends the same key; the hub must then not
 * run the body a second time, because create would open a second branch and a second
 * PR, and publish would commit twice.
 *
 * WHAT A RETRY GETS BACK. The **original** job's result — the same `jobId`, plus
 * `deduplicated: true` so the caller can tell. It never starts a second job:
 *   - original still RUNNING → 200 with the original `jobId`. Not a 409: a retry is
 *     not a conflicting second request, it is the same request arriving twice, and the
 *     caller is already subscribed to the SSE stream that will carry the outcome.
 *   - original SUCCEEDED → 200 with the original `jobId`, nothing re-run.
 *   - original FAILED → the key is **released** and the body runs. LLD §7 has an
 *     explicit `Failed --> PROpen : retry` edge; a key that pinned a failure forever
 *     would make that edge unreachable, and there is nothing to duplicate — the work
 *     did not land.
 *
 * LIFETIME AND EVICTION. Keys live in a per-document, insertion-ordered `Map` bounded
 * at `maxIdempotencyKeys` (default 64); at the bound the **oldest** entry is dropped.
 * They are also cleared by `dispose()`, so a closed document keeps nothing. There is no
 * TTL: the clock is injected and a wall-clock expiry would make the same retry behave
 * differently depending on how long the user's laptop was asleep. A count bound is
 * enough because the failure mode being prevented is a double-click and a timeout
 * retry, both of which arrive within a job or two — and 64 is far more than the handful
 * of lifecycle jobs one document runs between opening and merging.
 *
 * WHAT THIS DOES NOT COVER. Two *different* keys for the same logical request still
 * produce two jobs (the client must reuse the key), and a key is per-process — a server
 * restart forgets it. Both are stated rather than papered over: the durable de-dupe for
 * comments is the trailer `key` in `comment-projection.ts`, and for a branch it is the
 * deterministic `branchNameFor` plus `create`'s own "already exists" handling.
 */
const IDEMPOTENCY_LIMIT = 64;

function createDocumentJobHub(
  documentId: string,
  maxEvents: number,
  maxIdempotencyKeys: number,
  now: () => number,
  notifyWatchers: (count: number) => void,
): DocumentJobHub {
  let state: LifecycleState = 'draft';
  let job: JobRecord | null = null;
  let running = false;
  let abort: AbortController | null = null;
  let events: JobEvent[] = [];
  let droppedEvents = 0;
  let seq = 0;
  const subs = new Set<SseSink>();
  /** R-8.23 — idempotency key → the job it started. Insertion-ordered, bounded. */
  const byKey = new Map<string, JobRecord>();

  const rememberKey = (key: string, record: JobRecord) => {
    byKey.set(key, record);
    while (byKey.size > maxIdempotencyKeys) {
      const oldest = byKey.keys().next();
      if (oldest.done) break;
      byKey.delete(oldest.value);
    }
  };

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
      const before = subs.size;
      subs.add(sink);
      // `Set.add` of a sink already attached is a no-op, and `Set.delete` of one already
      // gone answers false — so both guards below fire the listener only on a real
      // change. A tab that double-subscribes cannot start two pollers, and a sink whose
      // `close` runs twice cannot stop the poller out from under a live subscriber.
      if (subs.size !== before) notifyWatchers(subs.size);
      sink.on('close', () => {
        if (subs.delete(sink)) notifyWatchers(subs.size);
      });
    },

    start({ kind, run, idempotencyKey }) {
      // R-8.23 — consulted BEFORE the 409 branch, because a retry of the request that
      // is still running is not a conflict; it is the same request arriving twice.
      // A failed prior attempt releases the key so the retry can actually retry.
      if (idempotencyKey) {
        const prior = byKey.get(idempotencyKey);
        if (prior && prior.ok !== false) {
          return {
            status: 200,
            json: { ok: true, jobId: prior.jobId, kind: prior.kind, deduplicated: true, running: prior.finishedAt === null },
          };
        }
        if (prior) byKey.delete(idempotencyKey);
      }

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
      if (idempotencyKey) rememberKey(idempotencyKey, job);
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
        // Keep the remembered record current, so a retry sees the *outcome* and not the
        // in-flight snapshot. `set` on an existing key preserves insertion order.
        if (idempotencyKey && job) byKey.set(idempotencyKey, job);
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
          // transition it must record honestly: the job did not complete — unless the
          // body already decided the state itself (see `markStateDecided`).
          if (!isStateDecided(err)) state = 'failed';
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
      const had = subs.size;
      subs.clear();
      // Ending every sink here does *not* run their `close` handlers — those are the
      // transport's, and this is a local teardown. So dispose announces the drop to zero
      // itself; without this a disposed document would leave its poller running forever.
      if (had > 0) notifyWatchers(0);
      events = [];
      droppedEvents = 0;
      byKey.clear();
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
  const maxIdempotencyKeys = Math.max(1, options.maxIdempotencyKeys ?? IDEMPOTENCY_LIMIT);
  const now = options.now ?? Date.now;
  const hubs = new Map<string, DocumentJobHub>();
  let watchers: WatcherListener | null = null;

  return {
    hub(documentId) {
      if (!DOCUMENT_ID_RE.test(documentId)) throw new Error(`invalid documentId: ${documentId}`);
      let existing = hubs.get(documentId);
      if (!existing) {
        existing = createDocumentJobHub(documentId, maxEvents, maxIdempotencyKeys, now, (count) =>
          watchers?.(documentId, count),
        );
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

    onWatchersChanged(listener) {
      watchers = listener;
    },
  };
}
