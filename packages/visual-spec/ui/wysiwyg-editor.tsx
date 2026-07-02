/**
 * wysiwyg-editor.tsx — a rich-text editor over the .md buffer, built on Luthor's
 * type-safe `ExtensiveEditor` preset (Lexical under the hood). Loads the markdown
 * body once on mount and round-trips through Luthor's markdown bridge
 * (`ref.getMarkdown()`), so the .md file stays the source of truth.
 *
 * Luthor's preset is *uncontrolled by design*: `defaultContent` is read once at
 * mount, edits are observed via the DOM, and the current markdown is pulled
 * imperatively through the ref. To adopt an EXTERNAL revision (file switch, save
 * echo from the server) we remount by bumping a React `key`; our own exports are
 * recognised and never trigger a remount.
 *
 * Fidelity note: the round-trip is normalizing (Luthor rebuilds the markdown from
 * its node tree), so saving from here can rewrite formatting. Relative image srcs
 * are absolutized to /__vs/raw for display and relativized back on export.
 *
 * Comments: select text and a floating "Comment" affordance opens an inline
 * composer that files a range comment against this file via `onAddComment` —
 * the same sidecar model used in view mode.
 */
import './prism-global'; // must precede @lyfie/luthor — sets the global Prism it needs
import { ExtensiveEditor, type ExtensiveEditorRef, headless } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TreeEntry, rawUrl, useTree } from './use-tree';
import { WorkflowSelect, loadWorkflow } from './workflow-select';

/** Remembered upload destination (relative to the spec root), shared across files. */
const UPLOAD_DIR_KEY = 'vs:uploadDir';
const loadUploadDir = () => localStorage.getItem(UPLOAD_DIR_KEY) || 'assets';

/** Basename without extension — a reasonable default alt text for a picked image. */
function altFromPath(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A comment drafted from an editor text selection, handed to the host to file. */
export type CommentDraft = {
  comment: string;
  workflow: string;
  selectedContent: string; // verbatim highlighted text
  snippet: string; // first line of the selection (<=160 chars)
  endSnippet?: string; // last line, when the selection spans lines
  heading: string | null; // nearest heading above the selection
};

/** Rewrite the src of every markdown image via `map` (inline `![alt](src)`). */
function mapImages(md: string, map: (src: string) => string): string {
  return md.replace(/(!\[[^\]]*\]\()\s*([^)\s]+)([^)]*\))/g, (_m, pre, src, post) => `${pre}${map(src)}${post}`);
}

/** Nearest heading at or above a node — the robust markdown anchor (mirrors CommentPanel). */
function nearestHeading(node: Node, root: HTMLElement): string | null {
  const anchor = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)) ?? root;
  if (anchor instanceof HTMLElement && /^H[1-6]$/.test(anchor.tagName)) return anchor.textContent?.trim() ?? null;
  const heads = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
  let best: string | null = null;
  for (const h of heads) {
    const precedes = (h.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (precedes) best = h.textContent?.trim() ?? best;
    else break;
  }
  return best;
}

/** The live, non-collapsed selection inside `root`, or null. */
function readSelection(root: HTMLElement): { text: string; rect: DOMRect; heading: string | null } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { text, rect, heading: nearestHeading(range.startContainer, root) };
}

export function WysiwygEditor({
  value,
  onChange,
  onSave,
  resolveImageSrc = (s) => s,
  toStoredImageSrc = (s) => s,
  onAddComment,
}: {
  value: string; // markdown body (frontmatter already split off by the host)
  onChange: (next: string) => void;
  onSave: () => void;
  resolveImageSrc?: (src: string) => string; // relative → /__vs/raw absolute (display)
  toStoredImageSrc?: (src: string) => string; // /__vs/raw absolute → relative (export)
  onAddComment?: (draft: CommentDraft) => void | Promise<void>;
}) {
  const api = useRef<ExtensiveEditorRef | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const loaded = useRef(false);
  // Guards the export: Luthor renormalizes the DOM after a load, which the
  // MutationObserver can't tell from a real edit. We only export once the user
  // has actually interacted (typed, pasted, or clicked a toolbar control).
  const interacted = useRef(false);
  // While a native block drag is in flight, suspend exports: a re-render from a
  // mid-drag onChange would cancel the browser's drag. We flush once on dragend.
  const dragging = useRef(false);
  // The markdown we and the host last agreed on — echo guard AND export baseline.
  // Seeded with the incoming value so the first mount doesn't remount itself.
  const lastSynced = useRef<string>(value);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const toStoredRef = useRef(toStoredImageSrc);
  toStoredRef.current = toStoredImageSrc;
  const resolveRef = useRef(resolveImageSrc);
  resolveRef.current = resolveImageSrc;
  const onAddCommentRef = useRef(onAddComment);
  onAddCommentRef.current = onAddComment;

  // Remount only when an EXTERNAL value arrives (host adopted a fresh source);
  // our own exports set `lastSynced` first, so they're ignored here.
  const [gen, setGen] = useState(0);
  const mountContent = useRef<string>(mapImages(value, resolveImageSrc));
  useEffect(() => {
    if (value === lastSynced.current) return; // our own echo — do not remount
    lastSynced.current = value;
    mountContent.current = mapImages(value, resolveRef.current);
    loaded.current = false;
    interacted.current = false;
    setGen((g) => g + 1);
  }, [value]);

  // Pull the current markdown, relativize images, and push it to the host (once
  // loaded, and only when it actually changed).
  const pushMarkdown = useCallback(() => {
    const a = api.current;
    if (!a || !loaded.current || !interacted.current || dragging.current) return;
    const md = `${mapImages(a.getMarkdown(), toStoredRef.current).replace(/\n+$/, '')}\n`;
    if (md === lastSynced.current) return;
    lastSynced.current = md;
    onChangeRef.current(md);
  }, []);

  // Observe edits: contentEditable `input` covers typing; a MutationObserver
  // catches toolbar-driven formatting. Both are debounced into one export.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let t: number | undefined;
    const schedule = () => {
      window.clearTimeout(t);
      t = window.setTimeout(pushMarkdown, 250);
    };
    const mark = () => {
      // On the first interaction, snapshot the steady-state markdown *before* the
      // edit lands. Load-time normalization has settled by now, so a no-op action
      // (selecting text, arrow keys, clicking the comment pill) leaves getMarkdown
      // equal to this baseline and never dirties the buffer; a real edit diverges.
      if (!interacted.current) {
        interacted.current = true;
        const a = api.current;
        if (a) {
          try {
            lastSynced.current = `${mapImages(a.getMarkdown(), toStoredRef.current).replace(/\n+$/, '')}\n`;
          } catch {
            /* keep the prior baseline */
          }
        }
      }
      schedule();
    };
    // A native block drag is a real edit, but exporting mid-drag would re-render
    // and cancel it; hold exports until the drag ends, then flush once.
    const onDragStart = () => {
      interacted.current = true;
      dragging.current = true;
      window.clearTimeout(t);
    };
    const onDragEnd = () => {
      dragging.current = false;
      schedule();
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    // These are unambiguously user-driven; load-settling reflows fire none of them.
    root.addEventListener('beforeinput', mark);
    root.addEventListener('input', mark);
    root.addEventListener('keydown', mark);
    root.addEventListener('pointerdown', mark);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('drop', onDragEnd);
    return () => {
      mo.disconnect();
      root.removeEventListener('beforeinput', mark);
      root.removeEventListener('input', mark);
      root.removeEventListener('keydown', mark);
      root.removeEventListener('pointerdown', mark);
      root.removeEventListener('dragstart', onDragStart);
      root.removeEventListener('dragend', onDragEnd);
      root.removeEventListener('drop', onDragEnd);
      window.clearTimeout(t);
    };
  }, [pushMarkdown]);

  // Destination folder for uploads, chosen in the strip and remembered.
  const [uploadDir, setUploadDir] = useState(loadUploadDir);
  const uploadDirRef = useRef(uploadDir);
  uploadDirRef.current = uploadDir;
  const [pickerOpen, setPickerOpen] = useState(false);

  // Upload an image chosen from the toolbar ("Upload File" / "Upload GIF"): POST
  // the bytes to the server, which stores them under the chosen folder (the strip's
  // "Upload to", default assets/), and return a /__vs/raw display URL. On save,
  // `toStoredImageSrc` relativizes that URL against the .md file — same round-trip
  // as any image.
  const uploadImage = useCallback(async (file: File): Promise<string> => {
    const dir = uploadDirRef.current.trim() || 'assets';
    const res = await fetch(`/__vs/upload?name=${encodeURIComponent(file.name)}&dir=${encodeURIComponent(dir)}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    const { path } = (await res.json()) as { path: string };
    return `/__vs/raw?path=${encodeURIComponent(path)}`;
  }, []);

  // Reference an image already in the workspace (no upload/copy). Luthor exposes
  // no caret-insert API, so we append the markdown to the body and let the host
  // remount — the image lands at the end for the user to drag into place.
  const insertWorkspaceImage = useCallback((treePath: string) => {
    const rel = toStoredRef.current(rawUrl(treePath)); // path relative to this .md
    const md = `![${altFromPath(treePath)}](${rel})`;
    const nextBody = `${value.replace(/\n+$/, '')}\n\n${md}\n`;
    onChangeRef.current(nextBody);
    setPickerOpen(false);
  }, [value]);

  // Cmd/Ctrl+S → save.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        pushMarkdown(); // flush the latest before the host reads its buffer
        onSaveRef.current();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [pushMarkdown]);

  return (
    <>
      <div style={imgStrip}>
        <button type="button" onClick={() => setPickerOpen(true)} style={stripBtn} title="Insert an image already in the workspace">
          🖼 From workspace
        </button>
        <span style={{ flex: 1 }} />
        <label style={stripLabel} title="Folder new uploads are saved to, relative to the spec root">
          Upload to
          <input
            value={uploadDir}
            onChange={(e) => {
              setUploadDir(e.target.value);
              localStorage.setItem(UPLOAD_DIR_KEY, e.target.value);
            }}
            spellCheck={false}
            style={stripInput}
            placeholder="assets"
          />
        </label>
      </div>
    <div style={wrap} ref={rootRef} className="vs-luthor">
      <ExtensiveEditor
        key={gen}
        onReady={(methods) => {
          api.current = methods;
          // Load via the markdown bridge: parse markdown → Lexical JSON and inject
          // it (defaultContent is not markdown-parsed on its own). Then, once the
          // DOM has settled, adopt Luthor's canonical serialization as the export
          // baseline so a mere load never looks like an edit (no spurious dirty).
          try {
            methods.injectJSON(JSON.stringify(headless.markdownToJSON(mountContent.current)));
          } catch {
            /* leave the editor empty on a parse failure */
          }
          requestAnimationFrame(() => {
            try {
              lastSynced.current = `${mapImages(methods.getMarkdown(), toStoredRef.current).replace(/\n+$/, '')}\n`;
            } catch {
              /* keep the seeded value */
            }
            loaded.current = true;
          });
        }}
        showDefaultContent={false}
        markdownSourceOfTruth
        sourceMetadataMode="none"
        defaultEditorView="visual"
        isEditorViewTabsVisible={false}
        toolbarPosition="top"
        isToolbarEnabled
        imageUploadHandler={uploadImage}
        gifUploadHandler={uploadImage}
        placeholder="Start writing…"
      />
      {onAddComment && <CommentLayer rootRef={rootRef} onAdd={(d) => onAddCommentRef.current?.(d)} />}
    </div>
      {pickerOpen && <WorkspaceImagePicker onPick={insertWorkspaceImage} onClose={() => setPickerOpen(false)} />}
    </>
  );
}

/**
 * Modal listing every image in the workspace tree, searchable, so an existing
 * file can be referenced without re-uploading. Picking one calls `onPick(path)`.
 */
function WorkspaceImagePicker({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const { entries, loading } = useTree();
  const [q, setQ] = useState('');
  const images = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries
      .filter((e): e is TreeEntry => e.type === 'file' && e.kind === 'image')
      .filter((e) => !needle || e.path.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [entries, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={pickerBackdrop} onMouseDown={onClose}>
      <div style={pickerCard} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Insert workspace image">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>Insert workspace image</strong>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={pickerClose} aria-label="Close">✕</button>
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter images…" style={pickerSearch} />
        <div style={pickerGrid}>
          {loading ? (
            <div style={{ opacity: 0.6, padding: 16 }}>Loading…</div>
          ) : images.length === 0 ? (
            <div style={{ opacity: 0.6, padding: 16 }}>No images found in the workspace.</div>
          ) : (
            images.map((img) => (
              <button key={img.path} type="button" onClick={() => onPick(img.path)} style={pickerItem} title={img.path}>
                <img src={rawUrl(img.path)} alt="" style={pickerThumb} loading="lazy" />
                <span style={pickerName}>{img.path}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Selection-driven comment affordance: a floating "Comment" pill above the
 * current selection, and an inline composer (workflow + instruction) that files
 * a range comment against the file.
 */
function CommentLayer({ rootRef, onAdd }: { rootRef: React.RefObject<HTMLDivElement | null>; onAdd: (d: CommentDraft) => void }) {
  const [pill, setPill] = useState<{ top: number; left: number } | null>(null);
  const [draft, setDraft] = useState<
    { top: number; left: number; selectedContent: string; snippet: string; endSnippet?: string; heading: string | null } | null
  >(null);
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState(loadWorkflow);

  // Track the selection while the composer is closed.
  useEffect(() => {
    if (draft) return;
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const s = readSelection(root);
        setPill(s ? { top: Math.max(8, s.rect.top - 40), left: s.rect.left + s.rect.width / 2 } : null);
      });
    };
    document.addEventListener('selectionchange', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      cancelAnimationFrame(raf);
    };
  }, [rootRef, draft]);

  const openComposer = () => {
    const root = rootRef.current;
    if (!root) return;
    const s = readSelection(root);
    if (!s) return;
    const lines = s.text.split('\n').map((l) => l.trim()).filter(Boolean);
    // Keep the composer fully on-screen: below the selection when it fits, else
    // above it; and never past the right edge.
    const W = 300;
    const H = 210;
    const below = s.rect.bottom + 8;
    const top = below + H <= window.innerHeight ? below : Math.max(12, s.rect.top - H - 8);
    const left = Math.min(Math.max(12, s.rect.left), window.innerWidth - W - 12);
    setDraft({
      top,
      left,
      selectedContent: s.text,
      snippet: (lines[0] ?? s.text).slice(0, 160),
      endSnippet: lines.length > 1 ? lines[lines.length - 1]!.slice(0, 160) : undefined,
      heading: s.heading,
    });
    setPill(null);
    setText('');
  };

  const submit = () => {
    if (!draft || !text.trim()) return;
    onAdd({
      comment: text.trim(),
      workflow: workflow || 'visual-spec',
      selectedContent: draft.selectedContent,
      snippet: draft.snippet,
      endSnippet: draft.endSnippet,
      heading: draft.heading,
    });
    setDraft(null);
    setText('');
  };

  return (
    <>
      {pill && !draft && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep the selection alive
          onClick={openComposer}
          style={{ ...commentPill, top: pill.top, left: pill.left }}
          title="Comment on the selected text"
        >
          <CommentIcon /> Comment
        </button>
      )}
      {draft && (
        <div style={{ ...composer, top: draft.top, left: draft.left }} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>
            commenting on <strong>{draft.heading ?? '(selection)'}</strong>
          </div>
          <WorkflowSelect value={workflow} onChange={setWorkflow} />
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
              if (e.key === 'Escape') setDraft(null);
            }}
            placeholder="Your comment (⌘/Ctrl+Enter)…"
            style={composerTextarea}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button type="button" onClick={() => setDraft(null)} style={composerCancel}>
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={!text.trim()} style={{ ...composerAdd, opacity: text.trim() ? 1 : 0.5 }}>
              Add comment
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function CommentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

const wrap: React.CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' };
const imgStrip: React.CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '5px 12px', borderBottom: '1px solid #eef2f7', background: '#fbfaff' };
const stripBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: 7, background: 'white', color: '#4f46e5', cursor: 'pointer', font: '600 12px system-ui' };
const stripLabel: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#94a3b8', font: '600 11px system-ui', letterSpacing: '0.03em', textTransform: 'uppercase' };
const stripInput: React.CSSProperties = { width: 130, padding: '3px 8px', border: '1px solid #d1d5db', borderRadius: 6, font: '12px ui-monospace, "SF Mono", monospace', color: '#334155', textTransform: 'none', letterSpacing: 0 };
const pickerBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(15,23,42,0.35)' };
const pickerCard: React.CSSProperties = { width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', padding: 16, borderRadius: 12, background: 'white', boxShadow: '0 20px 50px rgba(0,0,0,0.28)', font: 'system-ui' };
const pickerClose: React.CSSProperties = { border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer', fontSize: 15 };
const pickerSearch: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, font: '13px system-ui', marginBottom: 12 };
const pickerGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, overflow: 'auto', padding: 2 };
const pickerItem: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid #e5e7eb', borderRadius: 10, background: 'white', cursor: 'pointer', textAlign: 'left' };
const pickerThumb: React.CSSProperties = { width: '100%', height: 90, objectFit: 'contain', background: '#f8fafc', borderRadius: 6 };
const pickerName: React.CSSProperties = { font: '11px ui-monospace, "SF Mono", monospace', color: '#475569', wordBreak: 'break-all', lineHeight: 1.3 };
const commentPill: React.CSSProperties = {
  position: 'fixed',
  transform: 'translateX(-50%)',
  zIndex: 40,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 11px',
  border: 'none',
  borderRadius: 8,
  background: '#111827',
  color: 'white',
  cursor: 'pointer',
  font: '600 12px system-ui',
  boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
};
const composer: React.CSSProperties = {
  position: 'fixed',
  zIndex: 41,
  width: 300,
  maxWidth: 'calc(100vw - 24px)',
  padding: 12,
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  background: 'white',
  boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
  font: '13px system-ui',
};
const composerTextarea: React.CSSProperties = { width: '100%', boxSizing: 'border-box', height: 74, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, font: 'inherit', resize: 'vertical' };
const composerCancel: React.CSSProperties = { padding: '5px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: 'inherit' };
const composerAdd: React.CSSProperties = { padding: '5px 12px', border: '1px solid #2563eb', borderRadius: 6, background: '#2563eb', color: 'white', cursor: 'pointer', font: 'inherit' };
