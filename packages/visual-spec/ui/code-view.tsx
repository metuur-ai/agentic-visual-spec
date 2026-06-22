/**
 * code-view.tsx — line-numbered viewer for code/text files. Click a line to
 * select it; Shift+click another to select the range. Reports the selection
 * (1-indexed lines + snippets) up so the comment panel can anchor to it.
 */
import { useMemo, useRef } from 'react';

export type LineSelection = {
  startLine: number;
  endLine: number;
  snippet: string;
  endSnippet: string;
};

export function CodeView({
  content,
  selection,
  onSelect,
}: {
  content: string;
  selection: LineSelection | null;
  onSelect: (s: LineSelection | null) => void;
}) {
  const lines = useMemo(() => content.replace(/\n$/, '').split('\n'), [content]);
  const anchor = useRef<number | null>(null);

  const pick = (n: number, shift: boolean) => {
    if (shift && anchor.current != null) {
      const a = anchor.current;
      const start = Math.min(a, n);
      const end = Math.max(a, n);
      onSelect({
        startLine: start,
        endLine: end,
        snippet: (lines[start - 1] ?? '').trim().slice(0, 160),
        endSnippet: (lines[end - 1] ?? '').trim().slice(0, 160),
      });
      return;
    }
    anchor.current = n;
    const snip = (lines[n - 1] ?? '').trim().slice(0, 160);
    onSelect({ startLine: n, endLine: n, snippet: snip, endSnippet: snip });
  };

  const inSel = (n: number) => selection != null && n >= selection.startLine && n <= selection.endLine;

  return (
    <pre style={pre}>
      <code style={{ display: 'block' }}>
        {lines.map((line, i) => {
          const n = i + 1;
          const sel = inSel(n);
          return (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              data-line={n}
              onClick={(e) => pick(n, e.shiftKey)}
              style={{ ...rowStyle, ...(sel ? rowSel : {}) }}
            >
              <span style={{ ...gutter, ...(sel ? gutterSel : {}) }}>{n}</span>
              <span style={code}>{line || '​'}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

const pre: React.CSSProperties = {
  margin: 0,
  padding: '12px 0',
  background: 'white',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'auto',
  font: '12.5px/1.6 ui-monospace, "SF Mono", monospace',
};
const rowStyle: React.CSSProperties = { display: 'flex', cursor: 'pointer', whiteSpace: 'pre' };
const rowSel: React.CSSProperties = { background: 'rgba(59,130,246,0.12)' };
const gutter: React.CSSProperties = {
  flexShrink: 0,
  width: '3.4em',
  paddingRight: '1em',
  textAlign: 'right',
  color: '#94a3b8',
  userSelect: 'none',
};
const gutterSel: React.CSSProperties = { color: '#2563eb', fontWeight: 700 };
const code: React.CSSProperties = { paddingRight: 16, color: '#0f172a' };
