/**
 * source-editor.tsx — a CodeMirror 6 markdown source editor with a small format
 * toolbar. Owns the EditorView; reports edits via onChange and Cmd/Ctrl+S via
 * onSave (both read through refs so the view is created once and never rebuilt).
 * Fidelity-first: this edits the raw .md bytes — no normalization.
 */
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { useEffect, useRef } from 'react';

/** Wrap the current selection with `before`/`after` (bold, italic, inline code). */
function wrapSelection(view: EditorView, before: string, after = before) {
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    })),
  );
  view.focus();
}

/** Prefix every line touched by the selection with `prefix` (heading, list, quote). */
function prefixLines(view: EditorView, prefix: string) {
  const { state } = view;
  const changes: { from: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      changes.push({ from: state.doc.line(n).from, insert: prefix });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

/** Turn the selection into a [text](url) link, cursor parked in the url slot. */
function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || 'text';
      const insert = `[${text}](url)`;
      const urlAt = range.from + text.length + 3; // after "[text]("
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlAt, urlAt + 3),
      };
    }),
  );
  view.focus();
}

type ToolAction = (view: EditorView) => void;
const TOOLS: { label: string; title: string; run: ToolAction }[] = [
  { label: 'B', title: 'Bold (**)', run: (v) => wrapSelection(v, '**') },
  { label: 'I', title: 'Italic (*)', run: (v) => wrapSelection(v, '*') },
  { label: '`', title: 'Inline code', run: (v) => wrapSelection(v, '`') },
  { label: 'H', title: 'Heading', run: (v) => prefixLines(v, '# ') },
  { label: '•', title: 'Bullet list', run: (v) => prefixLines(v, '- ') },
  { label: '1.', title: 'Numbered list', run: (v) => prefixLines(v, '1. ') },
  { label: '❝', title: 'Quote', run: (v) => prefixLines(v, '> ') },
  { label: '🔗', title: 'Link', run: insertLink },
];

export function SourceEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest callbacks, read inside CM extensions so the view is built once.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Build the editor once.
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown(),
          EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (onSaveRef.current(), true) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", monospace', lineHeight: '1.6' },
            '.cm-content': { padding: '12px 0' },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
      parent: host.current!,
    });
    viewRef.current = view;
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt external value changes (e.g. an external edit while not dirty) without
  // resetting the cursor when the change originated here.
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div style={wrap}>
      <div style={toolbar}>
        {TOOLS.map((t) => (
          <button
            key={t.label}
            type="button"
            title={t.title}
            onMouseDown={(e) => e.preventDefault()} // keep editor focus/selection
            onClick={() => viewRef.current && t.run(viewRef.current)}
            style={toolBtn}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />
    </div>
  );
}

const wrap: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'white' };
const toolbar: React.CSSProperties = { display: 'flex', gap: 4, padding: '6px 10px', borderBottom: '1px solid #e5e7eb', background: '#fbfaff', flexShrink: 0 };
const toolBtn: React.CSSProperties = { minWidth: 26, height: 26, padding: '0 6px', border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: '600 12px system-ui' };
