/**
 * markdown-doc-editor.tsx — Edit mode for a .md file: a source (or WYSIWYG)
 * editor on the left, a live rendered preview on the right. Owns the edit
 * buffer, dirty tracking, and Save (PUT /__vs/source + Cmd/Ctrl+S).
 *
 * The `engine` prop leaves a seam for a WYSIWYG (Lexical) editor alongside the
 * CodeMirror source editor; only 'source' is wired today.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useComments, useMarkdownSource } from '../core/app';
import { MarkdownSurface } from './markdown-surface';
import { combineFrontmatter, splitFrontmatter } from './frontmatter';
import { detectFidelityRisk } from './md-fidelity';
import { toSurfaceId } from './md-path';
import { SourceEditor } from './source-editor';
import { type CommentDraft, WysiwygEditor } from './wysiwyg-editor';

export type EditorEngine = 'source' | 'wysiwyg';

/** Normalize a relative path, collapsing `.`/`..` segments. */
function normalizeRelPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Build a resolver for markdown image srcs. Absolute URLs/data URIs pass through;
 * relative paths resolve against the file's directory and stream from /__vs/raw.
 */
function makeImageResolver(filePath: string): (src: string) => string {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  return (src: string) => {
    if (/^(https?:|data:|blob:|\/\/)/i.test(src)) return src;
    const joined = normalizeRelPath(dir ? `${dir}/${src}` : src);
    return `/__vs/raw?path=${encodeURIComponent(joined)}`;
  };
}

/**
 * Inverse of {@link makeImageResolver}: turn a /__vs/raw display URL back into a
 * path relative to the file's directory, so exported markdown stays portable.
 */
function makeImageDerelativizer(filePath: string): (src: string) => string {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  return (src: string) => {
    const m = /^\/__vs\/raw\?path=(.+)$/.exec(src);
    if (!m) return src;
    const abs = normalizeRelPath(decodeURIComponent(m[1]!));
    const from = dir ? dir.split('/') : [];
    const to = abs.split('/');
    let i = 0;
    while (i < from.length && i < to.length && from[i] === to[i]) i++;
    const rel = [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
    return rel || abs;
  };
}

/** Strip common markdown markup so rendered selection text can match source lines. */
function stripMd(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/, '')
    .replace(/[*_`>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  onExitToView,
  onStateChange,
}: {
  path: string; // real .md path
  previewWidth: number;
  splitter: React.ReactNode;
  defaultEngine?: EditorEngine;
  // "Done" (and the host's save-and-view guard) return to the rendered view.
  onExitToView?: () => void;
  // Report dirty state + a success-returning save up to the host, so the top-bar
  // View toggle can guard unsaved edits instead of silently discarding them.
  onStateChange?: (state: { dirty: boolean; save: () => Promise<boolean> }) => void;
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

  // Rich handles tables, images, and frontmatter (the last edited separately,
  // below). Only table column alignment can still degrade — a soft banner warns.
  const risk = useMemo(() => detectFidelityRisk(value), [value]);

  // Frontmatter is edited outside Lexical: split it off, hand only the body to
  // the rich editor, and recombine on every change so `value` stays whole.
  const { inner: frontmatter, body } = useMemo(() => splitFrontmatter(value), [value]);

  // Resolve relative image paths against the file's directory via /__vs/raw (for
  // display), and its inverse (for export, so saved markdown stays relative).
  const resolveImageSrc = useMemo(() => makeImageResolver(path), [path]);
  const toStoredImageSrc = useMemo(() => makeImageDerelativizer(path), [path]);

  // Comments authored from the rich editor land in the same sidecar as view mode.
  const comments = useComments(path);
  const addComment = useCallback(
    async (d: CommentDraft) => {
      const lines = value.split('\n');
      const findLine = (snip: string): number | undefined => {
        const needle = stripMd(snip);
        if (!needle) return undefined;
        const idx = lines.findIndex((l) => stripMd(l).includes(needle));
        return idx >= 0 ? idx + 1 : undefined;
      };
      const startLine = findLine(d.snippet);
      const endLine = d.endSnippet ? findLine(d.endSnippet) : undefined;
      await comments.add({
        path,
        workflow: d.workflow || 'visual-spec',
        comment: d.comment,
        heading: d.heading,
        ...(d.selectedContent ? { selectedContent: d.selectedContent } : {}),
        ...(startLine != null
          ? {
              kind: 'range' as const,
              startLine,
              snippet: d.snippet,
              ...(endLine != null && endLine > startLine ? { endLine, endSnippet: d.endSnippet } : {}),
            }
          : { kind: 'file' as const }),
      });
    },
    [comments, path, value],
  );

  // Returns whether the buffer is safely on disk: true when saved (or already
  // clean), false when a save was in flight or failed — callers that navigate
  // away (Done, save-and-view) only leave on true.
  const save = useCallback(async (): Promise<boolean> => {
    if (value === baseline.current) return true; // nothing to save
    if (saving) return false;
    setSaving(true);
    setError(null);
    const snapshot = value;
    try {
      await saveSource(surfaceId, snapshot);
      baseline.current = snapshot;
      setValue((v) => v); // re-render to clear the dirty flag
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [saving, value, surfaceId]);

  // "Done" = save (if needed) and return to View, only exiting on a clean save.
  const onExitRef = useRef(onExitToView);
  onExitRef.current = onExitToView;
  const done = useCallback(async () => {
    if (await save()) onExitRef.current?.();
  }, [save]);

  // Surface dirty + save to the host for its View-toggle guard.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.({ dirty, save });
  }, [dirty, save]);

  // WYSIWYG is full-width (it IS the rendered view); source mode pairs with a
  // live preview on the right.
  const showPreview = engine === 'source';

  return (
    <>
      <main style={editorPane}>
        <SaveBar dirty={dirty} saving={saving} error={error} onDone={done} engine={engine} onEngineChange={setEngine} />
        {engine === 'wysiwyg' && risk.alignedTables && (
          <div style={riskBanner}>
            <span>⚠ Table column alignment (:---:) can be simplified on save. Edit in Source for exact fidelity.</span>
            <button type="button" onClick={() => setEngine('source')} style={riskBtn}>
              Edit in Source
            </button>
          </div>
        )}
        {loading ? (
          <p style={{ opacity: 0.6, padding: 16 }}>Loading…</p>
        ) : engine === 'source' ? (
          <SourceEditor value={value} onChange={setValue} onSave={save} />
        ) : (
          <>
            <FrontmatterBar inner={frontmatter} onChange={(next) => setValue(combineFrontmatter(next, body))} onSave={save} />
            <WysiwygEditor
              value={body}
              onChange={(nextBody) => setValue(combineFrontmatter(frontmatter, nextBody))}
              onSave={save}
              resolveImageSrc={resolveImageSrc}
              toStoredImageSrc={toStoredImageSrc}
              onAddComment={addComment}
            />
          </>
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
  onDone,
  engine,
  onEngineChange,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onDone: () => void;
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
        <button type="button" onClick={onDone} disabled={saving} style={{ ...doneBtn, opacity: saving ? 0.5 : 1 }} title="Save and return to the rendered view (⌘/Ctrl+S saves without leaving)">
          ✓ Done
        </button>
      </span>
    </div>
  );
}

/**
 * Frontmatter editor shown above the rich body. Absent frontmatter shows an
 * "add" affordance; present frontmatter is an editable, collapsible YAML box.
 */
function FrontmatterBar({ inner, onChange, onSave }: { inner: string | null; onChange: (next: string | null) => void; onSave: () => void }) {
  const [open, setOpen] = useState(true);
  if (inner == null) {
    return (
      <div style={fmAddRow}>
        <button type="button" onClick={() => onChange('')} style={fmAddBtn} title="Add a YAML frontmatter block">
          + Add frontmatter
        </button>
      </div>
    );
  }
  return (
    <div style={fmWrap}>
      <div style={fmHead}>
        <button type="button" onClick={() => setOpen((v) => !v)} style={fmToggle} title={open ? 'Collapse' : 'Expand'}>
          <span style={{ display: 'inline-block', width: 10, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}>▾</span>
          Frontmatter <span style={{ opacity: 0.6, fontWeight: 400 }}>YAML</span>
        </button>
        <button type="button" onClick={() => onChange(null)} style={fmRemove} title="Remove frontmatter">
          Remove
        </button>
      </div>
      {open && (
        <textarea
          value={inner}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              onSave();
            }
          }}
          spellCheck={false}
          rows={Math.min(10, Math.max(2, inner.split('\n').length))}
          style={fmTextarea}
          placeholder="key: value"
        />
      )}
    </div>
  );
}

const fmWrap: React.CSSProperties = { flexShrink: 0, borderBottom: '1px solid #e5e7eb', background: '#fbfaff' };
const fmHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 12px' };
const fmToggle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: '#6d28d9', cursor: 'pointer', font: '600 11px system-ui', letterSpacing: '0.04em', textTransform: 'uppercase' };
const fmRemove: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', color: '#64748b', cursor: 'pointer', font: '11px system-ui', padding: '2px 8px' };
const fmTextarea: React.CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 12px', border: 'none', borderTop: '1px solid #ece6fb', background: '#fdfcff', color: '#334155', font: '12.5px ui-monospace, "SF Mono", monospace', resize: 'vertical', outline: 'none' };
const fmAddRow: React.CSSProperties = { flexShrink: 0, padding: '4px 12px', borderBottom: '1px solid #f1f5f9', background: '#fbfaff' };
const fmAddBtn: React.CSSProperties = { border: '1px dashed #d8d0f0', borderRadius: 6, background: 'white', color: '#7c3aed', cursor: 'pointer', font: '600 11.5px system-ui', padding: '3px 10px' };
const editorPane: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' };
const saveBar: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '7px 14px', borderBottom: '1px solid #e5e7eb', background: 'white', flexShrink: 0 };
const doneBtn: React.CSSProperties = { padding: '5px 14px', border: 'none', borderRadius: 7, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 12px system-ui' };
const riskBanner: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 14px', borderBottom: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', font: '12.5px system-ui', flexShrink: 0 };
const riskBtn: React.CSSProperties = { flexShrink: 0, padding: '4px 12px', border: '1px solid #fcd34d', borderRadius: 7, background: 'white', color: '#92400e', cursor: 'pointer', font: '600 12px system-ui' };
const engWrap: React.CSSProperties = { display: 'inline-flex', padding: 2, gap: 2, background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 8 };
const engBtn: React.CSSProperties = { padding: '3px 12px', border: 'none', borderRadius: 6, background: 'transparent', color: '#64748b', cursor: 'pointer', font: '600 12px system-ui' };
const engBtnActive: React.CSSProperties = { ...engBtn, background: 'white', color: '#4f46e5', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' };
const previewPane: React.CSSProperties = { flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #e5e7eb', background: '#f8fafc', overflow: 'hidden' };
const previewHead: React.CSSProperties = { padding: '7px 14px', borderBottom: '1px solid #e5e7eb', background: '#fbfaff', font: '600 11px system-ui', letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8', flexShrink: 0 };
const previewBody: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '24px 32px 80px' };
