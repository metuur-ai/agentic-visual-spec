/**
 * use-tree.ts — browser hooks for the generic directory API (Phase 3).
 *   useTree()      → the whole visible tree (dirs + files) from /__vs/tree
 *   useFile(path)  → one file's content/metadata from /__vs/tree/file
 */
import { useEffect, useState } from 'react';

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

export function useTree(): { entries: TreeEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch('/__vs/tree')
      .then((r) => json<TreeEntry[]>(r))
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);
  return { entries, loading };
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
