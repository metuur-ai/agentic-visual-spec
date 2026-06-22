/**
 * use-comments.ts — browser hook for the sidecar /__vs/comments API. Used by the
 * markdown viewer. Optimistic-then-refetch.
 */
import { useCallback, useEffect, useState } from 'react';
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

export function useComments(path?: string): UseComments {
  const [comments, setComments] = useState<CommentRecord[]>([]);

  const refetch = useCallback(() => {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    fetch(`/__vs/comments${q}`)
      .then((r) => json<CommentRecord[]>(r))
      .then(setComments)
      .catch(() => setComments([]));
  }, [path]);

  // Keep every useComments() instance (e.g. the panel + the header cart) in sync.
  // Also refetch on window focus / tab visibility: the apply-comments skill edits
  // the sidecar JSON on disk (no in-app event), so a returning user should see the
  // just-applied comments drop off the list without a manual reload.
  useEffect(() => {
    refetch();
    const onChanged = () => refetch();
    const onFocus = () => { if (document.visibilityState !== 'hidden') refetch(); };
    window.addEventListener('vs:comments-changed', onChanged);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('vs:comments-changed', onChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refetch]);

  const fire = () => window.dispatchEvent(new CustomEvent('vs:comments-changed'));

  const add = useCallback(
    async (c: NewComment) => {
      await fetch('/__vs/comments/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c),
      });
      fire();
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/__vs/comments/${id}`, { method: 'DELETE' });
      fire();
    },
    [],
  );

  return { comments, add, remove, refetch };
}
