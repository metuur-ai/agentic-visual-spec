/**
 * comment-panel.tsx — the commenting sidebar.
 *
 * **Anchor source (task 7.3, R-7.4).** The panel shell — header, selection help,
 * tabs, compose form, open list, history — is one component, `Panel`. What it is
 * commenting *on* is a `CommentPanelSource`: which comments belong here, how the
 * current inspector selection is described, what creating a comment does, and
 * which comments have lost their target. Local mode's source is built by
 * `localCommentSource` from `useComments(path)` and reproduces exactly what this
 * file did before — same hook, same filter (`target.path === path`), same
 * heading/line labels, same `add` payload. Collaboration supplies a source keyed
 * on `nodeId` (`ui/collab-comment-source.ts`) and reuses this same panel rather
 * than forking it.
 */
import { collectSection, headingBlockOf, useComments, useInspector } from '../core/app';
import type { SelectedTarget } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toPath } from './md-path';
import { WorkflowSelect, loadWorkflow } from './workflow-select';
import { CommentHistoryList, locate } from './comment-history-list';
import { useActiveComment } from './active-comment';

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

/** How the current selection reads, or why it cannot be commented on at all. */
export type SelectionDescription = { title: string; detail: string } | { uncommentable: string };

/**
 * What the panel is commenting on. Everything path- or line-specific lives behind
 * this, so the shell below is identical for both modes.
 */
export type CommentPanelSource = {
  /** Surface key for the history list. */
  path: string;
  /** Every comment on this surface, already filtered to it. */
  comments: CommentRecord[];
  /**
   * Take the comment off the open list. Optional because collaboration no longer offers
   * one: a GitHub review thread is closed by resolving it on github.com (R-5.13), and a
   * control here that pretended otherwise would write a resolution this system must not
   * write. Local mode deletes its sidecar record and supplies this.
   */
  remove?: (id: string) => Promise<void>;
  /**
   * Describe the current selection. Returning `{ uncommentable }` withdraws the
   * compose form — a block with no durable identity (`data-vs-uncommentable`,
   * task 7.1) can never carry an anchor, so offering to comment on it would
   * promise something the store cannot keep.
   */
  describe: (selection: SelectedTarget[]) => SelectionDescription;
  create: (selection: SelectedTarget[], text: string, workflow: string) => Promise<void>;
  /** Row label in the open list. */
  label: (c: CommentRecord) => string;
  locate: (c: CommentRecord) => void;
  /** R-6.5 — comments whose target is gone, shown document-level with what they remember. */
  orphans: { comment: CommentRecord; targetText: string }[];
  /** Whether "select everything under this heading" applies (local markdown only). */
  supportsSections?: boolean;
  /**
   * R-9.8 — post a threaded reply. Collaboration only: a GitHub issue comment can
   * carry replies, a local sidecar comment cannot, so local mode leaves this unset
   * and the row renders no reply affordance.
   */
  reply?: (id: string, text: string) => Promise<void>;
  /**
   * R-5.14 — where this comment's thread lives on github.com, or `undefined` when it has
   * no such home. Collaboration supplies it because resolving happens there and nowhere
   * else; the row renders it as a link out rather than as a control that writes.
   */
  link?: (c: CommentRecord) => string | undefined;
};

export function CommentPanel({ file, width, source }: { file?: string; width: number; source?: CommentPanelSource }) {
  return source ? <Panel width={width} source={source} /> : <LocalCommentPanel file={file ?? ''} width={width} />;
}

/** The local source: the sidecar comments for one path, keyed by line + heading. */
function LocalCommentPanel({ file, width }: { file: string; width: number }) {
  const path = toPath(file);
  const comments = useComments(path);
  const source = useMemo<CommentPanelSource>(
    () => ({
      path,
      comments: comments.comments.filter((c) => c.target.path === path),
      remove: (id) => comments.remove(id),
      supportsSections: true,
      orphans: [],
      // `startLine` is optional: a whole-file comment (`kind: 'file'`) has no line, and
      // interpolating it unguarded renders the literal "Lundefined" next to the heading.
      // The guarded form already existed in main-header.tsx's picker; these two labels
      // were written without it.
      label: (c) =>
        c.target.startLine == null
          ? (c.target.heading ?? '(top)')
          : `${c.target.heading ?? '(top)'} · L${c.target.startLine}${c.target.endLine ? `–${c.target.endLine}` : ''}`,
      locate: (c) => locate(c.target),
      describe: (selection) => {
        const selected = selection[0]!;
        const last = selection[selection.length - 1]!;
        const isRange = selection.length > 1;
        const root = (selected.anchor.closest('[data-inspector-root]') as HTMLElement) ?? document.body;
        return {
          title: nearestHeading(selected.anchor, root) ?? '(top of file)',
          detail: isRange
            ? ` · lines ${selected.line}–${last.line} · ${selection.length} blocks`
            : ` · line ${selected.line}`,
        };
      },
      create: async (selection, text, workflow) => {
        const selected = selection[0]!;
        const last = selection[selection.length - 1]!;
        const isRange = selection.length > 1;
        const root = (selected.anchor.closest('[data-inspector-root]') as HTMLElement) ?? document.body;
        await comments.add({
          path,
          kind: 'range',
          workflow: workflow || 'visual-spec',
          heading: nearestHeading(selected.anchor, root),
          startLine: selected.line,
          snippet: (selected.anchor.textContent ?? '').trim().slice(0, 160),
          comment: text,
          ...(isRange ? { endLine: last.line, endSnippet: (last.anchor.textContent ?? '').trim().slice(0, 160) } : {}),
        });
      },
    }),
    [path, comments],
  );
  return <Panel width={width} source={source} />;
}

function Panel({ width, source }: { width: number; source: CommentPanelSource }) {
  const { active, selection, setSelection } = useInspector();
  const selected = selection[0] ?? null;
  const isRange = selection.length > 1;
  const path = source.path;
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState(loadWorkflow);
  const [tab, setTab] = useState<PanelTab>('open');

  // When a single heading is selected, offer to grab everything under it.
  const root = selected ? (selected.anchor.closest('[data-inspector-root]') as HTMLElement | null) : null;
  const headingBlock = source.supportsSections && selected && root && !isRange ? headingBlockOf(root, selected.anchor) : null;
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
          <>
            <OrphanList orphans={source.orphans} />
            <CommentList source={source} />
          </>
        ) : (
          <CommentHistoryList path={path} comments={source.comments} />
        )}
      </aside>
    );
  }

  const described = selected ? source.describe(selection) : null;
  const uncommentable = described && 'uncommentable' in described ? described.uncommentable : null;

  const submit = async () => {
    if (!selected || uncommentable || !text.trim()) return;
    await source.create(selection, text.trim(), workflow);
    setText('');
  };

  return (
    <aside style={{ ...panel, width }}>
      <Header />
      <SelectionHelp />
      <TabBar tab={tab} onTab={setTab} />
      {tab === 'open' ? (
        <>
          {described ? (
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.6 }}>commenting on</div>
              {'uncommentable' in described ? (
                <p style={notCommentable} data-vs-uncommentable-notice>
                  This block cannot carry a comment — {described.uncommentable}.
                </p>
              ) : (
                <>
                  <div style={{ margin: '2px 0 10px' }}>
                    <strong>{described.title}</strong>
                    <span style={{ opacity: 0.55 }}>{described.detail}</span>
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
                </>
              )}
            </div>
          ) : (
            <p style={hint}>Click a block in the spec to comment on it.</p>
          )}
          <OrphanList orphans={source.orphans} />
          <CommentList source={source} />
        </>
      ) : (
        <CommentHistoryList path={path} comments={source.comments} />
      )}
    </aside>
  );
}

/**
 * R-6.5 — comments whose block is no longer in the document. They are never
 * discarded and never pinned to a nearby block; they live here, at document level,
 * with an explicit marker and the last-known text of what they were about.
 * Local mode has no orphans, so this renders nothing there.
 */
function OrphanList({ orphans }: { orphans: { comment: CommentRecord; targetText: string }[] }) {
  if (!orphans.length) return null;
  return (
    <div style={{ padding: 12, borderTop: '1px solid #e5e7eb' }} data-vs-orphan-list>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
        {orphans.length} orphaned — the block they pointed at is gone
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        {orphans.map(({ comment, targetText }) => (
          <li key={comment.id} style={orphanCard} data-vs-orphan={comment.id}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', letterSpacing: 0.3 }}>ORPHANED</div>
            <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {targetText ? `“${targetText}”` : 'no last-known text'}
            </div>
            <div style={{ margin: '2px 0' }}>{comment.comment}</div>
          </li>
        ))}
      </ul>
    </div>
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

function CommentList({ source }: { source: CommentPanelSource }) {
  // Only open comments: once the apply-comments skill marks one "applied", it drops off the list.
  const mine = source.comments.filter((c) => c.status === 'open');
  const link = source.link ?? (() => undefined);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [replyId, setReplyId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const { activeId } = useActiveComment();
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  // When an inline indicator activates a comment, scroll its row into view (R-2.2).
  useEffect(() => {
    if (activeId && rows.current[activeId]) {
      rows.current[activeId]!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeId]);
  if (!mine.length) return null;
  return (
    <div style={{ padding: 12, borderTop: '1px solid #e5e7eb' }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>{mine.length} open on this file</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        {mine.map((c) => (
          <li key={c.id} ref={(el) => { rows.current[c.id] = el; }} style={{ ...card, ...(c.id === activeId ? cardActive : {}) }}>
            <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {source.label(c)}
            </div>
            <div style={{ margin: '2px 0' }}>{c.comment}</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              <button
                type="button"
                onClick={() => source.locate(c)}
                title="Show where this comment was added in the file"
                aria-label="Show in file"
                style={locateBtn}
              >
                <LocateIcon />
              </button>
              {source.reply && (
                <button
                  type="button"
                  onClick={() => { setReplyId(replyId === c.id ? null : c.id); setReplyText(''); }}
                  title="Reply to this comment"
                  aria-label="Reply"
                  style={textBtn}
                >
                  Reply
                </button>
              )}
              {/*
                * R-5.14 — the way out to github.com. It replaced a Resolve button: a
                * review thread's resolution is GitHub's, read and never written (R-5.13),
                * so the honest affordance is a link to the place the act happens.
                */}
              {link(c) && (
                <a
                  href={link(c)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open this thread on github.com — resolve it there"
                  style={textBtn}
                >
                  Open on GitHub
                </a>
              )}
              {source.remove &&
                (confirmId === c.id ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: '#475569' }}>Delete?</span>
                    <button
                      type="button"
                      onClick={() => { void source.remove!(c.id); setConfirmId(null); }}
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
                ))}
            </div>
            {source.reply && replyId === c.id && (
              <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Reply…"
                  rows={2}
                  style={{ font: 'inherit', padding: 6, border: '1px solid #cbd5e1', borderRadius: 6, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  <button type="button" onClick={() => setReplyId(null)} style={confirmNo}>Cancel</button>
                  <button
                    type="button"
                    disabled={!replyText.trim() || replyBusy}
                    onClick={() => {
                      setReplyBusy(true);
                      void source
                        .reply!(c.id, replyText.trim())
                        .then(() => { setReplyId(null); setReplyText(''); })
                        .finally(() => setReplyBusy(false));
                    }}
                    style={confirmYes}
                  >
                    {replyBusy ? 'Posting…' : 'Post reply'}
                  </button>
                </div>
              </div>
            )}
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
const cardActive: React.CSSProperties = { border: '1px solid #f59e0b', background: '#fffbeb', boxShadow: '0 0 0 2px rgba(245,158,11,0.25)' };
const locateBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer' };
const delBtn: React.CSSProperties = { ...locateBtn, color: '#ef4444' };
/** Green, not red: resolving closes a thread and destroys nothing. */
/*
 * `locateBtn` is a 22×22 square sized for an icon. A worded button borrowed it and the
 * label wrapped mid-word — "Reply" rendered as "Re / ply". Text needs to set its own
 * width, so this drops the square and forbids the break.
 */
const textBtn: React.CSSProperties = {
  ...locateBtn,
  width: 'auto',
  height: 22,
  padding: '0 6px',
  whiteSpace: 'nowrap',
  font: '12px system-ui',
};
const confirmYes: React.CSSProperties = { padding: '2px 8px', border: '1px solid #ef4444', borderRadius: 4, background: '#ef4444', color: 'white', cursor: 'pointer', fontSize: 12 };
const notCommentable: React.CSSProperties = { margin: '2px 0 0', padding: 8, border: '1px dashed #cbd5e1', borderRadius: 6, background: '#f8fafc', color: '#64748b', fontSize: 12.5 };
const orphanCard: React.CSSProperties = { ...card, border: '1px dashed #f59e0b', background: '#fffbeb' };
const confirmNo: React.CSSProperties = { padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#475569', cursor: 'pointer', fontSize: 12 };
