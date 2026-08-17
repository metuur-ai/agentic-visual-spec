/**
 * use-comments.ts — browser hook for the sidecar /__vs/comments API. Used by the
 * markdown viewer. Optimistic-then-refetch.
 *
 * ONE CACHE PER QUERY, NOT ONE PER CALLER.
 *
 * This used to hold the records in `useState`, which meant every call site had its own
 * copy, its own request, and its own listeners. On an ordinary markdown screen five of
 * them are mounted at once — the sidebar and the header's cart on the unfiltered list,
 * the comment panel, the indicator layer and the doc editor on the open file — so a
 * single `add()` fired five requests and five unrelated render cascades. Alt-tabbing
 * back to the window did the same, because the focus refetch installed a fresh array
 * identity whether or not the file on disk had changed.
 *
 * The records are server state: one authority, many readers. So they live in a module
 * store keyed by the query, de-duplicating the request and replacing the array only when
 * the content actually differs, and readers subscribe through `useSyncExternalStore`.
 * Five readers now cost two requests — one per distinct query — and a refetch that finds
 * nothing new costs zero renders.
 *
 * The query stays `?path=`, per R-10.5: what the browser asks the sidecar is a pinned
 * surface, and filtering an unfiltered list here instead would change it.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { CommentRecord, CommentTargetKind } from '../../editing/comment-doc';
import type { SpecDialect } from '../../editing/specs';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type NewComment = {
  path: string;
  kind?: CommentTargetKind;
  workflow?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  endSnippet?: string;
  heading?: string | null;
  selectedContent?: string;
  comment: string;
  dialect?: SpecDialect;
  spec?: string;
};

export type UseComments = {
  comments: CommentRecord[];
  add: (c: NewComment) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refetch: () => void;
};

const EMPTY: CommentRecord[] = [];

/**
 * One entry per distinct query — `''` is the unfiltered list, anything else is a path.
 *
 * `records` is the identity `getSnapshot` hands React, so it is replaced only when the
 * content changes; returning a fresh array on every read would re-render forever.
 */
type Entry = { records: CommentRecord[]; inflight: Promise<void> | null; watchers: Set<() => void> };
const entries = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { records: EMPTY, inflight: null, watchers: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

/**
 * Read one query, sharing a single request across concurrent callers.
 *
 * The equality check is the point of the whole exercise: this runs on window focus and
 * after every mutation anywhere in the app, and without it each of those installs a new
 * array identity and re-renders every reader over identical data. Serialising is coarse,
 * but the sidecar is a hand-written review file, not a feed — comparing it costs far
 * less than one wasted reconcile of the file tree.
 */
function load(path: string): Promise<void> {
  const entry = entryFor(path);
  if (entry.inflight) return entry.inflight;
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  entry.inflight = fetch(`/__vs/comments${q}`)
    .then((r) => json<CommentRecord[]>(r))
    .catch(() => EMPTY)
    .then((next) => {
      if (JSON.stringify(next) === JSON.stringify(entry.records)) return;
      entry.records = next;
      for (const watch of entry.watchers) watch();
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

/** Anything currently on screen re-reads; queries nobody is watching stay untouched. */
function loadWatched(): void {
  for (const [key, entry] of entries) if (entry.watchers.size > 0) void load(key);
}

/**
 * The window listeners live with the store rather than with each hook, installed while
 * anything is reading and dropped when nothing is.
 *
 * The focus/visibility reads are here for the reason they always were: the
 * apply-comments skill edits the sidecar JSON on disk with no in-app event, so a
 * returning user should see the just-applied comments drop off the list without a
 * manual reload.
 */
const onChanged = () => loadWatched();
const onFocus = () => {
  if (document.visibilityState !== 'hidden') loadWatched();
};

let listening = 0;

function subscribeTo(key: string): (watch: () => void) => () => void {
  return (watch) => {
    if (listening === 0) {
      window.addEventListener('vs:comments-changed', onChanged);
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onFocus);
    }
    listening += 1;
    const entry = entryFor(key);
    entry.watchers.add(watch);
    // Every mount reads, as it always did. Concurrent mounts on the same query share
    // one request, and a read that finds nothing new notifies nobody — so a second
    // reader of a query already on screen is a request, not a render.
    void load(key);
    return () => {
      entry.watchers.delete(watch);
      listening -= 1;
      if (listening > 0) return;
      window.removeEventListener('vs:comments-changed', onChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  };
}

/** Test seam: drop every cached query so the next reader re-reads the sidecar. */
export function resetCommentsCache(): void {
  entries.clear();
}

const fire = () => window.dispatchEvent(new CustomEvent('vs:comments-changed'));

export function useComments(path?: string): UseComments {
  const key = path ?? '';
  const comments = useSyncExternalStore(
    useCallback(subscribeTo(key), [key]),
    useCallback(() => entryFor(key).records, [key]),
    () => EMPTY,
  );

  const add = useCallback(async (c: NewComment) => {
    await fetch('/__vs/comments/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c),
    });
    fire();
  }, []);

  const remove = useCallback(async (id: string) => {
    await fetch(`/__vs/comments/${id}`, { method: 'DELETE' });
    fire();
  }, []);

  const refetch = useCallback(() => void load(key), [key]);

  return { comments, add, remove, refetch };
}
