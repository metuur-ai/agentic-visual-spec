import { describe, expect, it } from 'vitest';
import {
  createJobHubRegistry,
  type JobBody,
  type JobEvent,
  type JobHubRegistry,
  type JobSync,
  type LifecycleState,
  type SseSink,
} from './job-hub';

/** A fake SSE sink — records every frame, so no HTTP server is involved. */
function fakeSink() {
  const frames: (JobEvent | JobSync)[] = [];
  let closed: (() => void) | null = null;
  let ended = false;
  const sink: SseSink & { frames: typeof frames; head: Record<string, string> | null; close: () => void; ended: () => boolean } = {
    frames,
    head: null,
    writeHead(_status, headers) {
      sink.head = headers;
    },
    write(chunk) {
      frames.push(JSON.parse(chunk.replace(/^data: /, '').trim()));
    },
    on(_event, cb) {
      closed = cb;
    },
    end() {
      ended = true;
    },
    close() {
      closed?.();
    },
    ended() {
      return ended;
    },
    get writableEnded() {
      return ended;
    },
  };
  return sink;
}

/** Deterministic injected clock — no real timers anywhere in this suite. */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, tick: (by = 1) => (t += by) };
}

const registry = (over: Parameters<typeof createJobHubRegistry>[0] = {}): JobHubRegistry =>
  createJobHubRegistry({ now: fakeClock().now, ...over });

/** A body that resolves immediately, optionally declaring a state. */
const bodyReaching = (state?: LifecycleState): JobBody => async (ctx) => {
  if (state) ctx.setState(state);
};

/** A body that parks until the returned `release` is called. */
function gatedBody() {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const gate = new Promise<void>((res, rej) => {
    release = res;
    fail = rej;
  });
  const body: JobBody = async () => gate;
  return { body, release, fail };
}

const kinds = (frames: (JobEvent | JobSync)[]) => frames.map((f) => f.type);

describe('job hub registry (R-8.1)', () => {
  it('creates a hub per documentId and never returns another document’s hub', () => {
    const reg = registry();
    const a = reg.hub('doc-a');
    const b = reg.hub('doc-b');

    expect(a).not.toBe(b);
    expect(reg.hub('doc-a')).toBe(a); // lazily created, then stable
    expect(reg.documentIds()).toEqual(['doc-a', 'doc-b']);
  });

  it('peek never creates a hub', () => {
    const reg = registry();
    expect(reg.peek('doc-a')).toBeUndefined();
    expect(reg.documentIds()).toEqual([]);
    reg.hub('doc-a');
    expect(reg.peek('doc-a')).toBeDefined();
  });

  it('rejects a documentId that is not a safe single path segment', () => {
    const reg = registry();
    expect(() => reg.hub('../../etc/passwd')).toThrow(/invalid documentId/);
  });

  // *** The isolation proof (R-8.1). ***
  it('runs jobs for two documents concurrently with no shared events, running state or subscribers', async () => {
    const reg = registry();
    const a = reg.hub('doc-a');
    const b = reg.hub('doc-b');
    const subA = fakeSink();
    const subB = fakeSink();
    a.subscribe(subA);
    b.subscribe(subB);

    const gateA = gatedBody();
    const gateB = gatedBody();

    expect(a.start({ kind: 'publish', run: gateA.body }).status).toBe(200);
    expect(b.start({ kind: 'sync', run: gateB.body }).status).toBe(200);

    // Both are in flight at the same instant — not one-at-a-time globally.
    expect(a.snapshot().running).toBe(true);
    expect(b.snapshot().running).toBe(true);
    expect(a.snapshot().job?.kind).toBe('publish');
    expect(b.snapshot().job?.kind).toBe('sync');

    // Subscriber sets are disjoint.
    expect(a.subscriberCount()).toBe(1);
    expect(b.subscriberCount()).toBe(1);

    // Finish A only. B must be untouched.
    gateA.release();
    await new Promise((r) => setImmediate(r));

    expect(a.snapshot().running).toBe(false);
    expect(b.snapshot().running).toBe(true);

    // No frame that reached A mentions B's job, and vice versa.
    const jobIdsIn = (sink: ReturnType<typeof fakeSink>) =>
      new Set(sink.frames.flatMap((f) => ('jobId' in f && f.jobId ? [f.jobId] : [])));
    expect([...jobIdsIn(subA)]).toEqual(['doc-a-1']);
    expect([...jobIdsIn(subB)]).toEqual(['doc-b-1']);
    expect(subA.frames.some((f) => f.type === 'job-done')).toBe(true);
    expect(subB.frames.some((f) => f.type === 'job-done')).toBe(false);

    // Event logs do not bleed.
    expect(a.snapshot().events.every((e) => e.jobId === 'doc-a-1')).toBe(true);
    expect(b.snapshot().events.every((e) => e.jobId === 'doc-b-1')).toBe(true);

    gateB.release();
    await new Promise((r) => setImmediate(r));
  });

  it('a failure in one document does not move another document’s lifecycle state', async () => {
    const reg = registry();
    const a = reg.hub('doc-a');
    const b = reg.hub('doc-b');

    b.start({ kind: 'create', run: bodyReaching('pr-open') });
    a.start({ kind: 'publish', run: async () => { throw new Error('boom'); } });
    await new Promise((r) => setImmediate(r));

    expect(a.snapshot().state).toBe('failed');
    expect(b.snapshot().state).toBe('pr-open');
  });
});

describe('job kinds and bodies (R-8.3)', () => {
  it('accepts an injected body for every lifecycle job kind', async () => {
    const reg = registry();
    const all = ['create', 'commit', 'sync', 'remap', 'resolve', 'publish', 'merge'] as const;
    const seen: string[] = [];

    for (const kind of all) {
      const hub = reg.hub(`doc-${kind}`);
      const res = hub.start({ kind, run: async (ctx) => { seen.push(ctx.kind); } });
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(hub.snapshot().job).toMatchObject({ kind, ok: true });
    }
    expect(seen).toEqual([...all]);
  });

  it('hands the body a context scoped to its own document and job', async () => {
    const clock = fakeClock(500);
    const reg = createJobHubRegistry({ now: clock.now });
    const hub = reg.hub('doc-a');
    let captured: { documentId: string; jobId: string; now: number; key?: string } | null = null;

    hub.start({
      kind: 'commit',
      idempotencyKey: 'k-1',
      run: async (ctx) => {
        captured = { documentId: ctx.documentId, jobId: ctx.jobId, now: ctx.now(), key: ctx.idempotencyKey };
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(captured).toEqual({ documentId: 'doc-a', jobId: 'doc-a-1', now: 500, key: 'k-1' });
  });

  it('a body’s logs and state changes fan out to subscribers (R-8.2)', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const sub = fakeSink();
    hub.subscribe(sub);

    hub.start({
      kind: 'create',
      run: async (ctx) => {
        ctx.log('creating branch');
        ctx.setState('pr-open');
        ctx.log('nope', 'error');
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(kinds(sub.frames)).toEqual(['sync', 'job-start', 'log', 'state', 'log', 'job-done']);
    expect(sub.head?.['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(hub.snapshot().state).toBe('pr-open');
  });

  it('a rejecting body produces job-error then a failed job-done', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const sub = fakeSink();
    hub.subscribe(sub);

    hub.start({ kind: 'publish', run: async () => { throw new Error('blob mismatch'); } });
    await new Promise((r) => setImmediate(r));

    const err = sub.frames.find((f) => f.type === 'job-error');
    expect(err).toMatchObject({ kind: 'publish', message: 'blob mismatch' });
    expect(sub.frames.at(-1)).toMatchObject({ type: 'job-done', ok: false, state: 'failed' });
  });

  it('carries an idempotency token through to the job-start frame and the snapshot (R-8.23 shape only)', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const sub = fakeSink();
    hub.subscribe(sub);

    hub.start({ kind: 'create', run: bodyReaching('pr-open'), idempotencyKey: 'tok-42' });
    await new Promise((r) => setImmediate(r));

    expect(sub.frames.find((f) => f.type === 'job-start')).toMatchObject({ idempotencyKey: 'tok-42' });
    expect(hub.snapshot().job?.idempotencyKey).toBe('tok-42');
  });

  it('omits idempotencyKey entirely when none is supplied', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    hub.start({ kind: 'sync', run: bodyReaching() });
    await new Promise((r) => setImmediate(r));
    expect(hub.snapshot().job).not.toHaveProperty('idempotencyKey');
  });
});

describe('concurrency within one document', () => {
  it('rejects a second job with 409 rather than queueing it', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const gate = gatedBody();
    let secondRan = false;

    expect(hub.start({ kind: 'publish', run: gate.body }).status).toBe(200);
    const second = hub.start({ kind: 'sync', run: async () => { secondRan = true; } });

    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: 'a publish is already running for doc-a' });

    gate.release();
    await new Promise((r) => setImmediate(r));

    // Rejected, not deferred: the body was never invoked, even after the slot freed.
    expect(secondRan).toBe(false);
    expect(hub.snapshot().running).toBe(false);

    // The slot is reusable once the first job settled.
    expect(hub.start({ kind: 'sync', run: bodyReaching() }).status).toBe(200);
  });

  it('cancel aborts the running body’s signal and marks the job-done cancelled', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    let aborted = false;
    const gate = gatedBody();

    hub.start({
      kind: 'sync',
      run: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          gate.release();
        });
        await gate.body(ctx);
      },
    });

    expect(hub.cancel().status).toBe(200);
    await new Promise((r) => setImmediate(r));

    expect(aborted).toBe(true);
    expect(hub.snapshot().events.at(-1)).toMatchObject({ type: 'job-done', cancelled: true });
  });

  it('cancel with nothing running is a 409', () => {
    const reg = registry();
    expect(reg.hub('doc-a').cancel().status).toBe(409);
  });
});

describe('late subscriber recovery (R-8.4)', () => {
  it('replays the full history and current state to a subscriber that attaches after the job finished', async () => {
    const clock = fakeClock(100);
    const reg = createJobHubRegistry({ now: clock.now });
    const hub = reg.hub('doc-a');

    hub.start({
      kind: 'create',
      run: async (ctx) => {
        ctx.log('creating branch');
        ctx.setState('pr-open');
      },
    });
    await new Promise((r) => setImmediate(r));

    // Nobody was listening while it ran.
    const late = fakeSink();
    hub.subscribe(late);

    const sync = late.frames[0] as JobSync;
    expect(sync.type).toBe('sync');
    expect(sync.running).toBe(false);
    expect(sync.state).toBe('pr-open');
    expect(sync.job).toMatchObject({ kind: 'create', ok: true, startedAt: 100, finishedAt: 100 });
    expect(kinds(sync.events)).toEqual(['job-start', 'log', 'state', 'job-done']);
    expect(sync.droppedEvents).toBe(0);
  });

  it('replays mid-run so a tab joining late sees the same activity as one that was there', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const early = fakeSink();
    hub.subscribe(early);

    const gate = gatedBody();
    hub.start({ kind: 'publish', run: async (ctx) => { ctx.log('committing'); await gate.body(ctx); } });
    await new Promise((r) => setImmediate(r));

    const late = fakeSink();
    hub.subscribe(late);
    const sync = late.frames[0] as JobSync;
    expect(sync.running).toBe(true);
    expect(kinds(sync.events)).toEqual(kinds(early.frames.slice(1)));

    gate.release();
    await new Promise((r) => setImmediate(r));

    // From here both see the same live frames.
    expect(kinds(late.frames.slice(1))).toEqual(['job-done']);
    expect(early.frames.at(-1)).toEqual(late.frames.at(-1));
  });

  it('status() is the same snapshot in route form', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    hub.start({ kind: 'merge', run: bodyReaching('merged') });
    await new Promise((r) => setImmediate(r));

    expect(hub.status()).toEqual({ status: 200, json: hub.snapshot() });
    expect(hub.snapshot().state).toBe('merged');
  });

  it('a fresh document reports draft with no job', () => {
    const snap = registry().hub('doc-a').snapshot();
    expect(snap).toEqual({ documentId: 'doc-a', state: 'draft', running: false, job: null, events: [], droppedEvents: 0 });
  });

  it('snapshot is a copy — mutating it does not corrupt the hub', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    hub.start({ kind: 'sync', run: bodyReaching('pr-open') });
    await new Promise((r) => setImmediate(r));

    const snap = hub.snapshot();
    snap.events.length = 0;
    if (snap.job) snap.job.kind = 'merge';

    expect(hub.snapshot().events.length).toBeGreaterThan(0);
    expect(hub.snapshot().job?.kind).toBe('sync');
  });

  it('a closed subscriber stops receiving frames and is dropped from the set', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const sub = fakeSink();
    hub.subscribe(sub);
    expect(hub.subscriberCount()).toBe(1);

    sub.close();
    expect(hub.subscriberCount()).toBe(0);

    hub.start({ kind: 'sync', run: bodyReaching() });
    await new Promise((r) => setImmediate(r));
    expect(kinds(sub.frames)).toEqual(['sync']);
  });
});

describe('event-log bound', () => {
  it('drops the oldest frames past maxEvents and counts them, keeping state recoverable', async () => {
    const reg = createJobHubRegistry({ now: fakeClock().now, maxEvents: 5 });
    const hub = reg.hub('doc-a');

    hub.start({
      kind: 'sync',
      run: async (ctx) => {
        ctx.setState('pr-open');
        for (let i = 0; i < 20; i += 1) ctx.log(`row ${i}`);
      },
    });
    await new Promise((r) => setImmediate(r));

    const snap = hub.snapshot();
    expect(snap.events).toHaveLength(5);
    expect(snap.droppedEvents).toBe(18); // 1 start + 1 state + 20 logs + 1 done = 23
    expect(snap.events.at(-1)?.type).toBe('job-done');

    // R-8.4 still holds: state / running / job never lived in the trimmed log.
    expect(snap.state).toBe('pr-open');
    expect(snap.running).toBe(false);
    expect(snap.job).toMatchObject({ kind: 'sync', ok: true });

    const late = fakeSink();
    hub.subscribe(late);
    expect(late.frames[0]).toMatchObject({ type: 'sync', state: 'pr-open', droppedEvents: 18 });
  });

  it('the log is bounded across many jobs, not just within one', async () => {
    const reg = createJobHubRegistry({ now: fakeClock().now, maxEvents: 4 });
    const hub = reg.hub('doc-a');

    for (let i = 0; i < 30; i += 1) {
      hub.start({ kind: 'sync', run: bodyReaching('pr-open') });
      await new Promise((r) => setImmediate(r));
    }

    expect(hub.snapshot().events).toHaveLength(4);
    expect(hub.snapshot().droppedEvents).toBe(86); // 30 jobs x 3 frames - 4 retained
  });
});

describe('disposal', () => {
  it('dispose removes the entry so the registry does not leak per-document state', () => {
    const reg = registry();
    reg.hub('doc-a');
    reg.hub('doc-b');

    reg.dispose('doc-a');
    expect(reg.documentIds()).toEqual(['doc-b']);
    expect(reg.peek('doc-a')).toBeUndefined();

    // A later request for the same id gets a FRESH hub, not the disposed one.
    expect(reg.hub('doc-a')).not.toBe(reg.peek('doc-b'));
    expect(reg.hub('doc-a').snapshot().state).toBe('draft');
  });

  it('dispose of an unknown documentId is a no-op', () => {
    const reg = registry();
    expect(() => reg.dispose('doc-nope')).not.toThrow();
  });

  it('dispose aborts the running job and ends every subscriber', async () => {
    const reg = registry();
    const hub = reg.hub('doc-a');
    const sub = fakeSink();
    hub.subscribe(sub);

    let aborted = false;
    const gate = gatedBody();
    hub.start({
      kind: 'publish',
      run: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          gate.release();
        });
        await gate.body(ctx);
      },
    });

    reg.dispose('doc-a');
    await new Promise((r) => setImmediate(r));

    expect(aborted).toBe(true);
    expect(sub.ended()).toBe(true);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('disposeAll clears the whole registry', () => {
    const reg = registry();
    reg.hub('doc-a');
    reg.hub('doc-b');
    reg.disposeAll();
    expect(reg.documentIds()).toEqual([]);
  });
});

/* ================================================================== *
 * R-8.6 — the hub reports who is watching
 *
 * The hub takes no view of what a subscriber count *means*; it reports every change so
 * 7.2 can drive the interval poller off it. What is guarded here is that the report is
 * accurate — no missed drop to zero, no phantom change — because a missed edge either
 * leaves a poller running for a document nobody is watching or kills one that is.
 * ================================================================== */
describe('subscriber-count notifications (R-8.6)', () => {
  const observe = (reg: JobHubRegistry) => {
    const seen: Array<[string, number]> = [];
    reg.onWatchersChanged((documentId, count) => seen.push([documentId, count]));
    return seen;
  };

  it('reports the rise to one and the fall back to zero, per document', () => {
    const reg = registry();
    const seen = observe(reg);
    const hub = reg.hub('doc-a');

    const sub = fakeSink();
    hub.subscribe(sub);
    expect(seen).toEqual([['doc-a', 1]]);

    sub.close();
    expect(seen).toEqual([
      ['doc-a', 1],
      ['doc-a', 0],
    ]);
  });

  it('reports each intermediate count, so a poller is stopped only on the last departure', () => {
    const reg = registry();
    const seen = observe(reg);
    const hub = reg.hub('doc-a');

    const first = fakeSink();
    const second = fakeSink();
    hub.subscribe(first);
    hub.subscribe(second);
    first.close();

    // The `1` after the `2` is the whole point: one tab closed, one is still watching.
    expect(seen.map(([, n]) => n)).toEqual([1, 2, 1]);
    expect(hub.subscriberCount()).toBe(1);
  });

  it('reports a re-attach, so polling can resume for a reopened tab', () => {
    const reg = registry();
    const seen = observe(reg);
    const hub = reg.hub('doc-a');

    const before = fakeSink();
    hub.subscribe(before);
    before.close();
    hub.subscribe(fakeSink());

    expect(seen.map(([, n]) => n)).toEqual([1, 0, 1]);
  });

  it('stays silent when nothing actually changed', () => {
    const reg = registry();
    const seen = observe(reg);
    const hub = reg.hub('doc-a');

    const sub = fakeSink();
    hub.subscribe(sub);
    hub.subscribe(sub); // same sink twice — the set is unchanged
    expect(seen.map(([, n]) => n)).toEqual([1]);

    sub.close();
    sub.close(); // already gone — must not read as a second departure
    expect(seen.map(([, n]) => n)).toEqual([1, 0]);
  });

  it('announces the drop to zero on dispose, since ending sinks runs no close handler', () => {
    const reg = registry();
    const seen = observe(reg);
    const hub = reg.hub('doc-a');
    hub.subscribe(fakeSink());

    hub.dispose();
    expect(seen).toEqual([
      ['doc-a', 1],
      ['doc-a', 0],
    ]);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('says nothing when a document with no subscribers is disposed', () => {
    const reg = registry();
    const seen = observe(reg);
    reg.hub('doc-a').dispose();
    expect(seen).toEqual([]);
  });

  it('keeps documents apart, including hubs created before the listener was registered', () => {
    const reg = registry();
    const early = reg.hub('doc-a'); // exists before `onWatchersChanged` is called
    const seen = observe(reg);
    const late = reg.hub('doc-b');

    const a = fakeSink();
    early.subscribe(a);
    late.subscribe(fakeSink());
    a.close();

    expect(seen).toEqual([
      ['doc-a', 1],
      ['doc-b', 1],
      ['doc-a', 0],
    ]);
  });
});
