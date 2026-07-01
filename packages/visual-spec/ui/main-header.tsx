import { type CommentRecord, buildApplyPrompt, useComments, useInspector, useSpecsRoot } from '../core/app';
import { memo, useEffect, useReducer, useRef, useState } from 'react';
import { HelpButton } from './help-page';

function CommentIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** The brand mark: three offset spec "sheets", echoing a stack of reviewed pages. */
function SpecMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id="vs-mark" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect x="9" y="4.5" width="16" height="20" rx="3" fill="url(#vs-mark)" opacity="0.28" />
      <rect x="6.5" y="6" width="16" height="20" rx="3" fill="url(#vs-mark)" opacity="0.5" />
      <rect x="4" y="7.5" width="16" height="20" rx="3" fill="url(#vs-mark)" />
      <path d="M7.5 13.5h9M7.5 17h9M7.5 20.5h5.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.92" />
    </svg>
  );
}

function FolderIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function CopyIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/** Brand lockup + the full on-disk path of the file shown in the main section. */
function Brand({ file }: { file: string }) {
  const root = useSpecsRoot();
  const [pathCopied, setPathCopied] = useState(false);

  // Full path to the displayed file, joined with the platform separator inferred from root.
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const fullPath = root && file ? `${root}${sep}${file}` : root;

  const copyPath = async () => {
    if (!fullPath) return;
    try {
      await navigator.clipboard.writeText(fullPath);
    } catch {
      window.prompt('File path:', fullPath);
    }
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1600);
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
      <SpecMark />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={wordmarkRow}>
          <span style={wordmark}>Visual Specs</span>
          <span style={byline}>by Uncle&#8209;Dev</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, minWidth: 0 }}>
          <button
            type="button"
            onClick={copyPath}
            title={fullPath ? `Click to copy · ${fullPath}` : 'Locating specs…'}
            style={pathBtn}
          >
            <span style={{ color: '#94a3b8', display: 'flex' }}><FolderIcon /></span>
            <span style={pathText}>{root || 'locating specs…'}</span>
            {file && (
              <>
                <span style={pathSep}>›</span>
                <span style={pathFile}>{file}</span>
              </>
            )}
            <span style={{ color: pathCopied ? '#16a34a' : '#cbd5e1', display: 'flex', marginLeft: 2 }}>
              {pathCopied ? '✓' : <CopyIcon />}
            </span>
          </button>
          <ChangeDirButton />
        </div>
      </div>
    </div>
  );
}

/** Open a different directory via the OS-native folder picker, then reload. */
function ChangeDirButton() {
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      const res = await fetch('/__vs/dir/pick', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { root?: string; cancelled?: boolean; error?: string };
      if (res.ok && data.root) {
        window.location.reload(); // full reset onto the new directory
        return;
      }
      if (data.cancelled) return; // dialog dismissed — no change
      window.alert(data.error || 'Could not change the directory.');
    } catch {
      window.alert('Could not open the folder picker.');
    } finally {
      setPicking(false);
    }
  };
  return (
    <button
      type="button"
      onClick={pick}
      disabled={picking}
      title="Open a different directory (uses your system folder picker)"
      style={changeBtn}
    >
      <FolderIcon size={11} /> {picking ? 'Opening…' : 'Change…'}
    </button>
  );
}

/** Paste-into-chat variant: the shared prompt, with a placeholder header to fill in. */
function buildPrompt(open: CommentRecord[]): string {
  return `{{your skill/command/prompt}}\n\n${buildApplyPrompt(open)}`;
}

// ---- Apply activity: a SHARED, server-side job. Every tab on the same
// directory subscribes to /__vs/apply/events and watches the identical stream;
// starting/cancelling is a separate POST. So two browsers see the same run.

type ApplyLogKind = 'system' | 'tool' | 'assistant' | 'result' | 'error';
type Row = { kind: ApplyLogKind; text?: string; tool?: string; target?: string };
type AppliedComment = { id: string; path: string; comment: string; workflow: string };
type Agent = { id: string; type: string; task?: string; status: 'running' | 'done' };
type ApplyFrame =
  | { type: 'sync'; running: boolean; startedAt: number | null; events: ApplyFrame[] }
  | { type: 'start'; openCount: number; startedAt: number }
  | { type: 'log'; kind: ApplyLogKind; text?: string; tool?: string; target?: string; agentId?: string }
  | { type: 'agent-start'; agentId: string; agentType: string; task?: string }
  | { type: 'agent-done'; agentId: string }
  | { type: 'done'; ok: boolean; applied: number; appliedComments?: AppliedComment[]; exitCode: number | null; cancelled?: boolean }
  | { type: 'error'; message: string };

type ApplyPhase = 'idle' | 'running' | 'done' | 'error' | 'cancelled';
type ApplyState = { phase: ApplyPhase; startedAt: number | null; rows: Row[]; summary: string; applied: AppliedComment[]; agents: Agent[] };
const APPLY_INIT: ApplyState = { phase: 'idle', startedAt: null, rows: [], summary: '', applied: [], agents: [] };
const ROW_CAP = 400;

function applyReduce(s: ApplyState, e: ApplyFrame): ApplyState {
  switch (e.type) {
    case 'sync': {
      // Rebuild from a fresh snapshot — makes EventSource reconnects idempotent.
      let st: ApplyState = { ...APPLY_INIT, startedAt: e.startedAt };
      for (const ev of e.events) st = applyReduce(st, ev);
      return e.running ? { ...st, phase: 'running' } : st;
    }
    case 'start':
      return { ...APPLY_INIT, phase: 'running', startedAt: e.startedAt };
    case 'log':
      return { ...s, rows: [...s.rows.slice(-ROW_CAP), { kind: e.kind, text: e.text, tool: e.tool, target: e.target }] };
    case 'agent-start':
      // Dedupe by id — a replayed sync must not double-list an agent.
      return s.agents.some((a) => a.id === e.agentId)
        ? s
        : { ...s, agents: [...s.agents, { id: e.agentId, type: e.agentType, task: e.task, status: 'running' }] };
    case 'agent-done':
      // Ignore ids we never tracked (every tool_result emits one, not just Tasks).
      return s.agents.some((a) => a.id === e.agentId)
        ? { ...s, agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, status: 'done' } : a)) }
        : s;
    case 'error':
      return { ...s, rows: [...s.rows.slice(-ROW_CAP), { kind: 'error', text: e.message }] };
    case 'done':
      return {
        ...s,
        applied: e.appliedComments ?? [],
        // Any sub-agent still flagged running when the run ends is, by definition, finished.
        agents: s.agents.map((a) => ({ ...a, status: 'done' })),
        phase: e.cancelled ? 'cancelled' : e.ok ? 'done' : 'error',
        summary: e.cancelled
          ? `Cancelled — ${e.applied} applied before stop`
          : e.ok
            ? `Applied ${e.applied} comment${e.applied === 1 ? '' : 's'}`
            : `claude exited ${e.exitCode ?? '—'}`,
      };
    default:
      return s;
  }
}

const TOOL_GLYPH: Record<string, string> = {
  Read: '⌖', Edit: '✎', Write: '✎', MultiEdit: '✎', NotebookEdit: '✎',
  Bash: '⌘', Skill: '✦', Task: '⚇', Grep: '⌕', Glob: '⌕', TodoWrite: '☑', AskUserQuestion: '?',
};
const toolGlyph = (t?: string) => (t && TOOL_GLYPH[t]) || '▸';
const kindGlyph = (k: ApplyLogKind) => (k === 'error' ? '!' : k === 'result' ? '✓' : '·');
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The running clock, isolated in its own leaf so its 250ms tick re-renders only
 * this text node — NOT the parent ApplyButton and its (up to 400-row) feed. Keeps
 * the activity panel from pegging the CPU while a run is in flight. When not
 * running it holds the last value (the SAME instance persists across the
 * running→done transition, so the duration stays put).
 */
function ElapsedTimer({ startedAt, running }: { startedAt: number | null; running: boolean }) {
  const [elapsed, setElapsed] = useState(() => (startedAt ? Date.now() - startedAt : 0));
  useEffect(() => {
    if (!running || !startedAt) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  return <>{fmtElapsed(elapsed)}</>;
}

type ApplyView = 'closed' | 'scope' | 'activity';

/** The Apply control: scope chooser → shared live activity feed + timer + cancel. */
function ApplyButton({ open, file }: { open: CommentRecord[]; file: string }) {
  const [state, dispatch] = useReducer(applyReduce, APPLY_INIT);
  const [view, setView] = useState<ApplyView>('closed');
  const feedRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const openCount = open.length;
  // The active file is whatever is shown in the main section; its comments share its path.
  const activeFile = open.filter((c) => c.target.path === file);

  // Always-on subscription — this is what makes activity shared across tabs.
  // Frames are coalesced and flushed once per animation frame: a fast `claude`
  // can emit a burst of stream-json lines, and dispatching each one separately
  // would re-render (and re-reconcile the feed) per line — enough to peg a core.
  // Batching collapses a burst into a single render.
  useEffect(() => {
    const es = new EventSource('/__vs/apply/events');
    let pending: ApplyFrame[] = [];
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      const batch = pending;
      pending = [];
      for (const f of batch) dispatch(f); // React 18 batches these into one render
    };
    es.onmessage = (ev) => {
      const frame = JSON.parse(ev.data) as ApplyFrame;
      pending.push(frame);
      // A live `done` (sync's done events are nested, never land here): the skill
      // edited files + flipped statuses on disk — refresh the cart and the source.
      if (frame.type === 'done') {
        window.dispatchEvent(new CustomEvent('vs:comments-changed'));
        window.dispatchEvent(new CustomEvent('vs:source-changed'));
      }
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    return () => {
      es.close();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  const running = state.phase === 'running';

  // Stick the feed to the newest row.
  useEffect(() => {
    if (view === 'activity' && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [state.rows.length, view]);

  // Click-outside closes the popover (the SSE subscription stays connected regardless).
  useEffect(() => {
    if (view === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setView('closed');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [view]);

  const start = (ids?: string[]) => {
    setView('activity');
    void fetch('/__vs/apply/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids ? { ids } : {}),
    }).catch(() => {}); // activity arrives via the stream
  };
  const cancel = () => void fetch('/__vs/apply/cancel', { method: 'POST' }).catch(() => {});

  // Button click: while there's a run (live or finished) toggle the activity panel;
  // otherwise open the scope chooser to pick what to apply.
  const onButton = () => {
    if (running || state.rows.length || state.summary) setView((v) => (v === 'closed' ? 'activity' : 'closed'));
    else setView((v) => (v === 'scope' ? 'closed' : 'scope'));
  };

  const titles: Record<ApplyPhase, string> = { running: 'Applying comments', done: 'Done', cancelled: 'Cancelled', error: 'Stopped', idle: 'Apply' };
  const title = titles[state.phase];

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onButton}
        disabled={openCount === 0 && state.phase === 'idle'}
        title="Apply the open comments with claude (runs the apply-comments skill)"
        style={{ ...applyBtn, opacity: openCount === 0 && state.phase === 'idle' ? 0.5 : 1 }}
      >
        {running ? <PulseDot /> : '✨'}{' '}
        {running ? (
          <>
            Applying · <ElapsedTimer startedAt={state.startedAt} running={running} />
          </>
        ) : (
          'Apply'
        )}
      </button>

      {view === 'scope' && (
        <ScopeChooser
          workspaceCount={openCount}
          activeFile={activeFile}
          file={file}
          onClose={() => setView('closed')}
          onRun={start}
        />
      )}

      {view === 'activity' && (
        <div style={applyPop}>
          <div style={applyPopHead}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <StatusDot phase={state.phase} />
              <span style={{ fontWeight: 700 }}>{title}</span>
              {(running || state.startedAt) && (
                <span style={timerPill}>
                  <ElapsedTimer startedAt={state.startedAt} running={running} />
                </span>
              )}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {running ? (
                <button type="button" onClick={cancel} style={cancelBtn} title="Stop the run (kills claude)">
                  ■ Cancel
                </button>
              ) : (
                <button type="button" onClick={() => setView('scope')} disabled={openCount === 0} style={{ ...rerunBtn, opacity: openCount === 0 ? 0.5 : 1 }} title="Run again">
                  ↻ Run again
                </button>
              )}
              <button type="button" onClick={() => setView('closed')} style={closeBtn} title="Close" aria-label="Close">
                ✕
              </button>
            </span>
          </div>

          {state.summary && (
            <div style={{ ...summaryLine, color: state.phase === 'error' ? '#b91c1c' : state.phase === 'cancelled' ? '#b45309' : '#15803d' }}>
              {state.summary}
            </div>
          )}

          {state.applied.length > 0 && <AppliedList applied={state.applied} />}

          {(running || state.agents.length > 0) && <AgentStrip phase={state.phase} agents={state.agents} />}

          <div ref={feedRef} style={feedScroll}>
            {state.rows.length === 0 ? (
              <div style={{ padding: '14px 12px', color: '#94a3b8', fontSize: 12.5 }}>Waiting for claude…</div>
            ) : (
              <ul style={feedList}>
                {state.rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only feed
                  <ActivityRow key={i} row={row} />
                ))}
              </ul>
            )}
          </div>
          <div style={modelNote}>Runs with your default Claude model.</div>
        </div>
      )}
    </div>
  );
}

/** Pre-run scope picker: whole workspace, the active file, or a hand-picked subset. */
function ScopeChooser({
  workspaceCount,
  activeFile,
  file,
  onClose,
  onRun,
}: {
  workspaceCount: number;
  activeFile: CommentRecord[];
  file: string;
  onClose: () => void;
  onRun: (ids?: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const fileName = file ? basename(file) : '';
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div style={applyPop}>
      <div style={applyPopHead}>
        <span style={{ fontWeight: 700 }}>Apply comments…</span>
        <button type="button" onClick={onClose} style={closeBtn} title="Close" aria-label="Close">
          ✕
        </button>
      </div>

      {!picking ? (
        <div style={{ padding: 8 }}>
          <button type="button" onClick={() => onRun()} disabled={workspaceCount === 0} style={scopeRow}>
            <span style={scopeTitle}>Whole workspace</span>
            <span style={scopeCount}>{workspaceCount}</span>
          </button>
          <button
            type="button"
            onClick={() => onRun(activeFile.map((c) => c.id))}
            disabled={activeFile.length === 0}
            style={{ ...scopeRow, opacity: activeFile.length === 0 ? 0.5 : 1 }}
            title={fileName ? `Apply comments on ${fileName}` : 'Open a file to scope to it'}
          >
            <span style={scopeTitle}>This file{fileName ? <span style={scopeSub}> · {fileName}</span> : ''}</span>
            <span style={scopeCount}>{activeFile.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={activeFile.length === 0}
            style={{ ...scopeRow, opacity: activeFile.length === 0 ? 0.5 : 1 }}
          >
            <span style={scopeTitle}>Pick comments…</span>
            <span style={{ ...scopeCount, background: 'transparent', color: '#94a3b8' }}>›</span>
          </button>
        </div>
      ) : (
        <>
          <ul style={{ ...feedList, maxHeight: 280, overflow: 'auto' }}>
            {activeFile.map((c) => (
              <li key={c.id} style={pickItem}>
                <label style={pickLabel}>
                  <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} style={{ marginTop: 3 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 11, opacity: 0.55, display: 'block' }}>
                      {c.target.heading ?? '(top)'}
                      {c.target.startLine != null ? ` · L${c.target.startLine}` : ''}
                    </span>
                    <span>{c.comment}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div style={pickFooter}>
            <button type="button" onClick={() => setPicking(false)} style={rerunBtn}>
              ‹ Back
            </button>
            <button
              type="button"
              onClick={() => onRun([...checked])}
              disabled={checked.size === 0}
              style={{ ...applyBtn, minWidth: 0, padding: '6px 12px', opacity: checked.size === 0 ? 0.5 : 1 }}
            >
              ✨ Apply selected ({checked.size})
            </button>
          </div>
        </>
      )}
      <div style={modelNote}>Runs with your default Claude model.</div>
    </div>
  );
}

/** Structured list of the comments that flipped to "applied" this run. */
function AppliedList({ applied }: { applied: AppliedComment[] }) {
  return (
    <div style={appliedWrap}>
      <div style={appliedHead}>
        ✅ Applied {applied.length} comment{applied.length === 1 ? '' : 's'}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {applied.map((c) => (
          <li key={c.id} style={appliedItem}>
            <code style={appliedPath} title={c.path}>
              {basename(c.path)}
            </code>
            {c.workflow !== 'visual-spec' && <span style={appliedFlow}>{c.workflow}</span>}
            <span style={appliedText} title={c.comment}>
              {c.comment}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const AGENT_GLYPH = (type: string) => (type === 'main' ? '✦' : '⚇');

/** Compact strip of agents: the main session + each spawned sub-agent, with status. */
function AgentStrip({ phase, agents }: { phase: ApplyPhase; agents: Agent[] }) {
  const mainStatus: 'running' | 'done' = phase === 'running' ? 'running' : 'done';
  const chips = [{ id: 'main', type: 'apply-comments', status: mainStatus }, ...agents];
  return (
    <div style={agentStrip}>
      {chips.map((a) => (
        <span key={a.id} style={agentChip} title={('task' in a && a.task) || a.type}>
          <span style={{ opacity: 0.7 }}>{AGENT_GLYPH(a.id === 'main' ? 'main' : a.type)}</span>
          <span style={{ fontWeight: 600 }}>{a.type}</span>
          {a.status === 'running' ? <PulseAgentDot /> : <span style={{ color: '#16a34a' }}>✓</span>}
        </span>
      ))}
    </div>
  );
}

/** A small purple pulse for an in-flight agent chip. */
function PulseAgentDot() {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#7c3aed', animation: 'vs-pulse 1.1s ease-in-out infinite' }} />;
}

/**
 * One row of the activity feed — a glyph chip + content tuned to the kind.
 * Memoized: row objects keep identity across renders (the reducer never mutates
 * them), so an incoming frame only re-renders the new row, not the whole list.
 */
const ActivityRow = memo(function ActivityRow({ row }: { row: Row }) {
  if (row.kind === 'tool') {
    const display = row.target ? (row.tool === 'Bash' ? row.target.slice(0, 80) : basename(row.target)) : '';
    return (
      <li style={rowLi}>
        <span style={{ ...glyphChip, background: '#ede9fe', color: '#6d28d9' }}>{toolGlyph(row.tool)}</span>
        <div style={rowBody}>
          <span style={{ fontWeight: 600, color: '#3730a3' }}>{row.tool}</span>
          {display && (
            <code style={targetChip} title={row.target}>
              {display}
            </code>
          )}
        </div>
      </li>
    );
  }
  const tone =
    row.kind === 'error'
      ? { dot: { background: '#fee2e2', color: '#b91c1c' }, text: { color: '#b91c1c' } }
      : row.kind === 'result'
        ? { dot: { background: '#dcfce7', color: '#15803d' }, text: { color: '#0f172a', fontWeight: 600 } }
        : { dot: { background: '#f1f5f9', color: '#94a3b8' }, text: { color: '#64748b', fontStyle: 'italic' as const } };
  return (
    <li style={rowLi}>
      <span style={{ ...glyphChip, ...tone.dot }}>{kindGlyph(row.kind)}</span>
      <div style={{ ...rowBody, ...tone.text }}>{row.text}</div>
    </li>
  );
});

/** A pulsing dot for the button while a run is in flight. */
function PulseDot() {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'white', animation: 'vs-pulse 1.1s ease-in-out infinite' }} />;
}

/** Header status indicator, colour-coded per phase. */
function StatusDot({ phase }: { phase: ApplyPhase }) {
  const color = phase === 'running' ? '#7c3aed' : phase === 'done' ? '#16a34a' : phase === 'error' ? '#dc2626' : phase === 'cancelled' ? '#d97706' : '#94a3b8';
  return (
    <span
      style={{
        display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color,
        ...(phase === 'running' ? { animation: 'vs-pulse 1.1s ease-in-out infinite' } : {}),
      }}
    />
  );
}

/** The inspector on/off toggle — only meaningful for markdown (needs InspectorProvider). */
function InspectorToggle() {
  const { active, setActive } = useInspector();
  return (
    <button type="button" onClick={() => setActive(!active)} title="Same as pressing I" style={active ? startBtnActive : startBtn}>
      <CommentIcon /> {active ? 'Commenting…' : 'Start comments'}
    </button>
  );
}

export type ViewMode = 'view' | 'edit';

/** Segmented View / Edit switch — shown only for markdown files. */
function ModeToggle({ mode, onModeChange }: { mode: ViewMode; onModeChange: (m: ViewMode) => void }) {
  return (
    <div style={segWrap} role="tablist" aria-label="View or edit">
      {(['view', 'edit'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => onModeChange(m)}
          style={mode === m ? segBtnActive : segBtn}
          title={m === 'view' ? 'Read & comment' : 'Edit the markdown source'}
        >
          {m === 'view' ? 'View' : 'Edit'}
        </button>
      ))}
    </div>
  );
}

export function MainHeader({
  file,
  onNavigate,
  withInspector = false,
  isMarkdown = false,
  mode = 'view',
  onModeChange,
}: {
  file: string;
  onNavigate?: (f: string) => void;
  withInspector?: boolean;
  isMarkdown?: boolean;
  mode?: ViewMode;
  onModeChange?: (m: ViewMode) => void;
}) {
  const { comments } = useComments(); // all files = the cart
  const open = comments.filter((c) => c.status === 'open');
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const cartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAll) return;
    const onDown = (e: MouseEvent) => {
      if (cartRef.current && !cartRef.current.contains(e.target as Node)) setShowAll(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showAll]);

  const copy = async () => {
    if (open.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildPrompt(open));
    } catch {
      // clipboard may be blocked; fall back to a prompt window
      window.prompt('Copy this prompt for your agent:', buildPrompt(open));
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header style={bar}>
      <Brand file={file} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <HelpButton />
        {isMarkdown && onModeChange && <ModeToggle mode={mode} onModeChange={onModeChange} />}
        {withInspector && mode === 'view' && <InspectorToggle />}

        {copied && <span style={toast}>✓ Copied</span>}
        <div ref={cartRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => open.length > 0 && setShowAll((v) => !v)}
            title="View all collected comments"
            style={{ ...cart, border: 'none', cursor: open.length > 0 ? 'pointer' : 'default' }}
          >
            <CommentIcon size={13} /> {open.length}
          </button>
          {showAll && open.length > 0 && (
            <AllComments
              open={open}
              onPick={(f) => { onNavigate?.(f); setShowAll(false); }}
            />
          )}
        </div>

        <button
          type="button"
          onClick={copy}
          disabled={open.length === 0}
          title="Copy a prompt for your agent to apply these comments"
          style={{ ...secondary, opacity: open.length === 0 ? 0.5 : 1 }}
        >
          📋 Copy prompt
        </button>

        <ApplyButton open={open} file={file} />
      </div>
      <style>{'@keyframes vs-pulse{0%,100%{opacity:1}50%{opacity:0.35}}'}</style>
    </header>
  );
}

/** Dropdown listing every collected comment, grouped by file. Click jumps to the file. */
function AllComments({ open, onPick }: { open: CommentRecord[]; onPick: (surfaceId: string) => void }) {
  const byPath = new Map<string, CommentRecord[]>();
  for (const c of open) (byPath.get(c.target.path) ?? byPath.set(c.target.path, []).get(c.target.path)!).push(c);

  return (
    <div style={allPop}>
      <div style={allTitle}>{open.length} comment{open.length === 1 ? '' : 's'} collected</div>
      <div style={{ overflow: 'auto', maxHeight: 420 }}>
        {[...byPath.entries()].map(([p, cs]) => (
          <div key={p} style={{ padding: '6px 0' }}>
            <button type="button" onClick={() => onPick(p)} style={allFile} title={`Open ${p}`}>
              {p} <span style={{ opacity: 0.5, fontWeight: 400 }}>({cs.length})</span>
            </button>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {cs.map((c) => (
                <li key={c.id} style={allItem}>
                  <div style={{ fontSize: 11, opacity: 0.55 }}>{c.target.heading ?? '(top)'} · L{c.target.startLine}</div>
                  <div>{c.comment}</div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Brand-only header for the empty state (no specs loaded → no comment controls). */
export function BrandHeader() {
  return (
    <header style={bar}>
      <Brand file="" />
      <div style={{ flexShrink: 0 }}>
        <HelpButton />
      </div>
    </header>
  );
}

const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";

const bar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '12px 18px',
  borderBottom: '1px solid #e5e7eb',
  background: 'linear-gradient(180deg, #ffffff 0%, #fbfaff 100%)',
  font: '13px system-ui',
  flexShrink: 0,
  // Establish a stacking context above the content below so header popovers
  // (Apply activity, all-comments) paint over the editor + inspector instead of
  // being overlapped by them. Below the full-screen help modal (zIndex 100).
  position: 'relative',
  zIndex: 60,
};
const wordmarkRow: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, lineHeight: 1 };
const wordmark: React.CSSProperties = {
  font: `700 18px ${DISPLAY}`,
  letterSpacing: '-0.02em',
  background: 'linear-gradient(92deg, #4f46e5 0%, #8b5cf6 70%)',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: '#4f46e5',
};
const byline: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#a78bca',
  background: '#f3f0fc',
  border: '1px solid #ece6fb',
  borderRadius: 5,
  padding: '2px 6px',
};
const pathBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  border: '1px solid transparent',
  background: 'transparent',
  borderRadius: 7,
  padding: '2px 6px 2px 2px',
  cursor: 'pointer',
  color: '#64748b',
};
const changeBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: '11px system-ui', fontWeight: 600 };
const pathText: React.CSSProperties = { font: '11.5px ui-monospace, "SF Mono", monospace', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const pathSep: React.CSSProperties = { color: '#cbd5e1', fontSize: 13, flexShrink: 0 };
const pathFile: React.CSSProperties = { font: '600 11.5px ui-monospace, "SF Mono", monospace', color: '#7c3aed', flexShrink: 0 };
const cart: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#f1f5f9', borderRadius: 99, padding: '3px 10px', fontSize: 13, color: '#475569' };
const segWrap: React.CSSProperties = { display: 'inline-flex', padding: 2, gap: 2, background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 9 };
const segBtn: React.CSSProperties = { padding: '5px 12px', border: 'none', borderRadius: 7, background: 'transparent', color: '#64748b', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const segBtnActive: React.CSSProperties = { ...segBtn, background: 'white', color: '#4f46e5', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' };
const startBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#334155', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const startBtnActive: React.CSSProperties = { ...startBtn, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8' };
const secondary: React.CSSProperties = { padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#334155', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const applyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '13px system-ui', fontWeight: 600, minWidth: 92, justifyContent: 'center' };
const applyPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 440, maxWidth: '82vw', background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 16px 48px rgba(76,29,149,0.18)', zIndex: 41, overflow: 'hidden' };
const applyPopHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 11px', borderBottom: '1px solid #f1f5f9', fontSize: 13, background: 'linear-gradient(180deg,#ffffff,#fbfaff)' };
const rerunBtn: React.CSSProperties = { padding: '3px 9px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: '12px system-ui', fontWeight: 600, flexShrink: 0 };
const cancelBtn: React.CSSProperties = { padding: '3px 10px', border: '1px solid #fecaca', borderRadius: 6, background: '#fef2f2', color: '#dc2626', cursor: 'pointer', font: '12px system-ui', fontWeight: 700, flexShrink: 0 };
const closeBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', color: '#64748b', cursor: 'pointer', font: '12px system-ui', fontWeight: 700, flexShrink: 0 };
const modelNote: React.CSSProperties = { padding: '7px 12px', borderTop: '1px solid #f1f5f9', color: '#94a3b8', fontSize: 11, fontStyle: 'italic', background: '#fbfaff' };
const scopeRow: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', padding: '10px 11px', margin: '2px 0', border: '1px solid #ece6fb', borderRadius: 9, background: '#fbfaff', color: '#1e293b', cursor: 'pointer', font: '13px system-ui' };
const scopeTitle: React.CSSProperties = { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const scopeSub: React.CSSProperties = { fontWeight: 400, color: '#7c3aed', font: '12px ui-monospace, monospace' };
const scopeCount: React.CSSProperties = { flexShrink: 0, minWidth: 22, textAlign: 'center', background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '1px 8px', fontSize: 12, fontWeight: 700 };
const pickItem: React.CSSProperties = { padding: '6px 12px', borderTop: '1px solid #f6f4fd' };
const pickLabel: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5, color: '#334155', lineHeight: 1.4 };
const pickFooter: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 11px', borderTop: '1px solid #f1f5f9' };
const appliedWrap: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #f1f5f9', background: '#f7fdf9' };
const appliedHead: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#15803d', marginBottom: 5 };
const appliedItem: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 7, padding: '2px 0', fontSize: 12.5, color: '#334155', overflow: 'hidden' };
const appliedPath: React.CSSProperties = { flexShrink: 0, font: '600 11px ui-monospace, monospace', color: '#15803d', background: '#dcfce7', borderRadius: 5, padding: '1px 6px' };
const appliedFlow: React.CSSProperties = { flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#7c3aed', background: '#ede9fe', borderRadius: 5, padding: '1px 6px' };
const appliedText: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const agentStrip: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px', borderBottom: '1px solid #f1f5f9', background: '#faf9ff' };
const agentChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', border: '1px solid #ece6fb', borderRadius: 999, background: 'white', fontSize: 11.5, color: '#475569' };
const timerPill: React.CSSProperties = { font: '11.5px ui-monospace, "SF Mono", monospace', color: '#6d28d9', background: '#f3f0fc', border: '1px solid #ece6fb', borderRadius: 999, padding: '1px 8px' };
const summaryLine: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px 8px' };
const feedScroll: React.CSSProperties = { maxHeight: 300, overflow: 'auto', background: '#fbfaff' };
const feedList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: '6px 0' };
const rowLi: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', padding: '4px 12px', lineHeight: 1.45 };
const glyphChip: React.CSSProperties = { flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginTop: 1, borderRadius: 6, fontSize: 11, fontWeight: 700, fontFamily: 'ui-monospace, monospace' };
const rowBody: React.CSSProperties = { minWidth: 0, fontSize: 12.5, display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', overflowWrap: 'anywhere' };
const targetChip: React.CSSProperties = { font: '11.5px ui-monospace, "SF Mono", monospace', color: '#475569', background: '#f1f5f9', borderRadius: 5, padding: '1px 6px' };
const toast: React.CSSProperties = { color: '#16a34a', fontWeight: 600, fontSize: 13 };
const allPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.16)', padding: 10, zIndex: 41 };
const allTitle: React.CSSProperties = { fontSize: 12, opacity: 0.6, padding: '2px 4px 8px', borderBottom: '1px solid #f1f5f9', marginBottom: 4 };
const allFile: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '2px 4px', cursor: 'pointer', font: '12px ui-monospace, monospace', color: '#1d4ed8', fontWeight: 600 };
const allItem: React.CSSProperties = { padding: '4px 4px 4px 10px', borderLeft: '2px solid #e5e7eb', margin: '4px 0 4px 4px', fontSize: 13, color: '#334155' };
