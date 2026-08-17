/**
 * active-comment.tsx — the "active comment" state that lets an inline indicator
 * (document side) drive the sidebar (comment list). This is the inverse of
 * locate() (sidebar → document); clicking an indicator sets the active id, and
 * the comment list scrolls to and highlights that row.
 *
 * Scoped per editor (markdown / generic) so the document and its sidebar share
 * one context without a global store.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

type ActiveCommentCtx = {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
};

const Ctx = createContext<ActiveCommentCtx>({ activeId: null, setActiveId: () => {} });

export function ActiveCommentProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const value = useMemo(() => ({ activeId, setActiveId }), [activeId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveComment(): ActiveCommentCtx {
  return useContext(Ctx);
}
