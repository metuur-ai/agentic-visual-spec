/**
 * file-tree.tsx — the directory browser sidebar. Driven by the flat TreeEntry[]
 * from /__vs/tree (dirs + files). Folders expand/collapse and are themselves
 * selectable (so you can comment on a folder); files are selectable.
 */
import { useMemo, useState } from 'react';
import type { FileKind, TreeEntry } from './use-tree';

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

export function FileTree({
  entries,
  current,
  filter,
  onPick,
  commentCounts,
}: {
  entries: TreeEntry[];
  current: string;
  filter: string;
  onPick: (entry: TreeEntry) => void;
  commentCounts?: Map<string, number>;
}) {
  const q = filter.trim().toLowerCase();
  const matching = useMemo(() => (q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : entries), [entries, q]);
  const tree = useMemo(() => buildTree(matching), [matching]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  return (
    <ul style={listReset}>
      {tree.children.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} current={current} onPick={onPick} expanded={expanded} toggle={toggle} forceOpen={q.length > 0} commentCounts={commentCounts} />
      ))}
    </ul>
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
}: {
  node: TreeNode;
  depth: number;
  current: string;
  onPick: (entry: TreeEntry) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
  forceOpen: boolean;
  commentCounts?: Map<string, number>;
}) {
  const pad = 8 + depth * 13;
  const active = node.path === current;
  const count = commentCounts?.get(node.path) ?? 0;
  const [hover, setHover] = useState(false);

  if (node.type === 'file') {
    return (
      <li>
        <button
          type="button"
          onClick={() => onPick({ path: node.path, name: node.name, type: 'file', kind: node.kind })}
          title={count ? `${node.path} — ${count} comment${count === 1 ? '' : 's'}` : node.path}
          style={{ ...row, paddingLeft: pad + 16, ...(active ? rowActive : {}), ...(count ? rowCommented : {}) }}
        >
          <span style={glyph}>{KIND_GLYPH[node.kind ?? 'binary']}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
          {count > 0 && <span style={countBadge}>{count}</span>}
        </button>
      </li>
    );
  }

  const hasDescendantComments = !!commentCounts && [...commentCounts.keys()].some((p) => p.startsWith(`${node.path}/`));
  const open = forceOpen || expanded.has(node.path) || current.startsWith(`${node.path}/`);
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
        {count > 0 && <span style={countBadge}>{count}</span>}
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
            <TreeItem key={child.path} node={child} depth={depth + 1} current={current} onPick={onPick} expanded={expanded} toggle={toggle} forceOpen={forceOpen} commentCounts={commentCounts} />
          ))}
        </ul>
      )}
    </li>
  );
}

const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
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
