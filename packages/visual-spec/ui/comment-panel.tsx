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
 *
 * **P3 — this panel is the one surface that lists these comments.** The header's
 * comment count chip used to open a popover listing them too, on top of a panel
 * already showing the same rows. Two surfaces over one dataset is not redundancy a
 * reader can ignore — they scroll independently and can disagree about what is
 * selected. So the chip now asks *this* panel to reveal the comment instead, through
 * `revealInCommentPanel` below, and keeps its popover only for the case the panel
 * cannot serve: no panel on screen, or nothing on this file to reveal.
 */
import { collectSection, headingBlockOf, useComments, useInspector } from '../core/app';
import type { SelectedTarget } from '../core/app';
import type { CommentRecord } from '../core/editing/comment-doc';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toPath } from './md-path';
import { WorkflowSelect, loadWorkflow } from './workflow-select';
import { CommentHistoryList, locate } from './comment-history-list';
import { useActiveComment } from './active-comment';
import { BusyLabel } from './spinner';

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

/**
 * R-13.18 — where a comment lives, stated positively.
 *
 * Every card gets one of these, always. It exists because the panel used to say this only
 * by implication: a row with an "Open on GitHub" link and a "Reply" button was a pull
 * request thread, a row without them was local. Both controls are conditional for
 * *other* reasons — a resolved thread is deliberately not linked, a thread whose html url
 * did not resolve has nothing to link to — so a genuine GitHub comment could render with
 * neither, and be indistinguishable from a local one. Absence of a control is not a
 * label; this is.
 */
export type CommentOrigin = { where: 'local' | 'github'; label: string };

/** One reply already on a comment's thread. Rendered read-only; the panel writes none of it. */
export type PanelReply = {
  /** Stable within the thread — the REST comment id, stringified by the source. */
  id: string;
  user: string;
  body: string;
  /** ISO 8601, as GitHub reported it. */
  createdAt: string;
  htmlUrl?: string;
};

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
  /** Whether the comment is destined for a local apply run. `false` hides "Apply via". */
  supportsWorkflows?: boolean;
  /**
   * R-9.8 — post a threaded reply. Collaboration only: a GitHub issue comment can
   * carry replies, a local sidecar comment cannot, so local mode leaves this unset
   * and the row renders no reply affordance.
   */
  reply?: (id: string, text: string) => Promise<void>;
  /**
   * Whether THIS row can be replied to, when only some of them can. Unset means all can.
   *
   * A pull request review lists two kinds of row in one panel: threads that are on GitHub
   * and drafts still held on this machine. Only the first has somewhere for a reply to go,
   * and a Reply button on a draft would offer to answer a comment nobody has been sent.
   */
  canReply?: (c: CommentRecord) => boolean;
  /**
   * The replies already written on this comment's thread, oldest first.
   *
   * Reading a thread and adding to it are two different affordances, and the panel had
   * only the second: `reply` posted into a conversation the reader could not see. A pull
   * request review is where that shows — someone answers your comment on github.com and
   * the row keeps showing your sentence alone, with no sign anyone replied. Sources with
   * no threading (the local sidecar) leave this unset and nothing renders.
   */
  replies?: (c: CommentRecord) => PanelReply[];
  /**
   * R-5.14 — where this comment's thread lives on github.com, or `undefined` when it has
   * no such home. Collaboration supplies it because resolving happens there and nowhere
   * else; the row renders it as a link out rather than as a control that writes.
   */
  link?: (c: CommentRecord) => string | undefined;
  /**
   * R-13.18 — the provenance chip. Unset means every comment on this surface is one of
   * the reader's own notes, which is true of the sidecar panel: it reads and writes a
   * file on this machine and has never heard of a pull request.
   */
  origin?: (c: CommentRecord) => CommentOrigin;
  /**
   * Extra controls in a row's action bar, decided per comment by the source.
   *
   * The panel deliberately knows nothing about what they do. It grew this because a pull
   * request review's comments have a life the sidecar's do not — a draft is held on this
   * machine and then *sent* — and the alternative was a second comment panel that differed
   * from this one in one button. `locate`, `reply`, `link` and `remove` stay first-class
   * because every source either has them or provably cannot; sending is the one act that
   * belongs to exactly one source.
   */
  actions?: (c: CommentRecord) => CommentAction[];
  /** The same act over every comment it applies to — "Send all 3". Absent means none. */
  bulkAction?: CommentAction | null;
  /** A per-comment warning or receipt, rendered above the action bar. */
  notice?: (c: CommentRecord) => React.ReactNode | null;
};

/** One source-owned control. `danger` dresses it as destructive; `primary` as the act. */
export type CommentAction = {
  label: string;
  title?: string;
  tone?: 'primary' | 'danger' | 'plain';
  run: () => Promise<void> | void;
};

/**
 * The sidecar's answer, and the default for any source that does not supply one.
 *
 * It names the KIND of comment — a note the reader wrote as author, on their own files —
 * and not a stage in some journey towards GitHub. There is no such journey: nothing here
 * is destined for a pull request, which is why the row offers nothing that would send it.
 * Describing it by what it is not ("not on GitHub") made a personal note read as an unsent
 * pull-request comment, and the two are different things (see `collab-pr-review.tsx`,
 * where "draft" is the state of a comment that genuinely is on its way out).
 */
const LOCAL_ONLY: CommentOrigin = { where: 'local', label: 'Your note' };

/* ------------------------------------------------------------------ *
 * P3 — how the header's count chip reaches the open list.
 *
 * A module-level registry rather than a context or a prop, because the two ends are
 * not in one tree: `MainHeader` and `CommentPanel` are siblings under `ui/App.tsx`,
 * and threading a callback between them would mean an App-level store whose only
 * subscriber is a highlight that lasts a third of a second.
 *
 * A panel registers ONLY while it has an open comment to reveal. That is what makes
 * the chip's fallback correct rather than merely tolerable: with nothing on this file
 * the chip has nothing to scroll to here, and its popover — which lists every file's
 * comments and navigates to them — is the surface that can actually answer. So an
 * empty registry is a real answer, not a missing one.
 * ------------------------------------------------------------------ */
type RevealHandler = () => boolean;
const revealHandlers = new Set<RevealHandler>();
const presenceWatchers = new Set<() => void>();

function registerReveal(handler: RevealHandler): () => void {
  revealHandlers.add(handler);
  for (const watch of presenceWatchers) watch();
  return () => {
    revealHandlers.delete(handler);
    for (const watch of presenceWatchers) watch();
  };
}

/** Subscribe to panels appearing and disappearing. For `useSyncExternalStore`. */
export function subscribeCommentPanel(watch: () => void): () => void {
  presenceWatchers.add(watch);
  return () => {
    presenceWatchers.delete(watch);
  };
}

/** Whether a mounted panel has an open comment it could reveal. */
export function isCommentPanelListening(): boolean {
  return revealHandlers.size > 0;
}

/**
 * Ask the open list to scroll to its comment and ring it. Answers `false` where no
 * panel took it, which is the caller's cue to fall back to its own popover.
 */
export function revealInCommentPanel(): boolean {
  for (const handler of revealHandlers) if (handler()) return true;
  return false;
}

/** How long the ring stays. Short enough to read as a pointer, not as a selection. */
const REVEAL_MS = 300;

/** Motion is an accent here, never the message — the ring is legible without it. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function CommentPanel({ file, width, source }: { file?: string; width: number | string; source?: CommentPanelSource }) {
  return source ? <Panel width={width} source={source} /> : <LocalCommentPanel file={file ?? ''} width={width} />;
}

/** The local source: the sidecar comments for one path, keyed by line + heading. */
function LocalCommentPanel({ file, width }: { file: string; width: number | string }) {
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

function Panel({ width, source }: { width: number | string; source: CommentPanelSource }) {
  const { active, selection, setSelection, setActive } = useInspector();
  const selected = selection[0] ?? null;
  const isRange = selection.length > 1;
  const path = source.path;
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState(loadWorkflow);
  const [creating, setCreating] = useState(false);
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
        <StartCommenting onStart={() => setActive(true)} nothingYet={!source.comments.some((c) => c.status === 'open')} />
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

  /*
   * `create` is a round trip — a sidecar write, or a POST that mints a review draft — and
   * the button gave no sign of it. On a slow one the reviewer pressed again and got two
   * comments, so the guard is as much about that as about the missing signal.
   */
  const submit = async () => {
    if (!selected || uncommentable || !text.trim() || creating) return;
    setCreating(true);
    try {
      await source.create(selection, text.trim(), workflow);
      setText('');
    } finally {
      setCreating(false);
    }
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
                  {/*
                    * "Apply via <workflow>" names the agent that will act on the comment
                    * locally. A pull request review comment is not applied by anything
                    * here — it is sent to GitHub — so offering the choice would promise a
                    * run that never happens.
                    */}
                  {source.supportsWorkflows !== false && <WorkflowSelect value={workflow} onChange={setWorkflow} />}
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(); }}
                    placeholder="Your comment (⌘/Ctrl+Enter)…"
                    style={textarea}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                    <button type="button" onClick={submit} disabled={creating} style={btnPrimary}>
                      <BusyLabel busy={creating}>{creating ? 'Adding…' : 'Add comment'}</BusyLabel>
                    </button>
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
 * P1 — the way in, as a control rather than as an instruction.
 *
 * This slot used to read "Press I to start commenting." and hold nothing else. The
 * shortcut works and still does, but a reviewer opening the panel for the first time
 * has no reason to suspect a keyboard shortcut exists, so `I` was the entire way in
 * and it was invisible: a control nobody can see is a control that is not there.
 *
 * The button is now the control and `setActive(true)` is exactly what the `I` handler
 * in `InspectorProvider` does, so the two cannot drift apart into different behaviours.
 * The shortcut stays, demoted to what it actually is — the shorthand for the button —
 * and the hint spells out what happens next, because "start commenting" does not on
 * its own tell you that a click on the document comes before any typing.
 *
 * THE FOCUS RING IS A STYLESHEET RULE, NOT AN INLINE STYLE. Everything else in this
 * file styles inline, and `:focus-visible` cannot be expressed that way. Handling
 * focus/blur in state would paint a ring on mouse clicks too, which is the thing
 * `:focus-visible` exists to avoid.
 */
function StartCommenting({ onStart, nothingYet }: { onStart: () => void; nothingYet: boolean }) {
  return (
    <div style={startBox}>
      <style>{FOCUS_RING_CSS}</style>
      {nothingYet && <p style={startLead}>Nothing on this file yet.</p>}
      <button type="button" onClick={onStart} className="vs-focus-ring" style={startPrimary}>
        Start commenting
      </button>
      <p style={startHint} data-vs-start-hint>
        or press <kbd style={kbd}>I</kbd> — picks a line, then you write
      </p>
    </div>
  );
}

const FOCUS_RING_CSS =
  '.vs-focus-ring:focus-visible{outline:2px solid #6d28d9;outline-offset:2px;border-radius:8px}';

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
  const origin = source.origin ?? (() => LOCAL_ONLY);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /*
   * Which source-owned action is in flight, keyed `<comment id>:<label>` — and `bulk` for
   * the group one. The panel runs these, so the panel is the only place that can know they
   * are running; the source hands over a `run()` and hears nothing back.
   */
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const runAction = async (key: string, run: () => Promise<void> | void) => {
    if (runningAction) return;
    setRunningAction(key);
    try {
      await run();
    } finally {
      setRunningAction(null);
    }
  };
  const [removingId, setRemovingId] = useState<string | null>(null);
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

  /*
   * P3 — the header's count chip, answered here.
   *
   * It reveals the FIRST open comment rather than asking the chip which one it meant.
   * The chip is a count, not a selection: it says "there are three", and the useful
   * reply is to put the reader at the top of the three. `activeId` above is the other
   * direction — an inline indicator naming one specific comment — and the two stay
   * separate because this one must not leave a comment active after it fades.
   */
  const [revealed, setRevealed] = useState<string | null>(null);
  const firstId = mine[0]?.id ?? null;
  useEffect(() => {
    if (!firstId) return;
    return registerReveal(() => {
      setRevealed(firstId);
      return true;
    });
  }, [firstId]);
  useEffect(() => {
    if (!revealed) return;
    const still = prefersReducedMotion();
    rows.current[revealed]?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'nearest' });
    const timer = window.setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  if (!mine.length) return null;
  return (
    <div style={{ padding: 12, borderTop: '1px solid #e5e7eb' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, opacity: 0.6 }}>{mine.length} open on this file</span>
        <span style={{ flex: 1 }} />
        {/* "Send all 3" — the one act that applies to the group rather than to a row. */}
        {source.bulkAction && (
          <button
            type="button"
            data-vs-comment-bulk
            onClick={() => void runAction('bulk', source.bulkAction!.run)}
            disabled={runningAction !== null}
            title={source.bulkAction.title ?? ''}
            style={actionStyle(source.bulkAction.tone)}
          >
            <BusyLabel busy={runningAction === 'bulk'}>
              {runningAction === 'bulk' ? 'Sending…' : source.bulkAction.label}
            </BusyLabel>
          </button>
        )}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        {mine.map((c) => (
          <li
            key={c.id}
            ref={(el) => { rows.current[c.id] = el; }}
            {...(c.id === revealed ? { 'data-vs-revealed': '' } : {})}
            style={{
              ...card,
              ...(c.id === activeId ? cardActive : {}),
              ...(c.id === revealed ? cardRevealed : {}),
              ...(c.id === revealed && !prefersReducedMotion() ? { transition: 'box-shadow 160ms ease-out' } : {}),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                data-vs-comment-origin={origin(c).where}
                style={origin(c).where === 'github' ? originGithub : originLocal}
              >
                {origin(c).label}
              </span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {source.label(c)}
            </div>
            <div style={{ margin: '2px 0' }}>{c.comment}</div>
            {/*
              * The rest of the thread. Indented under the root and rendered plainly: this
              * is the conversation, not a control surface, and every act it offers
              * (resolve, react, edit) belongs to github.com.
              */}
            {(source.replies?.(c) ?? []).map((r) => (
              <div key={r.id} data-vs-reply={r.id} style={replyCard}>
                <div style={replyMeta}>
                  <strong style={{ fontWeight: 600 }}>{r.user}</strong>
                  <span> · {r.createdAt.slice(0, 10)}</span>
                </div>
                <div>{r.body}</div>
              </div>
            ))}
            {/* A warning the source needs the reader to see before they act on the row. */}
            {source.notice?.(c)}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, flexWrap: 'wrap' }}>
              {source.actions?.(c).map((a) => {
                const key = `${c.id}:${a.label}`;
                return (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() => void runAction(key, a.run)}
                    disabled={runningAction !== null}
                    title={a.title ?? ''}
                    style={actionStyle(a.tone)}
                  >
                    <BusyLabel busy={runningAction === key}>{a.label}</BusyLabel>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => source.locate(c)}
                title="Show where this comment was added in the file"
                aria-label="Show in file"
                style={locateBtn}
              >
                <LocateIcon />
              </button>
              {source.reply && (source.canReply?.(c) ?? true) && (
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
                      disabled={removingId !== null}
                      onClick={() => {
                        setRemovingId(c.id);
                        setConfirmId(null);
                        void source.remove!(c.id).finally(() => setRemovingId(null));
                      }}
                      style={confirmYes}
                    >
                      <BusyLabel busy={removingId === c.id}>Yes</BusyLabel>
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
                        // A refused reply leaves the composer open with the text still in
                        // it — the source reports why, and nobody has to retype a sentence
                        // the network lost.
                        .catch(() => {})
                        .finally(() => setReplyBusy(false));
                    }}
                    style={confirmYes}
                  >
                    <BusyLabel busy={replyBusy}>{replyBusy ? 'Posting…' : 'Post reply'}</BusyLabel>
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
// P1's block. The button is the only filled control in the panel's empty state, so
// weight is doing the pointing rather than a second line of prose.
const startBox: React.CSSProperties = { padding: 12, display: 'grid', justifyItems: 'start', gap: 8 };
const startLead: React.CSSProperties = { margin: 0, color: '#64748b', fontSize: 13 };
const startPrimary: React.CSSProperties = { padding: '7px 14px', border: '1px solid #7c3aed', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '600 13px system-ui' };
const startHint: React.CSSProperties = { margin: 0, color: '#94a3b8', fontSize: 12 };
const helpBox: React.CSSProperties = { borderBottom: '1px solid #f1f5f9', background: '#f8fafc' };
const helpToggle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '8px 12px', border: 'none', background: 'transparent', cursor: 'pointer', font: '12px system-ui', fontWeight: 600, color: '#475569' };
const helpList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: '0 14px 12px', display: 'grid', gap: 7, fontSize: 12.5, lineHeight: 1.5, color: '#475569' };
const kbd: React.CSSProperties = { font: '11px ui-monospace, monospace', background: 'white', border: '1px solid #cbd5e1', borderBottomWidth: 2, borderRadius: 4, padding: '0 4px' };
const sectionBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8, padding: '5px 10px', border: '1px solid #c7d2fe', borderRadius: 6, background: '#eef2ff', color: '#4338ca', cursor: 'pointer', font: '12px system-ui', fontWeight: 600 };
const textarea: React.CSSProperties = { width: '100%', height: 70, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, font: 'inherit', resize: 'vertical' };
const btnPrimary: React.CSSProperties = { padding: '5px 12px', border: '1px solid #2563eb', borderRadius: 4, background: '#2563eb', color: 'white', cursor: 'pointer', font: 'inherit' };
const card: React.CSSProperties = { border: '1px solid #f1f5f9', borderRadius: 8, padding: 8, overflowWrap: 'anywhere' };
/** R-13.18's two chips. Different words and different colours — never one chip and a gap. */
/*
 * Sending and discarding must not look like the same kind of act, so the tone is part of
 * the action rather than something every source restyles for itself.
 */
const actionBase: React.CSSProperties = { padding: '3px 10px', borderRadius: 6, cursor: 'pointer', font: '600 12px system-ui', flexShrink: 0 };
const actionPrimary: React.CSSProperties = { ...actionBase, border: '1px solid #2563eb', background: '#2563eb', color: 'white' };
const actionDanger: React.CSSProperties = { ...actionBase, border: '1px solid #fecaca', background: 'white', color: '#b91c1c' };
const actionPlain: React.CSSProperties = { ...actionBase, border: '1px solid #d1d5db', background: 'white', color: '#334155' };
function actionStyle(tone: CommentAction['tone']): React.CSSProperties {
  return tone === 'primary' ? actionPrimary : tone === 'danger' ? actionDanger : actionPlain;
}

const originChip: React.CSSProperties ={ font: '600 10px system-ui', padding: '1px 7px', borderRadius: 99, whiteSpace: 'nowrap', letterSpacing: 0.2 };
const originLocal: React.CSSProperties = { ...originChip, border: '1px solid #fcd34d', background: '#fef3c7', color: '#92400e' };
const originGithub: React.CSSProperties = { ...originChip, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534' };
const cardActive: React.CSSProperties = { border: '1px solid #f59e0b', background: '#fffbeb', boxShadow: '0 0 0 2px rgba(245,158,11,0.25)' };
/*
 * A reply, indented under its root. The left rule and the indent are the whole visual
 * grammar: GitHub's own thread reads the same way, and a reviewer who has read one there
 * needs no second convention here.
 */
const replyCard: React.CSSProperties = { margin: '4px 0 0 10px', paddingLeft: 10, borderLeft: '2px solid #e2e8f0', overflowWrap: 'anywhere' };
const replyMeta: React.CSSProperties = { fontSize: 12, color: '#64748b' };
/*
 * P3's ring. Violet, where `cardActive` is amber, because the two mean different
 * things and are both momentary: amber says "this is the comment the indicator you
 * clicked belongs to" and stays until you pick another, violet says "here is where
 * the header's count was pointing" and lets go on its own.
 */
const cardRevealed: React.CSSProperties = { border: '1px solid #7c3aed', background: '#f5f3ff', boxShadow: '0 0 0 3px rgba(124,58,237,0.25)' };
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
