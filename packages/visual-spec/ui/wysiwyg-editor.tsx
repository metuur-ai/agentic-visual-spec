/**
 * wysiwyg-editor.tsx — a Lexical rich-text editor over the .md buffer. Loads the
 * markdown into Lexical nodes, edits WYSIWYG, and exports back to markdown via
 * @lexical/markdown TRANSFORMERS so the file stays the source of truth.
 *
 * Fidelity note: the round-trip is normalizing (Lexical rebuilds the markdown
 * from its node tree), so saving from here rewrites formatting. Tables / mermaid
 * fences / frontmatter aren't covered by the built-in transformers yet.
 */
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { mergeRegister } from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import { useCallback, useEffect, useRef, useState } from 'react';

const THEME = {
  paragraph: 'vs-lex-p',
  quote: 'vs-lex-quote',
  heading: { h1: 'vs-lex-h1', h2: 'vs-lex-h2', h3: 'vs-lex-h3', h4: 'vs-lex-h4', h5: 'vs-lex-h5', h6: 'vs-lex-h6' },
  list: { ul: 'vs-lex-ul', ol: 'vs-lex-ol', listitem: 'vs-lex-li' },
  link: 'vs-lex-link',
  code: 'vs-lex-codeblock',
  text: {
    bold: 'vs-lex-bold',
    italic: 'vs-lex-italic',
    underline: 'vs-lex-underline',
    strikethrough: 'vs-lex-strikethrough',
    underlineStrikethrough: 'vs-lex-underline-strikethrough',
    code: 'vs-lex-code',
  },
};

const NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode];

/** Loads markdown into the editor whenever the incoming value diverges from our
 *  own last export — tagged history-merge so it neither fires onChange nor lands
 *  in the undo stack. */
function LoadMarkdownPlugin({ value, lastExport, loaded }: { value: string; lastExport: React.MutableRefObject<string | null>; loaded: React.MutableRefObject<boolean> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (value === lastExport.current) return;
    lastExport.current = value;
    editor.update(() => $convertFromMarkdownString(value, TRANSFORMERS), { tag: 'history-merge' });
    loaded.current = true;
  }, [editor, value, lastExport, loaded]);
  return null;
}

/** The formatting toolbar — mirrors the classic Lexical rich-text controls. */
function Toolbar() {
  const [editor] = useLexicalComposerContext();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [fmt, setFmt] = useState({ bold: false, italic: false, underline: false, strikethrough: false });

  const sync = useCallback(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) {
      setFmt({
        bold: sel.hasFormat('bold'),
        italic: sel.hasFormat('italic'),
        underline: sel.hasFormat('underline'),
        strikethrough: sel.hasFormat('strikethrough'),
      });
    }
  }, []);

  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(({ editorState }) => editorState.read(sync)),
        editor.registerCommand(CAN_UNDO_COMMAND, (p: boolean) => (setCanUndo(p), false), COMMAND_PRIORITY_LOW),
        editor.registerCommand(CAN_REDO_COMMAND, (p: boolean) => (setCanRedo(p), false), COMMAND_PRIORITY_LOW),
      ),
    [editor, sync],
  );

  return (
    <div style={bar}>
      <Btn title="Undo (⌘Z)" disabled={!canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
        ↺
      </Btn>
      <Btn title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>
        ↻
      </Btn>
      <Sep />
      <Btn title="Bold (⌘B)" active={fmt.bold} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')} style={{ fontWeight: 800 }}>
        B
      </Btn>
      <Btn title="Italic (⌘I)" active={fmt.italic} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')} style={{ fontStyle: 'italic', fontFamily: 'Georgia, serif' }}>
        I
      </Btn>
      <Btn title="Underline (⌘U)" active={fmt.underline} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')} style={{ textDecoration: 'underline' }}>
        U
      </Btn>
      <Btn title="Strikethrough" active={fmt.strikethrough} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')} style={{ textDecoration: 'line-through' }}>
        S
      </Btn>
      <Sep />
      <Btn title="Align left" onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left')}>
        ⇤
      </Btn>
      <Btn title="Align center" onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center')}>
        ↔
      </Btn>
      <Btn title="Align right" onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right')}>
        ⇥
      </Btn>
      <Btn title="Justify" onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify')}>
        ☰
      </Btn>
    </div>
  );
}

function Btn({ children, title, onClick, active, disabled, style }: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean; disabled?: boolean; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      style={{ ...toolBtn, ...(active ? toolBtnActive : null), ...(disabled ? { opacity: 0.35, cursor: 'default' } : null), ...style }}
    >
      {children}
    </button>
  );
}

const Sep = () => <span style={sep} />;

export function WysiwygEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  // Sentinel (null) so the first mount always loads — even when the editor
  // mounts with a buffer already populated (e.g. switching Source → Rich).
  const lastExport = useRef<string | null>(null);
  const loaded = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleChange = useCallback((editorState: EditorState) => {
    if (!loaded.current) return; // ignore pre-load fires
    editorState.read(() => {
      // Lexical omits the trailing newline; markdown files conventionally end
      // with one, so normalize to avoid a spurious final-line diff on save.
      const md = `${$convertToMarkdownString(TRANSFORMERS).replace(/\n+$/, '')}\n`;
      if (md === lastExport.current) return;
      lastExport.current = md;
      onChangeRef.current(md);
    });
  }, []);

  const initialConfig = {
    namespace: 'visual-spec',
    theme: THEME,
    nodes: NODES,
    onError: (e: Error) => {
      throw e;
    },
  };

  return (
    <div style={wrap}>
      <LexicalComposer initialConfig={initialConfig}>
        <Toolbar />
        <div style={editArea}>
          <RichTextPlugin
            contentEditable={<ContentEditable className="vs-lex-content" style={contentEditable} aria-label="Markdown document" />}
            placeholder={<div style={placeholder}>Start writing…</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <OnChangePlugin onChange={handleChange} ignoreHistoryMergeTagChange ignoreSelectionChange />
        <LoadMarkdownPlugin value={value} lastExport={lastExport} loaded={loaded} />
        <SavePlugin onSave={() => onSaveRef.current()} />
      </LexicalComposer>
      <style>{LEX_CSS}</style>
    </div>
  );
}

/** Cmd/Ctrl+S → save, without stealing the browser's default when unfocused. */
function SavePlugin({ onSave }: { onSave: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const el = editor.getRootElement();
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSave();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [editor, onSave]);
  return null;
}

const wrap: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' };
const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#fbfaff', flexShrink: 0 };
const editArea: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' };
const contentEditable: React.CSSProperties = { outline: 'none', padding: '28px 48px 120px', maxWidth: 860, margin: '0 auto', minHeight: '100%', font: '15px/1.7 system-ui', color: '#1e293b' };
const placeholder: React.CSSProperties = { position: 'absolute', top: 28, left: 48, color: '#cbd5e1', pointerEvents: 'none', font: '15px system-ui' };
const toolBtn: React.CSSProperties = { minWidth: 30, height: 30, padding: '0 7px', border: 'none', borderRadius: 7, background: 'transparent', color: '#475569', cursor: 'pointer', font: '600 14px system-ui', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
const toolBtnActive: React.CSSProperties = { background: '#ede9fe', color: '#6d28d9' };
const sep: React.CSSProperties = { width: 1, height: 20, background: '#e5e7eb', margin: '0 6px' };

const LEX_CSS = `
.vs-lex-content .vs-lex-p { margin: 0 0 12px; }
.vs-lex-content .vs-lex-h1 { font: 700 26px/1.3 system-ui; margin: 20px 0 12px; }
.vs-lex-content .vs-lex-h2 { font: 700 21px/1.3 system-ui; margin: 18px 0 10px; }
.vs-lex-content .vs-lex-h3 { font: 700 17px/1.3 system-ui; margin: 16px 0 8px; }
.vs-lex-content .vs-lex-quote { margin: 0 0 12px; padding: 4px 0 4px 14px; border-left: 3px solid #ddd6fe; color: #64748b; }
.vs-lex-content .vs-lex-ul { margin: 0 0 12px; padding-left: 26px; list-style: disc; }
.vs-lex-content .vs-lex-ol { margin: 0 0 12px; padding-left: 26px; list-style: decimal; }
.vs-lex-content .vs-lex-li { margin: 2px 0; }
.vs-lex-content .vs-lex-link { color: #4f46e5; text-decoration: underline; }
.vs-lex-content .vs-lex-bold { font-weight: 700; }
.vs-lex-content .vs-lex-italic { font-style: italic; }
.vs-lex-content .vs-lex-underline { text-decoration: underline; }
.vs-lex-content .vs-lex-strikethrough { text-decoration: line-through; }
.vs-lex-content .vs-lex-underline-strikethrough { text-decoration: underline line-through; }
.vs-lex-content .vs-lex-code { font-family: ui-monospace, monospace; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
.vs-lex-content .vs-lex-codeblock { display: block; font-family: ui-monospace, monospace; background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 8px; margin: 0 0 12px; white-space: pre-wrap; font-size: 13px; }
`;
