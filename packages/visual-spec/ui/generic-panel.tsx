/**
 * generic-panel.tsx — comment panel for non-markdown targets: a whole file, a
 * line range within a code/text file, an image, or a folder. (Markdown keeps its
 * own inspector-based panel in comment-panel.tsx.)
 */
import { useComments } from '../core/app';
import { useState } from 'react';
import type { LineSelection } from './code-view';
import type { FileKind } from './use-tree';
import { WorkflowSelect, loadWorkflow } from './workflow-select';

export function GenericPanel({
  path,
  type,
  kind,
  selection,
  content,
  width,
}: {
  path: string;
  type: 'dir' | 'file';
  kind?: FileKind;
  selection: LineSelection | null;
  content?: string;
  width: number;
}) {
  const comments = useComments(path);
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState(loadWorkflow);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const open = comments.comments.filter((c) => c.target.path === path && c.status === 'open');

  const isFolder = type === 'dir';
  const targetKind = isFolder ? 'folder' : selection ? 'range' : 'file';

  const submit = async () => {
    if (!text.trim()) return;
    const selectedContent =
      selection && content
        ? content.replace(/\n$/, '').split('\n').slice(selection.startLine - 1, selection.endLine).join('\n')
        : undefined;
    await comments.add({
      path,
      kind: targetKind,
      workflow: workflow || 'visual-spec',
      comment: text.trim(),
      ...(selection
        ? {
            startLine: selection.startLine,
            endLine: selection.endLine,
            snippet: selection.snippet,
            endSnippet: selection.endSnippet,
            ...(selectedContent ? { selectedContent } : {}),
          }
        : {}),
    });
    setText('');
  };

  const where = isFolder
    ? 'this folder'
    : selection
      ? selection.startLine === selection.endLine
        ? `line ${selection.startLine}`
        : `lines ${selection.startLine}–${selection.endLine}`
      : 'this file';

  return (
    <aside style={{ ...panel, width }}>
      <header style={head}>Comments</header>
      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.6 }}>commenting on</div>
        <div style={{ margin: '2px 0 10px' }}>
          <strong>{where}</strong>
          {isFolder && <span style={{ opacity: 0.55 }}> · folder</span>}
          {kind && !isFolder && !selection && <span style={{ opacity: 0.55 }}> · {kind}</span>}
        </div>
        {!isFolder && !selection && kind !== 'image' && kind !== 'binary' && (
          <p style={tip}>Click a line (Shift+click for a range) to comment on specific lines, or just comment on the whole file.</p>
        )}
        <WorkflowSelect value={workflow} onChange={setWorkflow} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          }}
          placeholder="Your comment (⌘/Ctrl+Enter)…"
          style={textarea}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button type="button" onClick={submit} style={btn}>
            Add comment
          </button>
        </div>
      </div>
      {open.length > 0 && (
        <div style={{ padding: 12, borderTop: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>{open.length} open on this {isFolder ? 'folder' : 'file'}</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {open.map((c) => (
              <li key={c.id} style={card}>
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  {c.target.kind === 'range'
                    ? c.target.endLine && c.target.endLine > (c.target.startLine ?? 0)
                      ? `lines ${c.target.startLine}–${c.target.endLine}`
                      : `line ${c.target.startLine}`
                    : c.target.kind}
                </div>
                <div style={{ margin: '2px 0' }}>{c.comment}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                  {c.target.kind === 'range' && c.target.startLine != null && (
                    <button
                      type="button"
                      onClick={() => locateLine(c.target.startLine!, c.target.endLine)}
                      title="Show where this comment was added in the file"
                      aria-label="Show in file"
                      style={iconBtn}
                    >
                      <LocateIcon />
                    </button>
                  )}
                  {confirmId === c.id ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: '#475569' }}>Delete?</span>
                      <button
                        type="button"
                        onClick={() => { void comments.remove(c.id); setConfirmId(null); }}
                        style={confirmYes}
                      >
                        Yes
                      </button>
                      <button type="button" onClick={() => setConfirmId(null)} style={confirmNo}>No</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(c.id)}
                      title="Delete comment"
                      aria-label="Delete comment"
                      style={delBtn}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

/** Scroll the code view to a commented line (range → flash every row in span). */
function locateLine(startLine: number, endLine?: number) {
  const first = document.querySelector(`[data-line="${startLine}"]`) as HTMLElement | null;
  if (!first) return;
  const last = endLine && endLine > startLine ? endLine : startLine;
  const els: HTMLElement[] = [];
  for (let n = startLine; n <= last; n++) {
    const el = document.querySelector(`[data-line="${n}"]`) as HTMLElement | null;
    if (el) els.push(el);
  }
  first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const el of els) {
    el.style.transition = 'background-color 0.2s';
    el.style.backgroundColor = 'rgba(59,130,246,0.22)';
  }
  window.setTimeout(() => { for (const el of els) el.style.backgroundColor = ''; }, 1400);
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="7" />
      <line x1="12" y1="1" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="23" />
      <line x1="1" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="23" y2="12" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const panel: React.CSSProperties = { height: '100%', flexShrink: 0, boxSizing: 'border-box', borderLeft: '1px solid #e5e7eb', background: 'white', overflowY: 'auto', overflowX: 'hidden', font: '13px system-ui' };
const head: React.CSSProperties = { padding: 12, borderBottom: '1px solid #e5e7eb', fontWeight: 700 };
const tip: React.CSSProperties = { fontSize: 12.5, color: '#64748b', margin: '0 0 8px', lineHeight: 1.5 };
const textarea: React.CSSProperties = { width: '100%', height: 70, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: 'inherit', resize: 'vertical' };
const btn: React.CSSProperties = { padding: '5px 12px', border: '1px solid #2563eb', borderRadius: 4, background: '#2563eb', color: 'white', cursor: 'pointer', font: 'inherit' };
const card: React.CSSProperties = { border: '1px solid #f1f5f9', borderRadius: 8, padding: 8, overflowWrap: 'anywhere' };
const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer' };
const delBtn: React.CSSProperties = { ...iconBtn, color: '#ef4444' };
const confirmYes: React.CSSProperties = { padding: '2px 8px', border: '1px solid #ef4444', borderRadius: 4, background: '#ef4444', color: 'white', cursor: 'pointer', fontSize: 12 };
const confirmNo: React.CSSProperties = { padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#475569', cursor: 'pointer', fontSize: 12 };
