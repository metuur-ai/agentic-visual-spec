/**
 * inspector-provider.tsx — interaction state for the inspector: whether it's
 * active (toggled with `I`) and the currently selected target. Selection is
 * re-acquired after HMR via data-vs-loc.
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { SourceLoc } from '../../lib/inspector/fiber';

export type SelectedTarget = { line: number; column: number; anchor: HTMLElement };

type InspectorContextValue = {
  active: boolean;
  setActive: (v: boolean) => void;
  /** Selected blocks in document order. Empty when nothing is selected; length>1 is a contiguous range. */
  selection: SelectedTarget[];
  setSelection: (t: SelectedTarget[]) => void;
  /** Convenience over `selection`: the primary (first) block. */
  selected: SelectedTarget | null;
  setSelected: (t: SelectedTarget | null) => void;
  surfaceId: string;
  pageIndex: number;
};

const InspectorContext = createContext<InspectorContextValue | null>(null);

export function useInspector(): InspectorContextValue {
  const ctx = useContext(InspectorContext);
  if (!ctx) throw new Error('useInspector must be used within <InspectorProvider>');
  return ctx;
}

export function InspectorProvider({
  surfaceId,
  pageIndex,
  children,
}: {
  surfaceId: string;
  pageIndex: number;
  children: ReactNode;
}) {
  const [active, setActive] = useState(false);
  const [selection, setSelection] = useState<SelectedTarget[]>([]);
  const selected = selection[0] ?? null;
  const setSelected = useCallback((t: SelectedTarget | null) => setSelection(t ? [t] : []), []);

  // Toggle with `I` (ignoring typing in inputs); Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'i' || e.key === 'I') setActive((v) => !v);
      else if (e.key === 'Escape') setSelection([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Clear selection when the page changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setSelection([]), [pageIndex, surfaceId]);

  // Re-acquire any selected anchor whose node HMR replaced.
  useEffect(() => {
    if (selection.length === 0) return;
    const observer = new MutationObserver(() => {
      let changed = false;
      const next = selection.map((s) => {
        if (s.anchor.isConnected) return s;
        const el = document.querySelector<HTMLElement>(`[data-vs-loc="${s.line}:${s.column}"]`);
        if (el) { changed = true; return { ...s, anchor: el }; }
        return s;
      });
      if (changed) setSelection(next);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selection]);

  const value = useMemo<InspectorContextValue>(
    () => ({ active, setActive, selection, setSelection, selected, setSelected, surfaceId, pageIndex }),
    [active, selection, selected, setSelected, surfaceId, pageIndex],
  );

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function toSelected(loc: SourceLoc): SelectedTarget {
  return { line: loc.line, column: loc.column, anchor: loc.anchor };
}
