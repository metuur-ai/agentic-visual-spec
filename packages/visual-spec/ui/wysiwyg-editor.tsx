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
import { ExtensiveEditor, type ExtensiveEditorRef } from '@lyfie/luthor';
import '@lyfie/luthor/styles.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapImages, markdownToInjectable, normalizeForStore } from './luthor-bridge';
import { type TreeEntry, invalidateTree, rawUrl, useTree } from './use-tree';
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
    const md = normalizeForStore(a.getMarkdown(), toStoredRef.current);
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
            lastSynced.current = normalizeForStore(a.getMarkdown(), toStoredRef.current);
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
    // Structural + text edits only. `attributes` is deliberately omitted: Lexical
    // toggles classes/inline styles on nodes as the caret and selection move, which
    // would fire this observer continuously while merely navigating — pegging a
    // core with getMarkdown() churn. Real edits change childList/characterData, and
    // toolbar formatting is additionally covered by the pointerdown listener below.
    mo.observe(root, { subtree: true, childList: true, characterData: true });
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

  // Destination folder for uploads, chosen in the Insert-image modal, remembered,
  // and also used by paste/drag uploads (imageUploadHandler below).
  const [uploadDir, setUploadDir] = useState(loadUploadDir);
  const uploadDirRef = useRef(uploadDir);
  uploadDirRef.current = uploadDir;
  const changeUploadDir = useCallback((dir: string) => {
    setUploadDir(dir);
    localStorage.setItem(UPLOAD_DIR_KEY, dir);
  }, []);
  const [modalOpen, setModalOpen] = useState(false);

  // Upload bytes to the chosen folder (default assets/) and return a /__vs/raw
  // display URL. Wired as Luthor's image/gif handler so paste & drag also honor
  // the destination; the modal's Upload tab calls the same endpoint.
  const uploadImage = useCallback(async (file: File): Promise<string> => {
    const dir = uploadDirRef.current.trim() || 'assets';
    const res = await fetch(`/__vs/upload?name=${encodeURIComponent(file.name)}&dir=${encodeURIComponent(dir)}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    const { path } = (await res.json()) as { path: string };
    invalidateTree(); // the new asset should show up in the workspace picker
    return `/__vs/raw?path=${encodeURIComponent(path)}`;
  }, []);

  // Insert an image into the body. Luthor exposes no caret-insert API, so we
  // append the markdown and let the host remount — the image lands at the end
  // for the user to drag into place. `src` is the final markdown src (relative
  // path for workspace/upload, absolute for a URL).
  const insertImage = useCallback((src: string, alt: string) => {
    // Plain markdown only — never raw HTML. Luthor's markdown bridge renders an
    // `<div align="center">` wrapper as literal text and desyncs its node model when
    // the user edits it; images are instead centered via CSS (see `.md img` /
    // `.vs-luthor … img` in index.html), which works in both view and edit modes.
    const md = `![${alt}](${src})`;
    const nextBody = `${value.replace(/\n+$/, '')}\n\n${md}\n`;
    onChangeRef.current(nextBody);
    setModalOpen(false);
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

  // Repurpose Luthor's native toolbar image button (title="Insert Image"): open
  // our centralized modal instead of Luthor's built-in dropdown. Intercepting in
  // the bubble phase on our own root stops the event before it reaches the React
  // root where Luthor's dropdown trigger lives, so the built-in menu never opens.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const intercept = (e: Event) => {
      const btn = (e.target as HTMLElement | null)?.closest?.('button[title="Insert Image"]');
      if (!btn || !root.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      setModalOpen(true);
    };
    root.addEventListener('pointerdown', intercept);
    root.addEventListener('click', intercept);
    return () => {
      root.removeEventListener('pointerdown', intercept);
      root.removeEventListener('click', intercept);
    };
  }, []);

  return (
    <>
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
            methods.injectJSON(markdownToInjectable(mountContent.current));
          } catch (err) {
            // A parse failure would silently strand the user in an empty editor over
            // a non-empty file — surface it rather than swallow (data-loss shaped).
            console.error('[visual-spec] failed to load markdown into the editor', err);
          }
          requestAnimationFrame(() => {
            try {
              lastSynced.current = normalizeForStore(methods.getMarkdown(), toStoredRef.current);
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
      {modalOpen && (
        <ImageModal
          uploadDir={uploadDir}
          onUploadDirChange={changeUploadDir}
          toRelative={(url) => toStoredRef.current(url)}
          onInsert={insertImage}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

type ImageTab = 'upload' | 'workspace' | 'url';

/**
 * Centralized "Insert image" modal with three tabs — Upload (to a chosen folder),
 * Workspace (reuse an existing file), and From URL. Each resolves to a markdown
 * `src` + alt handed to `onInsert`. `toRelative` turns a /__vs/raw URL into a
 * path relative to the edited .md so saved links stay portable.
 */
function ImageModal({
  uploadDir,
  onUploadDirChange,
  toRelative,
  onInsert,
  onClose,
}: {
  uploadDir: string;
  onUploadDirChange: (dir: string) => void;
  toRelative: (rawUrlStr: string) => string;
  onInsert: (src: string, alt: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ImageTab>('upload');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={pickerBackdrop} onMouseDown={onClose}>
      <div style={pickerCard} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Insert image">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>Insert image</strong>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={pickerClose} aria-label="Close">✕</button>
        </div>
        <div style={tabRow} role="tablist">
          {(['upload', 'workspace', 'url'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={tab === t ? tabBtnActive : tabBtn}>
              {t === 'upload' ? 'Upload' : t === 'workspace' ? 'Workspace' : 'From URL'}
            </button>
          ))}
        </div>
        {tab === 'upload' && <UploadTab uploadDir={uploadDir} onUploadDirChange={onUploadDirChange} toRelative={toRelative} onInsert={onInsert} />}
        {tab === 'workspace' && <WorkspaceTab toRelative={toRelative} onInsert={onInsert} />}
        {tab === 'url' && <UrlTab onInsert={onInsert} />}
      </div>
    </div>
  );
}

/** Upload tab: choose a file, choose the destination folder, upload, insert. */
function UploadTab({
  uploadDir,
  onUploadDirChange,
  toRelative,
  onInsert,
}: {
  uploadDir: string;
  onUploadDirChange: (dir: string) => void;
  toRelative: (rawUrlStr: string) => string;
  onInsert: (src: string, alt: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const dir = uploadDir.trim() || 'assets';
      const res = await fetch(`/__vs/upload?name=${encodeURIComponent(file.name)}&dir=${encodeURIComponent(dir)}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { path } = (await res.json()) as { path: string };
      invalidateTree(); // refresh the workspace picker so the new asset appears
      onInsert(toRelative(rawUrl(path)), altFromPath(path));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={tabBody}>
      <div style={fieldLabel}>
        Save to folder
        <FolderField value={uploadDir} onChange={onUploadDirChange} />
      </div>
      <label style={{ ...dropZone, ...(file ? { borderColor: '#7c3aed', color: '#4f46e5' } : {}) }}>
        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file ? `Selected: ${file.name}` : 'Click to choose an image file…'}
      </label>
      {err && <div style={{ color: '#b91c1c', font: '12px system-ui' }}>⚠ {err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={upload} disabled={!file || busy} style={{ ...modalPrimary, opacity: !file || busy ? 0.5 : 1 }}>
          {busy ? 'Uploading…' : 'Upload & insert'}
        </button>
      </div>
    </div>
  );
}

/**
 * Directory chooser for uploads: type a folder (created on upload) or pick an
 * existing one from the workspace tree. Constrained to folders under the spec
 * root — unlike the header's native OS picker — since uploads save relative to it.
 */
function FolderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { entries } = useTree();
  const [open, setOpen] = useState(false);
  // Browse-list search — kept separate from `value` so the destination folder
  // doesn't filter the list (typing "assets" must not hide every other folder).
  const [q, setQ] = useState('');
  const dirs = useMemo(() => entries.filter((e) => e.type === 'dir').map((e) => e.path).sort((a, b) => a.localeCompare(b)), [entries]);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? dirs.filter((d) => d.toLowerCase().includes(n)) : dirs;
  }, [dirs, q]);
  const choose = (d: string) => {
    onChange(d);
    setOpen(false);
    setQ('');
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder="assets" style={{ ...fieldInput, flex: 1 }} />
        <button type="button" onClick={() => setOpen((o) => !o)} style={folderBtn} title="Browse workspace folders">
          📁 Browse
        </button>
      </div>
      {open && (
        <div style={folderPop}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} placeholder={`Search ${dirs.length} folders…`} style={folderSearch} />
          <div style={folderScroll}>
            {filtered.length === 0 ? (
              <div style={{ padding: '8px 10px', color: '#64748b', font: '12px system-ui' }}>No folder matches “{q}”.</div>
            ) : (
              filtered.map((d) => {
                // Tree view when browsing (indent by depth, show basename); flat
                // full paths while searching so matches keep their context.
                const searching = q.trim() !== '';
                const depth = searching ? 0 : d.split('/').length - 1;
                const label = searching ? d : d.slice(d.lastIndexOf('/') + 1);
                return (
                  <button key={d} type="button" onClick={() => choose(d)} style={{ ...folderItem, paddingLeft: 10 + depth * 16, ...(d === value.trim() ? { background: '#f5f3ff', color: '#6d28d9' } : {}) }}>
                    📁 {label}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Workspace tab: searchable grid of every image already in the tree. */
function WorkspaceTab({ toRelative, onInsert }: { toRelative: (rawUrlStr: string) => string; onInsert: (src: string, alt: string) => void }) {
  const { entries, loading } = useTree();
  const [q, setQ] = useState('');
  const images = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries
      .filter((e): e is TreeEntry => e.type === 'file' && e.kind === 'image')
      .filter((e) => !needle || e.path.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [entries, q]);

  // Cap the rendered grid: loading="lazy" bounds network, not DOM node count, so an
  // image-heavy workspace would otherwise mount thousands of nodes at once. Show the
  // first N and nudge the user to filter for the rest.
  const RENDER_CAP = 200;
  const shown = images.slice(0, RENDER_CAP);
  const hidden = images.length - shown.length;

  return (
    <div style={tabBody}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter images…" style={fieldInput} />
      <div style={pickerGrid}>
        {loading ? (
          <div style={{ opacity: 0.6, padding: 16 }}>Loading…</div>
        ) : images.length === 0 ? (
          <div style={{ opacity: 0.6, padding: 16 }}>No images found in the workspace.</div>
        ) : (
          shown.map((img) => (
            <button key={img.path} type="button" onClick={() => onInsert(toRelative(rawUrl(img.path)), altFromPath(img.path))} style={pickerItem} title={img.path}>
              <img src={rawUrl(img.path)} alt="" style={pickerThumb} loading="lazy" />
              <span style={pickerName}>{img.path}</span>
            </button>
          ))
        )}
      </div>
      {hidden > 0 && (
        <div style={{ opacity: 0.6, padding: '4px 2px', font: '12px system-ui' }}>
          Showing {shown.length} of {images.length} images — refine the filter to see the rest.
        </div>
      )}
    </div>
  );
}

/** From-URL tab: paste an image (or GIF) URL and insert it as-is. */
function UrlTab({ onInsert }: { onInsert: (src: string, alt: string) => void }) {
  const [url, setUrl] = useState('');
  const [alt, setAlt] = useState('');
  const insert = () => {
    const u = url.trim();
    if (u) onInsert(u, alt.trim());
  };
  return (
    <div style={tabBody}>
      <label style={fieldLabel}>
        Image URL
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && insert()} placeholder="https://… or data:image/…" style={fieldInput} />
      </label>
      <label style={fieldLabel}>
        Alt text <span style={{ opacity: 0.5, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
        <input value={alt} onChange={(e) => setAlt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && insert()} placeholder="describe the image" style={fieldInput} />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={insert} disabled={!url.trim()} style={{ ...modalPrimary, opacity: url.trim() ? 1 : 0.5 }}>
          Insert
        </button>
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

  // Open the composer for a piece of content (a text selection or a whole block),
  // positioned on-screen relative to its rect.
  const placeComposer = (payload: { text: string; rect: DOMRect; heading: string | null }) => {
    const lines = payload.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const W = 300;
    const H = 210;
    const below = payload.rect.bottom + 8;
    const top = below + H <= window.innerHeight ? below : Math.max(12, payload.rect.top - H - 8);
    const left = Math.min(Math.max(12, payload.rect.left), window.innerWidth - W - 12);
    setDraft({
      top,
      left,
      selectedContent: payload.text,
      snippet: (lines[0] ?? payload.text).slice(0, 160),
      endSnippet: lines.length > 1 ? lines[lines.length - 1]!.slice(0, 160) : undefined,
      heading: payload.heading,
    });
    setPill(null);
    setText('');
  };

  const openComposer = () => {
    const root = rootRef.current;
    if (!root) return;
    const s = readSelection(root);
    if (s) placeComposer(s);
  };

  // Block-level comment: inject a comment button into Luthor's draggable block
  // handle stack (the "+ / ⋮⋮" gutter) and, on click, open the composer for the
  // block the pointer last hovered — a second way to comment beyond selection.
  const openBlockRef = useRef<() => void>(() => {});
  openBlockRef.current = () => {
    const root = rootRef.current;
    const block = hoveredBlock.current;
    if (!root || !block) return;
    const text = block.textContent?.trim();
    if (!text) return;
    placeComposer({ text, rect: block.getBoundingClientRect(), heading: nearestHeading(block, root) });
  };
  const hoveredBlock = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Remember the top-level block under the pointer, so it survives moving out
    // to the gutter to click the injected button.
    const onMove = (e: MouseEvent) => {
      const ce = root.querySelector('.luthor-content-editable');
      if (!ce) return;
      let el = e.target as HTMLElement | null;
      while (el && el.parentElement !== ce) el = el.parentElement;
      if (el) hoveredBlock.current = el;
    };
    root.addEventListener('mousemove', onMove);

    // Inject (once per appearance) a comment button into the handle stack.
    const inject = () => {
      const stack = root.querySelector('.luthor-draggable-button-stack');
      if (!stack || stack.querySelector('.vs-block-comment-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vs-block-comment-btn';
      btn.title = 'Comment on this block';
      btn.setAttribute('aria-label', 'Comment on this block');
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      btn.style.cssText = 'display:grid;place-items:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:#64748b;cursor:pointer;';
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openBlockRef.current();
      });
      stack.appendChild(btn);
    };
    // Coalesce mutation bursts into one inject per frame. Lexical mutates this
    // subtree constantly; running inject()'s querySelectors on every single
    // mutation is pure waste since the handle stack only appears occasionally.
    let injectRaf = 0;
    const scheduleInject = () => {
      if (injectRaf) return;
      injectRaf = requestAnimationFrame(() => {
        injectRaf = 0;
        inject();
      });
    };
    const mo = new MutationObserver(scheduleInject);
    mo.observe(root, { childList: true, subtree: true });
    inject();

    return () => {
      root.removeEventListener('mousemove', onMove);
      mo.disconnect();
      if (injectRaf) cancelAnimationFrame(injectRaf);
    };
  }, [rootRef]);

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
const pickerBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 60, display: 'grid', placeItems: 'center', background: 'rgba(15,23,42,0.35)' };
const pickerCard: React.CSSProperties = { width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', padding: 16, borderRadius: 12, background: 'white', boxShadow: '0 20px 50px rgba(0,0,0,0.28)', font: 'system-ui' };
const pickerClose: React.CSSProperties = { border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer', fontSize: 15 };
const tabRow: React.CSSProperties = { display: 'inline-flex', gap: 2, padding: 2, marginBottom: 14, background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 9, alignSelf: 'flex-start' };
const tabBtn: React.CSSProperties = { padding: '4px 14px', border: 'none', borderRadius: 7, background: 'transparent', color: '#64748b', cursor: 'pointer', font: '600 12.5px system-ui' };
const tabBtnActive: React.CSSProperties = { ...tabBtn, background: 'white', color: '#4f46e5', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' };
const tabBody: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto' };
const fieldLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: '#94a3b8', font: '600 11px system-ui', letterSpacing: '0.03em', textTransform: 'uppercase' };
const fieldInput: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, font: '13px system-ui', color: '#334155', textTransform: 'none', letterSpacing: 0 };
const dropZone: React.CSSProperties = { display: 'grid', placeItems: 'center', minHeight: 92, padding: 16, border: '2px dashed #d1d5db', borderRadius: 10, background: '#f8fafc', color: '#64748b', cursor: 'pointer', font: '13px system-ui', textAlign: 'center' };
const folderBtn: React.CSSProperties = { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#475569', cursor: 'pointer', font: '600 12.5px system-ui', textTransform: 'none', letterSpacing: 0 };
const folderPop: React.CSSProperties = { marginTop: 6, border: '1px solid #e5e7eb', borderRadius: 8, background: 'white', overflow: 'hidden' };
const folderSearch: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 'none', borderBottom: '1px solid #eef2f7', font: '12.5px system-ui', outline: 'none' };
const folderScroll: React.CSSProperties = { maxHeight: 160, overflow: 'auto' };
const folderItem: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', borderBottom: '1px solid #f1f5f9', background: 'white', color: '#334155', cursor: 'pointer', font: '12.5px ui-monospace, "SF Mono", monospace' };
const modalPrimary: React.CSSProperties = { padding: '7px 16px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 13px system-ui' };
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
