/**
 * use-awaiting-pulls.ts — what is waiting on *me*, as one cache the whole page shares
 * (R-A1.1 / R-A1.2, R-A4.1 … R-A4.4).
 *
 * ONE STORE, NOT ONE COPY PER COMPONENT, AND THAT IS FORCED BY THE TREE. Two surfaces
 * render this: the header chips (`main-header.tsx`) and the two sections in the pull
 * request panel (`collab-pulls-panel.tsx`, mounted from `collab-app.tsx` and
 * `collab-drawer.tsx`). Neither is an ancestor of the other — the nearest common one is
 * `App` — so there is no prop to drill and no owner to elect. Held in `useState` per
 * caller, a single tab switch would cost two reads of a route that spends a *search*
 * budget of 30 requests a minute, and two unrelated render cascades over the same
 * numbers. So it lives here, keyed by nothing because there is one query, and readers
 * subscribe through `useSyncExternalStore` — the shape `core/app/lib/use-comments.ts`
 * already uses for the comment sidecar, for the same reasons.
 *
 * THE SHARED IN-FLIGHT PROMISE *IS* R-A4.2. `focus` and `visibilitychange` both fire on
 * one tab switch, and now two trees are listening; a read already in progress absorbs
 * every caller that arrives while it runs, whichever surface they came from. That is
 * de-duplication and not a timer, so R-7.10 stands and nothing here polls.
 *
 * AVAILABILITY IS ASKED FIRST, AND THAT IS THE POINT. R-A2.9 forbids *issuing* the query
 * where collaboration is not configured, not merely hiding its answer. `GET /__vs/collab`
 * is the snapshot the rest of the collaboration UI already gates on, and an unconfigured
 * server answers it without touching GitHub at all.
 *
 * A REFRESH ASKED FOR BY HAND IS THE SAME READ (R-C3.4). `refreshAwaiting` below is an
 * export of `load` and nothing more: the panel's refresh control is just one more caller
 * arriving at a store that already knows how to have one read serve all of them.
 *
 * A FAILED READ WRITES NOTHING (R-A4.3). There is no error field here for the same
 * reason `use-collab-pulls.ts` has none: nothing renders one, and a field nothing renders
 * is a field somebody will render in place of the last number that was true.
 */
import { useSyncExternalStore } from 'react';
import { type Awaiting, type AwaitingSide, createCollabClient } from './collab-client';

/**
 * Fold a response into what is already known, per side (R-A4.3 / R-A4.4).
 *
 * A side answering `{ ok: false }` is a side that failed, and the contract is that the
 * client keeps its last value for it — so a failed side is dropped here rather than
 * written. The two sides spend different budgets and fail independently; collapsing them
 * into one "the read failed" would let a rate-limited search erase a mention count that
 * had just been read successfully.
 *
 * Returning `prev` unchanged when nothing moved is what stops a refresh from re-rendering
 * anybody. On a tab being switched back to with nothing new waiting — the common case,
 * not the rare one — this is the entire outcome of the read.
 */
export function retainedAwaiting(prev: Awaiting | null, next: Partial<Awaiting>): Awaiting {
  /*
   * `next` is typed but not trusted: it is a 200 body, and a side that is absent rather
   * than `{ ok: false }` — an older server, a proxy, a route that answered something else
   * entirely — must read as "this side said nothing", which is what a failed side already
   * means. Reaching into it unguarded would throw inside the store and take down every
   * subscriber, including the header, which is the one thing R-A4.7 forbids.
   */
  const side = (a: AwaitingSide | undefined, b: AwaitingSide | undefined): AwaitingSide =>
    a?.ok === true ? a : (b ?? { ok: false });
  const merged: Awaiting = {
    reviewRequested: side(next.reviewRequested, prev?.reviewRequested),
    mentioned: side(next.mentioned, prev?.mentioned),
  };
  // Coarse, and cheap against one wasted reconcile of the header and the panel: the two
  // sides hold at most a bounded page of numbers and titles each.
  return prev && JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged;
}

/**
 * `value` is the identity `getSnapshot` hands React, so it is replaced only when the
 * content changes — a fresh object per read would re-render every subscriber forever.
 */
type Store = {
  value: Awaiting | null;
  inflight: Promise<void> | null;
  watchers: Set<() => void>;
  /** The availability answer, once it has been given. `null` = not asked, or unanswered. */
  configured: boolean | null;
};

const store: Store = { value: null, inflight: null, watchers: new Set(), configured: null };

// Built once. `createCollabClient` resolves `fetch` at call time, so a test that stubs the
// global after this module loaded is still the one that answers.
const client = createCollabClient();

/**
 * The R-A2.9 gate, asked once and remembered.
 *
 * Only a *successful* answer is cached: a read that never reached the route did not learn
 * that collaboration is off, and caching that as `false` would leave the counts dark for
 * the rest of the page over one failed request.
 */
async function gate(): Promise<boolean> {
  if (store.configured !== null) return store.configured;
  const res = await client.availability();
  if (!res.ok) return false;
  store.configured = res.value.available;
  return store.configured;
}

/** Read once, sharing a single request with every caller that arrives while it runs. */
function load(): Promise<void> {
  if (store.inflight) return store.inflight;
  store.inflight = gate()
    .then(async (configured) => {
      if (!configured) return; // R-A2.9 — nothing is requested
      const res = await client.awaitingPullRequests();
      if (!res.ok) return; // R-A4.3 — the last known counts stay exactly as they are
      const next = retainedAwaiting(store.value, res.value);
      if (next === store.value) return; // nothing moved, so nobody is told
      store.value = next;
      for (const watch of store.watchers) watch();
    })
    .catch(() => {
      /* R-A4.7 — a read that failed in a way the client did not turn into a result is
         still just a read that failed. It may not reach a subscriber as a throw. */
    })
    .finally(() => {
      store.inflight = null;
    });
  return store.inflight;
}

/*
 * The window listeners live with the store rather than with each subscriber, installed
 * while anything is reading and dropped when nothing is. One pair for the page, not one
 * pair per mounted chip — and both events fold into the one in-flight read above.
 */
const onRefresh = () => void load();

let listening = 0;

function subscribe(watch: () => void): () => void {
  if (listening === 0) {
    window.addEventListener('focus', onRefresh);
    document.addEventListener('visibilitychange', onRefresh);
  }
  listening += 1;
  store.watchers.add(watch);
  // Every mount reads (R-A4.1). Concurrent mounts share one request, and a read that
  // finds nothing new notifies nobody — so a second subscriber costs a request at most,
  // and usually not even that.
  void load();
  return () => {
    store.watchers.delete(watch);
    listening -= 1;
    if (listening > 0) return;
    window.removeEventListener('focus', onRefresh);
    document.removeEventListener('visibilitychange', onRefresh);
  };
}

/** Stable across calls, as `useSyncExternalStore` requires: React loops otherwise. */
const getSnapshot = () => store.value;

/** Test seam: drop the cache so the next subscriber re-reads. Called from `test-setup.ts`. */
export function resetAwaitingCache(): void {
  store.value = null;
  store.inflight = null;
  store.configured = null;
  store.watchers.clear();
}

/**
 * Ask for the counts to be read again, and resolve when that read has finished (R-C3.4).
 *
 * This adds no behaviour. `load()` already returns the in-flight promise to every caller
 * that arrives while a read is running, so a refresh asked for during a `focus`-triggered
 * read is handed that same read rather than starting a second — the de-duplication R-C3.4
 * requires is the one R-A4.2 has always had, and this is only the door onto it. Nothing new
 * is coalesced here; if it were, there would be two rules to keep in step instead of one.
 *
 * IT RESOLVES, AND IT RESOLVES WITH NOTHING. A caller (the panel's refresh control, R-C3.3)
 * needs to know when to stop saying "refreshing" and start accepting a second press, which
 * is a question about *when*, not about what was read — the counts arrive through
 * `useAwaitingPulls`, and a refresh that found nothing new re-renders nobody. There is no
 * result and no rejection: a read that failed writes nothing and surfaces nothing (R-A4.3 /
 * R-C3.5), so awaiting this needs no `catch` and a settled promise means only "the read is
 * over" — never "the counts changed", and never "the counts are correct".
 */
export function refreshAwaiting(): Promise<void> {
  return load();
}

/**
 * What is waiting on this user, or `null` until the first read lands.
 *
 * A side still `{ ok: false }` is one that has never answered, which R-A1.5 renders as no
 * indicator rather than as a zero. A side that answered and later failed keeps the value
 * it last had, so this is not "the last response" — it is the last thing each side was
 * known to be.
 */
export function useAwaitingPulls(): Awaiting | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
