/**
 * selection-reporter.tsx — the deictic bridge. Posts the current surface/page/
 * selection to the dev server over HMR; current-plugin writes current.json so an
 * agent can resolve "this element" without a marker.
 */
import { useEffect } from 'react';
import { useInspector } from './inspector-provider';

export function SelectionReporter() {
  const { surfaceId, pageIndex, selected } = useInspector();

  useEffect(() => {
    const selection = selected
      ? {
          line: selected.line,
          column: selected.column,
          tagName: selected.anchor.tagName.toLowerCase(),
          text: (selected.anchor.textContent ?? '').trim().slice(0, 120),
        }
      : null;
    import.meta.hot?.send('visual-spec:current', { surfaceId, pageIndex, selection });
  }, [surfaceId, pageIndex, selected]);

  return null;
}
