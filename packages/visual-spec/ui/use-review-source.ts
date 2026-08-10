/**
 * use-review-source.ts — how a review reads its files, whichever source supplies them.
 *
 * WHY THIS EXISTS BESIDE `use-tree.ts` RATHER THAN INSIDE IT. `useTree` fetches
 * `/__vs/tree`, which is a flat walk of the *whole* served directory, cached and shared.
 * That contract is right for the local file browser — the served directory is the user's
 * own project and the sidebar shows all of it — and it is the shipped product, so it is
 * left exactly as it is.
 *
 * It is the wrong contract for a review. A `ReviewSource` answers one directory per call
 * and is never recursive, deliberately: the checkout side would walk a subtree nobody
 * asked for, and the host side has no recursive endpoint at all — a full walk over the
 * wire is one round trip per directory in the repository, which on anything real is
 * minutes. So the tree here is not walked; it is *expanded*. The root is read when the
 * review opens, and every other directory is read at the moment a reviewer opens it. A
 * folder nobody opens costs nothing.
 *
 * THE FLAT LIST SURVIVES, THOUGH. `FileTree` builds its nesting from a flat `TreeEntry[]`
 * in which a parent precedes its children, and that is exactly what accumulating one
 * directory's listing at a time produces: a directory can only be expanded after it has
 * appeared in its own parent's listing. So nothing about how the tree is *rendered*
 * changes — only when the entries arrive.
 *
 * IT DOES NOT KNOW WHICH SOURCE IT IS ON, AND MUST NOT. Both reads go through
 * `/__vs/collab/pulls/:n/{tree,raw}`, which read through the `ReviewSource` the open
 * resolved. A checkout-backed review and a host-sourced one come through this module
 * identically; there is no branch on `review.source` here or above it (R-W1.4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CollabClient, ReviewEntry } from './collab-client';
import type { FileKind, TreeEntry } from './use-tree';

const MARKDOWN_EXT = new Set(['md', 'markdown']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const TEXT_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'diff', 'patch', 'rst', 'adoc']);

/**
 * What kind of file a review is about to open, from its name alone.
 *
 * The server's `detectKind` is not reachable from here — it lives in the served
 * directory's tree store and reads `node:path` — and it is answering a different
 * question anyway: it can sniff the bytes it just read, while this decides how to *ask*.
 * Only three answers change anything on the reviewing surface: Markdown is rendered,
 * an image has no text to show, and everything else goes to the code viewer. `code` is
 * the default because that is the viewer an unrecognised text file wants.
 */
export function reviewFileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'code';
}

/** One listed entry, as the tree sidebar wants it. */
function toTreeEntry(entry: ReviewEntry): TreeEntry {
  return entry.kind === 'directory'
    ? { path: entry.path, name: entry.name, type: 'dir' }
    : { path: entry.path, name: entry.name, type: 'file', kind: reviewFileKind(entry.name) };
}

/**
 * What a 200 that is not the shape the route promised is called on screen.
 *
 * `CollabClient.call` casts the parsed body to the route's type without reading it, so
 * "the request succeeded" and "the body is a listing" are separate facts and only the
 * first one is checked there. A proxy interstitial, a dev-server HTML fallback, a route
 * whose shape moves — each arrives here as `res.ok` with nothing to map. Before this, the
 * mapping threw inside a React state updater; nothing above the reviewing surface catches
 * that, so the reviewer got a blank page rather than any of the sentences R-11.4 and
 * R-W2.7 went to the trouble of writing.
 *
 * The wording sits in R-W2.7's middle bucket on purpose: this is not a missing credential
 * and not an unreachable host, it is a read that came back unusable. There is no server
 * sentence to quote — the server is exactly what is in doubt — so the module supplies one
 * and sends it down the same `setError` path as every other failed read.
 */
const unreadableBody = (what: 'folder' | 'file') =>
  `This ${what} could not be read — the server answered something this review could not understand.`;

export type ReviewTree = {
  /** Every entry read so far, parents before children. Grows as directories are opened. */
  entries: TreeEntry[];
  /** Ask for one directory's contents. Reads it once; later calls for it do nothing. */
  expand: (path: string) => void;
  /** The directories whose listing is in flight, so a row can say it is reading. */
  pending: Set<string>;
  /** True until the root listing has answered, and again while a reload runs. */
  loading: boolean;
  /** The server's own sentence for the last listing that failed (R-11.4). */
  error: string | null;
  /** Re-read every directory that is currently open, in place. */
  reload: () => void;
};

/**
 * The review's tree, one directory at a time.
 *
 * The root is read on mount because a tree with no root has nothing to click. Everything
 * below it waits for a reviewer.
 */
export function useReviewTree(client: CollabClient, pullNumber: number): ReviewTree {
  // Insertion-ordered by directory: the root's listing lands first, and a directory's own
  // listing can only land after the listing that named it. Flattening therefore yields
  // parents before children, which is what `buildTree` needs.
  const [byDir, setByDir] = useState<Map<string, TreeEntry[]>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Which directories have been asked for. A ref and not state, because two expand calls
  // can land in one React batch and a state read would still be empty on the second —
  // which is how one folder becomes two requests.
  const asked = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (path: string): Promise<void> => {
      if (asked.current.has(path)) return;
      asked.current.add(path);
      setPending((prev) => new Set(prev).add(path));
      const res = await client.pullRequestTree(pullNumber, path);
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      if (!res.ok) {
        // Forget it, so closing the folder and opening it again is a retry rather than a
        // permanently empty branch.
        asked.current.delete(path);
        setError(res.message);
        return;
      }
      // Checked out here, before the state updater, and not inside it. An updater runs
      // during React's own work; a throw in there takes the whole surface down, whereas a
      // failure recognised out here is just another failed listing.
      const entries = (res.value as { entries?: unknown } | null)?.entries;
      if (!Array.isArray(entries)) {
        // Forgotten for the same reason a route failure is: reopening the folder retries.
        asked.current.delete(path);
        setError(unreadableBody('folder'));
        return;
      }
      setError(null);
      setByDir((prev) => {
        const next = new Map(prev);
        // `set` on an existing key keeps its original position, so a re-read cannot move
        // a directory ahead of its own parent.
        next.set(path, (entries as ReviewEntry[]).map(toTreeEntry));
        return next;
      });
    },
    [client, pullNumber],
  );

  useEffect(() => {
    asked.current = new Set();
    setByDir(new Map());
    void load('');
  }, [load]);

  const reload = useCallback(() => {
    const open = [...asked.current];
    asked.current = new Set();
    for (const path of open) void load(path);
  }, [load]);

  const entries = useMemo(() => [...byDir.values()].flat(), [byDir]);
  return { entries, expand: load, pending, loading: pending.has(''), error, reload };
}

export type ReviewFileRead = {
  /** The file's text, or `null` when there is none to show yet or at all. */
  text: string | null;
  loading: boolean;
  /** Why it could not be read — the route's own sentence, which names what to do. */
  error: string | null;
};

/**
 * One file of the review, read at the pinned commit.
 *
 * A directory is not read, and neither is an image: `ReviewSource.readFile` answers
 * utf-8 text, so an image has nothing to hand over on either side. That is stated on
 * screen rather than fetched and rendered as mojibake.
 */
export function useReviewFile(client: CollabClient, pullNumber: number, entry: TreeEntry | null): ReviewFileRead {
  const path = entry && entry.type === 'file' && entry.kind !== 'image' ? entry.path : '';
  const [state, setState] = useState<ReviewFileRead>({ text: null, loading: !!path, error: null });
  useEffect(() => {
    if (!path) {
      setState({ text: null, loading: false, error: null });
      return;
    }
    let live = true;
    setState({ text: null, loading: true, error: null });
    void client.pullRequestFile(pullNumber, path).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setState({ text: null, loading: false, error: res.message });
        return;
      }
      // The same unchecked cast, one route over. This one does not throw — `undefined`
      // simply becomes the file's `text` and travels on as a string that isn't one — which
      // is worse in its own way: the viewer opens on nothing and says nothing was wrong.
      // A body with no text is a file that could not be read, and is reported as one.
      const text = (res.value as { text?: unknown } | null)?.text;
      setState(
        typeof text === 'string'
          ? { text, loading: false, error: null }
          : { text: null, loading: false, error: unreadableBody('file') },
      );
    });
    return () => {
      live = false;
    };
  }, [client, pullNumber, path]);
  return state;
}
