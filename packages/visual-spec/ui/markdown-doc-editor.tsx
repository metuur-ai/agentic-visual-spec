/**
 * markdown-doc-editor.tsx — Edit mode for a .md file: a source (or WYSIWYG)
 * editor on the left, a live rendered preview on the right. Owns the edit
 * buffer, dirty tracking, and Save (PUT /__vs/source + Cmd/Ctrl+S).
 *
 * The `engine` prop leaves a seam for a WYSIWYG (Lexical) editor alongside the
 * CodeMirror source editor; only 'source' is wired today.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMarkdownSource } from '../core/app';
import { MarkdownSurface } from './markdown-surface';
import { toSurfaceId } from './md-path';
import { SourceEditor } from './source-editor';
import { WysiwygEditor } from './wysiwyg-editor';

export type EditorEngine = 'source' | 'wysiwyg';

async function saveSource(surfaceId: string, source: string): Promise<void> {
  const res = await fetch(`/__vs/source?surfaceId=${encodeURIComponent(surfaceId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

export function MarkdownDocEditor({
  path,
  previewWidth,
  splitter,
  defaultEngine = 'wysiwyg',
}: {
  path: string; // real .md path
  previewWidth: number;
  splitter: React.ReactNode;
  defaultEngine?: EditorEngine;
}) {
  const surfaceId = toSurfaceId(path);
  const { source, loading } = useMarkdownSource(surfaceId);

  const [engine, setEngine] = useState<EditorEngine>(defaultEngine);
  const [value, setValue] = useState(source);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Content last loaded-from / saved-to disk; value !== baseline ⇒ unsaved edits.
  const baseline = useRef(source);
  const dirty = value !== baseline.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Adopt a fresh source from the server only when there's nothing unsaved to
  // lose — otherwise a save-triggered refetch (or external edit) would clobber
  // in-progress edits. On save, `value` already equals the new source, so the
  // echoed refetch is a no-op.
  useEffect(() => {
    if (!dirtyRef.current) {
      baseline.current = source;
      setValue(source);
    }
  }, [source]);

  const save = useCallback(async () => {
    if (saving || value === baseline.current) return;
    setSaving(true);
    setError(null);
    const snapshot = value;
    try {
      await saveSource(surfaceId, snapshot);
      baseline.current = snapshot;
      setValue((v) => v); // re-render to clear the dirty flag
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [saving, value, surfaceId]);

  // WYSIWYG is full-width (it IS the rendered view); source mode pairs with a
  // live preview on the right.
  const showPreview = engine === 'source';

  return (
    <>
      <main style={editorPane}>
        <SaveBar dirty={dirty} saving={saving} error={error} onSave={save} engine={engine} onEngineChange={setEngine} />
        {loading ? (
          <p style={{ opacity: 0.6, padding: 16 }}>Loading…</p>
        ) : engine === 'source' ? (
          <SourceEditor value={value} onChange={setValue} onSave={save} />
        ) : (
          <WysiwygEditor value={value} onChange={setValue} onSave={save} />
        )}
      </main>
      {showPreview && splitter}
      {showPreview && (
        <aside style={{ ...previewPane, width: previewWidth }}>
          <div style={previewHead}>Preview</div>
          <div style={previewBody}>
            <div style={{ maxWidth: 900, margin: '0 auto' }}>
              <MarkdownSurface source={value} />
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

function SaveBar({
  dirty,
  saving,
  error,
  onSave,
  engine,
  onEngineChange,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  engine: EditorEngine;
  onEngineChange: (e: EditorEngine) => void;
}) {
  const status = error ? `⚠ ${error}` : saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
  const color = error ? '#b91c1c' : dirty ? '#b45309' : '#15803d';
  return (
    <div style={saveBar}>
      <div style={engWrap} role="tablist" aria-label="Editor engine">
        {(['wysiwyg', 'source'] as const).map((e) => (
          <button
            key={e}
            type="button"
            role="tab"
            aria-selected={engine === e}
            onClick={() => onEngineChange(e)}
            style={engine === e ? engBtnActive : engBtn}
            title={e === 'wysiwyg' ? 'Rich text (Lexical)' : 'Markdown source + preview'}
          >
            {e === 'wysiwyg' ? 'Rich' : 'Source'}
          </button>
        ))}
      </div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{status}</span>
        <button type="button" onClick={onSave} disabled={!dirty || saving} style={{ ...saveBtn, opacity: !dirty || saving ? 0.5 : 1 }} title="Save (⌘/Ctrl+S)">
          Save
        </button>
      </span>
    </div>
  );
}

const editorPane: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' };
const saveBar: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '7px 14px', borderBottom: '1px solid #e5e7eb', background: 'white', flexShrink: 0 };
const saveBtn: React.CSSProperties = { padding: '5px 14px', border: 'none', borderRadius: 7, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 12px system-ui' };
const engWrap: React.CSSProperties = { display: 'inline-flex', padding: 2, gap: 2, background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 8 };
const engBtn: React.CSSProperties = { padding: '3px 12px', border: 'none', borderRadius: 6, background: 'transparent', color: '#64748b', cursor: 'pointer', font: '600 12px system-ui' };
const engBtnActive: React.CSSProperties = { ...engBtn, background: 'white', color: '#4f46e5', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' };
const previewPane: React.CSSProperties = { flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #e5e7eb', background: '#f8fafc', overflow: 'hidden' };
const previewHead: React.CSSProperties = { padding: '7px 14px', borderBottom: '1px solid #e5e7eb', background: '#fbfaff', font: '600 11px system-ui', letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8', flexShrink: 0 };
const previewBody: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '24px 32px 80px' };
