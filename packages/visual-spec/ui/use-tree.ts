/**
 * use-tree.ts — browser hooks for the generic directory API (Phase 3).
 *   useTree()      → the whole visible tree (dirs + files) from /__vs/tree
 *   useFile(path)  → one file's content/metadata from /__vs/tree/file
 */
import { useCallback, useEffect, useState } from 'react';

export type FileKind = 'markdown' | 'code' | 'text' | 'image' | 'binary';

export type TreeEntry = {
  path: string;
  name: string;
  type: 'dir' | 'file';
  kind?: FileKind;
  size?: number;
};

export type FileContent =
  | { path: string; kind: 'markdown' | 'code' | 'text'; content: string; size: number }
  | { path: string; kind: 'image'; mime: string; size: number }
  | { path: string; kind: 'binary'; size: number; reason?: 'binary' | 'too-large' };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Shared, short-lived tree cache. The sidebar plus the image modal's folder and
// workspace pickers all call useTree() at once; without this each mount fired its
// own full /__vs/tree walk. Consumers within the TTL share a single in-flight (or
// just-resolved) promise. Call invalidateTree() after anything that changes the
// tree (e.g. an upload) so the next read re-fetches.
const TREE_TTL_MS = 5000;
let treeCache: { at: number; promise: Promise<TreeEntry[]> } | null = null;

function fetchTree(): Promise<TreeEntry[]> {
  const now = Date.now();
  if (treeCache && now - treeCache.at < TREE_TTL_MS) return treeCache.promise;
  const promise = fetch('/__vs/tree')
    .then((r) => json<TreeEntry[]>(r))
    .catch((err) => {
      // Don't let a failed fetch poison the cache for the whole TTL.
      if (treeCache?.promise === promise) treeCache = null;
      throw err;
    });
  treeCache = { at: now, promise };
  return promise;
}

/** Drop the cached tree so the next useTree() read re-walks the directory. */
export function invalidateTree(): void {
  treeCache = null;
}

/**
 * `reload` hands back the entries it re-read, as well as pushing them into the hook's
 * own state. R-6.8 needs both: the sidebar has to show the new branch's tree, and the
 * caller has to know whether the file it had open is still in it — a question the
 * hook's state cannot answer, because reading it after `reload()` returns the tree
 * from *before* the render that replaces it.
 *
 * The two reads are one request. `fetchTree` shares its in-flight promise for the
 * length of the TTL, so the effect below joins the call made here rather than issuing
 * a second walk.
 */
export function useTree(): { entries: TreeEntry[]; loading: boolean; reload: () => Promise<TreeEntry[]> } {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped by reload(). invalidateTree() alone only clears the cache — a mounted
  // consumer never re-reads, so a file created from the tree would stay missing
  // from the sidebar until something else remounted the hook.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    fetchTree()
      .then((e) => live && setEntries(e))
      .catch(() => live && setEntries([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [generation]);
  const reload = useCallback(() => {
    setGeneration((g) => g + 1);
    return fetchTree();
  }, []);
  return { entries, loading, reload };
}

export function useFile(path: string, kind?: FileKind): { file: FileContent | null; loading: boolean } {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    // Images are shown via /__vs/raw, no content fetch needed.
    if (!path || kind === 'image') {
      setFile(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/__vs/tree/file?path=${encodeURIComponent(path)}`)
      .then((r) => json<FileContent>(r))
      .then(setFile)
      .catch(() => setFile(null))
      .finally(() => setLoading(false));
  }, [path, kind]);
  return { file, loading };
}

export const rawUrl = (path: string): string => `/__vs/raw?path=${encodeURIComponent(path)}`;
