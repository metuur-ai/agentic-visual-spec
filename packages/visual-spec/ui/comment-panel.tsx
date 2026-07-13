import { collectSection, headingBlockOf, useComments, useInspector } from '../core/app';
import { useState } from 'react';
import { toPath } from './md-path';
import { WorkflowSelect, loadWorkflow } from './workflow-select';
import { CommentHistoryList, locate } from './comment-history-list';

/** Nearest heading at or above the clicked element — the robust markdown anchor. */
function nearestHeading(anchor: HTMLElement, root: HTMLElement): string | null {
  if (/^H[1-6]$/.test(anchor.tagName)) return anchor.textContent?.trim() ?? null;
  const heads = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
  let best: HTMLElement | null = null;
  for (const h of heads) {
    const precedes = (h.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (precedes) best = h;
    else break;
  }
  return best?.textContent?.trim() ?? null;
}

type PanelTab = 'open' | 'history';

export function CommentPanel({ file, width }: { file: string; width: number }) {
  const { active, selection, setSelection } = useInspector();
  const selected = selection[0] ?? null;
  const last = selection[selection.length - 1] ?? null;
  const isRange = selection.length > 1;
  const path = toPath(file);
  const comments = useComments(path);
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState(loadWorkflow);
  const [tab, setTab] = useState<PanelTab>('open');

  // When a single heading is selected, offer to grab everything under it.
  const root = selected ? (selected.anchor.closest('[data-inspector-root]') as HTMLElement | null) : null;
  const headingBlock = selected && root && !isRange ? headingBlockOf(root, selected.anchor) : null;
  const selectSection = () => {
    if (!root || !headingBlock) return;
    const section = collectSection(root, headingBlock);
    if (section.length > 1) setSelection(section);
  };

  if (!active) {
    return (
      <aside style={{ ...panel, width }}>
        <Header />
        <SelectionHelp />
        <TabBar tab={tab} onTab={setTab} />
        <p style={hint}>Press <kbd>I</kbd> to start commenting.</p>
        {tab === 'open' ? (
          <CommentList path={path} comments={comments} />
        ) : (
          <CommentHistoryList path={path} comments={comments.comments} />
        )}
      </aside>
    );
  }

  const heading = selected
    ? nearestHeading(selected.anchor, (selected.anchor.closest('[data-inspector-root]') as HTMLElement) ?? document.body)
    : null;

  const submit = async () => {
    if (!selected || !text.trim()) return;
    const root = (selected.anchor.closest('[data-inspector-root]') as HTMLElement) ?? document.body;
    await comments.add({
      path,
      kind: 'range',
      workflow: workflow || 'visual-spec',
      heading: nearestHeading(selected.anchor, root),
      startLine: selected.line,
      snippet: (selected.anchor.textContent ?? '').trim().slice(0, 160),
      comment: text.trim(),
      ...(isRange && last
        ? {
            endLine: last.line,
            endSnippet: (last.anchor.textContent ?? '').trim().slice(0, 160),
          }
        : {}),
    });
    setText('');
  };

  return (
    <aside style={{ ...panel, width }}>
      <Header />
      <SelectionHelp />
      <TabBar tab={tab} onTab={setTab} />
      {tab === 'open' ? (
        <>
          {selected ? (
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.6 }}>commenting on</div>
              <div style={{ margin: '2px 0 10px' }}>
                <strong>{heading ?? '(top of file)'}</strong>
                <span style={{ opacity: 0.55 }}>
                  {isRange && last ? ` · lines ${selected.line}–${last.line} · ${selection.length} blocks` : ` · line ${selected.line}`}
                </span>
              </div>
              {headingBlock && (
                <button type="button" onClick={selectSection} style={sectionBtn} title="Extend the selection to every block under this heading">
                  ⤢ Select all content under this heading
                </button>
              )}
              <WorkflowSelect value={workflow} onChange={setWorkflow} />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(); }}
                placeholder="Your comment (⌘/Ctrl+Enter)…"
                style={textarea}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <button type="button" onClick={submit} style={btnPrimary}>Add comment</button>
              </div>
            </div>
          ) : (
            <p style={hint}>Click a block in the spec to comment on it.</p>
          )}
          <CommentList path={path} comments={comments} />
        </>
      ) : (
        <CommentHistoryList path={path} comments={comments.comments} />
      )}
    </aside>
  );
}

function Header() {
  return <header style={{ padding: 12, borderBottom: '1px solid #e5e7eb', fontWeight: 700 }}>Comments</header>;
}

function TabBar({ tab, onTab }: { tab: PanelTab; onTab: (t: PanelTab) => void }) {
  return (
    <div style={tabBarStyle}>
      <button type="button" onClick={() => onTab('open')} style={tab === 'open' ? tabActive : tabInactive}>Open</button>
      <button type="button" onClick={() => onTab('history')} style={tab === 'history' ? tabActive : tabInactive}>History</button>
    </div>
  );
}

/** Compact "how to select" guide, including selecting multiple sections at once. */
function SelectionHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div style={helpBox}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={helpToggle} aria-expanded={open}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <InfoIcon /> How to select what you comment on
        </span>
        <span style={{ opacity: 0.5, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>›</span>
      </button>
      {open && (
        <ul style={helpList}>
          <li><strong>One block</strong> — click any paragraph, list, or heading.</li>
          <li><strong>A range</strong> — click the first block, then <kbd style={kbd}>Shift</kbd>+click the last. Everything between is included.</li>
          <li><strong>A whole section</strong> — click a heading, then <em>“Select all content under this heading”</em>, or <kbd style={kbd}>Alt</kbd>/<kbd style={kbd}>⌥ CMD </kbd> + click the heading. Grabs every block down to the next heading of the same or higher level.</li>
          <li><kbd style={kbd}>Esc</kbd> clears the selection.</li>
        </ul>
      )}
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CommentList({ path, comments }: { path: string; comments: ReturnType<typeof useComments> }) {
  // Only open comments: once the apply-comments skill marks one "applied", it drops off the list.
  const mine = comments.comments.filter((c) => c.target.path === path && c.status === 'open');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!mine.length) return null;
  return (
    <div style={{ padding: 12, borderTop: '1px solid #e5e7eb' }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>{mine.length} open on this file</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        {mine.map((c) => (
          <li key={c.id} style={card}>
            <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.target.heading ?? '(top)'} · L{c.target.startLine}{c.target.endLine ? `–${c.target.endLine}` : ''}
            </div>
            <div style={{ margin: '2px 0' }}>{c.comment}</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <button
                type="button"
                onClick={() => locate(c.target)}
                title="Show where this comment was added in the file"
                aria-label="Show in file"
                style={locateBtn}
              >
                <LocateIcon />
              </button>
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
  );
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
const tabBarStyle: React.CSSProperties = { display: 'flex', borderBottom: '1px solid #e5e7eb', background: '#f8fafc' };
const tabBase: React.CSSProperties = { flex: 1, padding: '7px 0', border: 'none', background: 'transparent', cursor: 'pointer', font: '12px system-ui', fontWeight: 600, color: '#475569' };
const tabActive: React.CSSProperties = { ...tabBase, borderBottom: '2px solid #2563eb', color: '#1d4ed8', background: 'white' };
const tabInactive: React.CSSProperties = { ...tabBase, borderBottom: '2px solid transparent' };
const hint: React.CSSProperties = { padding: 12, opacity: 0.6, fontSize: 13 };
const helpBox: React.CSSProperties = { borderBottom: '1px solid #f1f5f9', background: '#f8fafc' };
const helpToggle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '8px 12px', border: 'none', background: 'transparent', cursor: 'pointer', font: '12px system-ui', fontWeight: 600, color: '#475569' };
const helpList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: '0 14px 12px', display: 'grid', gap: 7, fontSize: 12.5, lineHeight: 1.5, color: '#475569' };
const kbd: React.CSSProperties = { font: '11px ui-monospace, monospace', background: 'white', border: '1px solid #cbd5e1', borderBottomWidth: 2, borderRadius: 4, padding: '0 4px' };
const sectionBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8, padding: '5px 10px', border: '1px solid #c7d2fe', borderRadius: 6, background: '#eef2ff', color: '#4338ca', cursor: 'pointer', font: '12px system-ui', fontWeight: 600 };
const textarea: React.CSSProperties = { width: '100%', height: 70, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: 'inherit', resize: 'vertical' };
const btnPrimary: React.CSSProperties = { padding: '5px 12px', border: '1px solid #2563eb', borderRadius: 4, background: '#2563eb', color: 'white', cursor: 'pointer', font: 'inherit' };
const card: React.CSSProperties = { border: '1px solid #f1f5f9', borderRadius: 8, padding: 8, overflowWrap: 'anywhere' };
const locateBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer' };
const delBtn: React.CSSProperties = { ...locateBtn, color: '#ef4444' };
const confirmYes: React.CSSProperties = { padding: '2px 8px', border: '1px solid #ef4444', borderRadius: 4, background: '#ef4444', color: 'white', cursor: 'pointer', fontSize: 12 };
const confirmNo: React.CSSProperties = { padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#475569', cursor: 'pointer', fontSize: 12 };
