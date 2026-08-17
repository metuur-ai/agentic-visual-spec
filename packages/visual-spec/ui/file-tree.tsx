/**
 * file-tree.tsx — the directory browser sidebar. Driven by the flat TreeEntry[]
 * from /__vs/tree (dirs + files). Folders expand/collapse and are themselves
 * selectable (so you can comment on a folder); files are selectable.
 *
 * THE ENTRIES MAY ARRIVE ALL AT ONCE OR A DIRECTORY AT A TIME. The local sidebar hands
 * over a full walk and this component never asks for more. A review has no full walk to
 * hand over — its source answers one directory per call — so it passes `onExpand`, which
 * is told each time a folder opens and pushes that directory's entries into the same flat
 * list. Nothing about the rendering differs; the second caller simply keeps appending.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileKind, TreeEntry } from './use-tree';
import { BusyLabel, LoadingLine } from './spinner';

type TreeNode = {
  name: string;
  path: string;
  type: 'dir' | 'file';
  kind?: FileKind;
  children: TreeNode[];
};

function buildTree(entries: TreeEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const byPath = new Map<string, TreeNode>([['', root]]);
  // Entries are sorted by path, so parents precede children.
  for (const e of entries) {
    const parentPath = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    const parent = byPath.get(parentPath) ?? root;
    const node: TreeNode = { name: e.name, path: e.path, type: e.type, kind: e.kind, children: [] };
    byPath.set(e.path, node);
    parent.children.push(node);
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; // folders first
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

const KIND_GLYPH: Record<FileKind, string> = {
  markdown: '📄',
  code: '🟦',
  text: '📃',
  image: '🖼️',
  binary: '📦',
};

/**
 * Which write the inline input is currently collecting. There is at most one open
 * at a time — a single field in a narrow column, so two would fight for the space
 * and for the error line beneath it.
 */
type Draft = { kind: 'create' } | { kind: 'rename'; from: string };

/** The shared inline-input state, threaded down so a file row can host its own rename. */
type WriteState = {
  draft: Draft | null;
  value: string;
  error: string | null;
  busy: boolean;
  setValue: (v: string) => void;
  begin: (draft: Draft, initial: string) => void;
  submit: () => void;
  dismiss: () => void;
};

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/**
 * R-5.7 — the server's refusals name the extension, the collision, the missing
 * parent. Those sentences are the whole value of the failure path, so they are
 * shown as written. The status line is only a last resort for a response that
 * carried no message at all.
 */
function serverMessage(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error ? error : `Request failed with status ${status}`;
}

export function FileTree({
  entries,
  current,
  filter,
  onPick,
  commentCounts,
  onCreated,
  onRenamed,
  readOnly = false,
  defaultOpen = false,
  onExpand,
  pending,
}: {
  entries: TreeEntry[];
  current: string;
  filter: string;
  onPick: (entry: TreeEntry) => void;
  commentCounts?: Map<string, number>;
  onCreated?: (path: string) => void;
  onRenamed?: (from: string, to: string) => void;
  /**
   * Told the path of every folder that is open, as it opens. A caller whose entries are
   * already complete omits it; a caller that reads one directory per call uses it to
   * fetch that directory and append what comes back.
   *
   * It fires per folder and only for folders that are actually open, which is what keeps
   * an unopened sibling free: nothing is read on its behalf.
   */
  onExpand?: (path: string) => void;
  /** Folders whose entries are still being read, so the row can say so rather than look empty. */
  pending?: Set<string>;
  /**
   * R-13.19 — browse without any way to write. A Pull Request checkout is a review
   * surface, not a workspace: the tree still expands and still opens files, but "+ New
   * file" and the per-row rename are not rendered at all. Not disabled — absent. A
   * disabled control still tells the reviewer that writing is a thing this view does,
   * and the create/rename routes write to the *served* directory regardless of which
   * tree the row came from, so offering them here would be offering the wrong write.
   */
  readOnly?: boolean;
  /**
   * Start with every folder open. The filter already force-opens the tree, on the same
   * reasoning — a reader who has narrowed the set wants to see it, not click down to
   * it — and a small, deliberately-chosen set of paths is that situation arrived at from
   * the other direction. A caller that omits this gets the collapsed tree.
   */
  defaultOpen?: boolean;
}) {
  const q = filter.trim().toLowerCase();
  const matching = useMemo(() => (q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : entries), [entries, q]);
  const tree = useMemo(() => buildTree(matching), [matching]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The in-flight guard has to be readable synchronously: two clicks land in the
  // same React batch, so a `busy` state read would still be false on the second.
  const inFlight = useRef(false);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const begin = (next: Draft, initial: string) => {
    setDraft(next);
    setValue(initial);
    setError(null);
  };

  // R-5.6 / R-5.9 — dismissal clears the value and issues nothing.
  const dismiss = () => {
    setDraft(null);
    setValue('');
    setError(null);
  };

  const submit = () => {
    if (!draft || inFlight.current) return; // R-5.8
    const path = value.trim();
    if (!path) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res =
          draft.kind === 'create'
            ? await postJson('/__vs/tree/create', { path })
            : await postJson('/__vs/tree/rename', { from: draft.from, to: path });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setError(serverMessage(body, res.status)); // R-5.7 — the typed path stays put
          return;
        }
        // The server answers with the path it actually wrote (it may have appended
        // `.md`), so navigation follows that rather than what was typed.
        const written = (body as { path?: unknown } | null)?.path;
        const settled = typeof written === 'string' ? written : path;
        if (draft.kind === 'create') onCreated?.(settled);
        else onRenamed?.(draft.from, settled);
        dismiss();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  // `begin` is replaced rather than merely hidden behind: a row that somehow called it
  // in read-only mode would open an input onto the served directory, which is not the
  // tree being browsed. The one write path is closed at its source.
  const write: WriteState = readOnly
    ? { draft: null, value: '', error: null, busy: false, setValue: () => {}, begin: () => {}, submit: () => {}, dismiss: () => {} }
    : { draft, value, error, busy, setValue, begin, submit, dismiss };

  return (
    <div>
      {!readOnly && (
        <>
          <div style={writeBar}>
            <button type="button" onClick={() => begin({ kind: 'create' }, '')} style={newFileBtn}>
              + New file
            </button>
          </div>
          {draft?.kind === 'create' && <PathInput write={write} label="New file path" submitLabel="Create" indent={8} />}
        </>
      )}
      <ul style={listReset}>
        {tree.children.map((node) => (
          <TreeItem key={node.path} node={node} depth={0} current={current} onPick={onPick} expanded={expanded} toggle={toggle} forceOpen={defaultOpen || q.length > 0} commentCounts={commentCounts} write={write} readOnly={readOnly} onExpand={onExpand} pending={pending} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The one inline field, used by both writes. Not a modal: it is a single path in a
 * column already sized for one.
 */
function PathInput({ write, label, submitLabel, indent }: { write: WriteState; label: string; submitLabel: string; indent: number }) {
  return (
    <div style={{ ...inlineWrap, paddingLeft: indent }}>
      <form
        style={inlineForm}
        onSubmit={(e) => {
          e.preventDefault();
          write.submit();
        }}
      >
        <input
          autoFocus
          aria-label={label}
          value={write.value}
          onChange={(e) => write.setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && write.dismiss()}
          placeholder="notes/kickoff.md"
          style={pathInput}
        />
        <button type="submit" disabled={write.busy} style={inlineSubmit}>
          <BusyLabel busy={write.busy}>{submitLabel}</BusyLabel>
        </button>
        <button type="button" onClick={write.dismiss} aria-label="Cancel" style={inlineCancel}>
          ✕
        </button>
      </form>
      {write.error && (
        <div role="alert" style={inlineError}>
          {write.error}
        </div>
      )}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  current,
  onPick,
  expanded,
  toggle,
  forceOpen,
  commentCounts,
  write,
  readOnly = false,
  onExpand,
  pending,
}: {
  node: TreeNode;
  depth: number;
  current: string;
  onPick: (entry: TreeEntry) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
  forceOpen: boolean;
  commentCounts?: Map<string, number>;
  write: WriteState;
  readOnly?: boolean;
  onExpand?: (path: string) => void;
  pending?: Set<string>;
}) {
  const pad = 8 + depth * 13;
  const active = node.path === current;
  const count = commentCounts?.get(node.path) ?? 0;
  const [hover, setHover] = useState(false);
  // Computed above the file branch because the effect below it must run on every render,
  // and a file's row returns early.
  const open = node.type === 'dir' && (forceOpen || expanded.has(node.path) || current.startsWith(`${node.path}/`));
  // The one place a directory is asked for. It fires when the folder opens and not when
  // it is merely rendered, so the siblings a reviewer never opens are never read; asking
  // twice for the same folder is the caller's to ignore, and `useReviewTree` does.
  useEffect(() => {
    if (open) onExpand?.(node.path);
  }, [open, node.path, onExpand]);

  if (node.type === 'file') {
    // R-5.2 — the rename input replaces the row it belongs to, prefilled with that
    // row's path, so correcting a typo is an edit rather than a retype.
    if (write.draft?.kind === 'rename' && write.draft.from === node.path) {
      return (
        <li>
          <PathInput write={write} label="Rename path" submitLabel="Rename" indent={pad + 16} />
        </li>
      );
    }
    return (
      <li>
        <div style={fileRow} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <button
            type="button"
            onClick={() => onPick({ path: node.path, name: node.name, type: 'file', kind: node.kind })}
            title={count ? `${node.path} — ${count} comment${count === 1 ? '' : 's'}` : node.path}
            style={{ ...row, paddingLeft: pad + 16, ...(active ? rowActive : {}), ...(count ? rowCommented : {}) }}
          >
            <span style={glyph}>{KIND_GLYPH[node.kind ?? 'binary']}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
            {/* The number carries the meaning; the label is what stops a bare `2` from
            being a number with no noun for anything reading it aloud. */}
            {count > 0 && (
              <span data-vs-file-comments={node.path} aria-label={`${count} comment${count === 1 ? '' : 's'}`} style={countBadge}>
                {count}
              </span>
            )}
          </button>
          {!readOnly && (hover || active) && (
            <button
              type="button"
              onClick={() => write.begin({ kind: 'rename', from: node.path }, node.path)}
              aria-label={`Rename ${node.path}`}
              title={`Rename ${node.path}`}
              style={rowAction}
            >
              ✎
            </button>
          )}
        </div>
      </li>
    );
  }

  const hasDescendantComments = !!commentCounts && [...commentCounts.keys()].some((p) => p.startsWith(`${node.path}/`));
  return (
    <li>
      {/* Folder row: clicking anywhere on it only expands/collapses — browsing the
          tree never changes the main content (so an in-progress edit is preserved).
          Opening a folder as content (to comment on it) is the separate ⤢ action. */}
      <div
        style={{ ...folderRow, ...(active ? rowActive : {}), ...(count ? rowCommented : {}) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <button
          type="button"
          onClick={() => toggle(node.path)}
          title={`${node.path} — ${open ? 'collapse' : 'expand'}`}
          style={{ ...folderToggle, paddingLeft: pad, color: active ? '#1d4ed8' : '#334155' }}
        >
          <span style={chevron}>{open ? '▾' : '▸'}</span>
          <span style={folderGlyph}>{open ? '📂' : '📁'}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        </button>
        {/* The number carries the meaning; the label is what stops a bare `2` from
            being a number with no noun for anything reading it aloud. */}
            {count > 0 && (
              <span data-vs-file-comments={node.path} aria-label={`${count} comment${count === 1 ? '' : 's'}`} style={countBadge}>
                {count}
              </span>
            )}
        {!open && count === 0 && hasDescendantComments && <span style={folderDot} title="Contains comments" />}
        {(hover || active) && (
          <button
            type="button"
            onClick={() => onPick({ path: node.path, name: node.name, type: 'dir' })}
            title="Open this folder in the main panel (to comment on it)"
            style={folderOpen}
          >
            ⤢
          </button>
        )}
      </div>
      {open && (
        <ul style={listReset}>
          {node.children.map((child) => (
            <TreeItem key={child.path} node={child} depth={depth + 1} current={current} onPick={onPick} expanded={expanded} toggle={toggle} forceOpen={forceOpen} commentCounts={commentCounts} write={write} readOnly={readOnly} onExpand={onExpand} pending={pending} />
          ))}
          {/* An open folder that is still being read looks exactly like an empty one, and
              the two are opposite things to a reviewer. */}
          {pending?.has(node.path) && (
            <li>
              <LoadingLine style={{ paddingLeft: pad + 16, fontSize: 12 }}>Reading {node.name}…</LoadingLine>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const writeBar: React.CSSProperties = { display: 'flex', padding: '0 6px 6px' };
const newFileBtn: React.CSSProperties = { padding: '3px 8px', border: '1px solid #e5e7eb', borderRadius: 4, background: 'white', color: '#7c3aed', cursor: 'pointer', font: '600 11px system-ui' };
const fileRow: React.CSSProperties = { display: 'flex', alignItems: 'center', width: '100%', paddingRight: 6, borderRadius: 4, overflow: 'hidden' };
const rowAction: React.CSSProperties = { flexShrink: 0, marginLeft: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, padding: 0, border: 'none', borderRadius: 4, background: 'transparent', color: '#64748b', cursor: 'pointer', fontSize: 11 };
const inlineWrap: React.CSSProperties = { padding: '2px 6px 6px' };
const inlineForm: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4 };
const pathInput: React.CSSProperties = { flex: 1, minWidth: 0, padding: '3px 6px', border: '1px solid #c4b5fd', borderRadius: 4, fontSize: 12, fontFamily: 'ui-monospace, monospace' };
const inlineSubmit: React.CSSProperties = { flexShrink: 0, padding: '3px 8px', border: 'none', borderRadius: 4, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 11px system-ui' };
const inlineCancel: React.CSSProperties = { flexShrink: 0, padding: '3px 6px', border: 'none', borderRadius: 4, background: 'transparent', color: '#64748b', cursor: 'pointer', fontSize: 11 };
const inlineError: React.CSSProperties = { marginTop: 4, color: '#b91c1c', font: '11px system-ui', lineHeight: 1.4, wordBreak: 'break-word' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left', padding: '3px 6px', border: 'none', borderRadius: 4, background: 'transparent', cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, monospace', fontWeight: 400, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const folderRow: React.CSSProperties = { display: 'flex', alignItems: 'center', width: '100%', paddingRight: 6, borderRadius: 4, overflow: 'hidden' };
const folderToggle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, textAlign: 'left', padding: '3px 6px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, monospace', fontWeight: 600, color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const folderOpen: React.CSSProperties = { flexShrink: 0, marginLeft: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, padding: 0, border: 'none', borderRadius: 4, background: 'transparent', color: '#64748b', cursor: 'pointer', fontSize: 12 };
const rowActive: React.CSSProperties = { background: '#eff6ff', color: '#1d4ed8', fontWeight: 600 };
const rowCommented: React.CSSProperties = { background: '#fffbeb', color: '#92400e', fontWeight: 600, boxShadow: 'inset 2px 0 0 #d97706' };
const countBadge: React.CSSProperties = { flexShrink: 0, marginLeft: 4, minWidth: 16, height: 16, padding: '0 5px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 99, background: '#d97706', color: 'white', fontSize: 10, fontWeight: 700 };
const folderDot: React.CSSProperties = { flexShrink: 0, marginLeft: 4, width: 7, height: 7, borderRadius: 99, background: '#d97706' };
const chevron: React.CSSProperties = { width: 10, fontSize: 9, opacity: 0.6 };
const folderGlyph: React.CSSProperties = { fontSize: 11 };
const glyph: React.CSSProperties = { fontSize: 10, width: 14, textAlign: 'center' };
