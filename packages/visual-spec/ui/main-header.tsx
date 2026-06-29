import { type CommentRecord, buildApplyPrompt, useComments, useInspector, useSpecsRoot } from '../core/app';
import { useEffect, useRef, useState } from 'react';
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

type ApplyEvent =
  | { type: 'start'; openCount: number }
  | { type: 'log'; level: string; text: string }
  | { type: 'done'; ok: boolean; applied: number; exitCode: number | null }
  | { type: 'error'; message: string };

/**
 * Run the apply-comments skill on the server (`claude -p`) and stream progress.
 * Consumes the SSE response via fetch streaming (not EventSource) so there is no
 * auto-reconnect — a dropped connection must never silently re-spawn claude.
 * On completion, refreshes both the comment cart and the rendered source.
 */
function ApplyButton({ openCount }: { openCount: number }) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handle = (e: ApplyEvent) => {
    if (e.type === 'start') setLogLines([`Applying ${e.openCount} comment(s)…`]);
    else if (e.type === 'log') setLogLines((l) => [...l.slice(-300), e.text]);
    else if (e.type === 'error') setLogLines((l) => [...l.slice(-300), `⚠ ${e.message}`]);
    else if (e.type === 'done') {
      setPhase(e.ok ? 'done' : 'error');
      setSummary(e.ok ? `Applied ${e.applied} comment(s)` : `claude exited ${e.exitCode ?? '—'}`);
      // The skill edited files + flipped statuses on disk; pull both fresh.
      window.dispatchEvent(new CustomEvent('vs:comments-changed'));
      window.dispatchEvent(new CustomEvent('vs:source-changed'));
    }
  };

  const run = async () => {
    if (phase === 'running' || openCount === 0) return;
    setPhase('running');
    setSummary('');
    setLogLines(['Starting…']);
    setOpen(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/__vs/apply', { signal: ac.signal });
      if (res.status === 409) {
        setPhase('error');
        setSummary('An apply is already running.');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: SSE frame split
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data:'));
          if (data) handle(JSON.parse(data.slice(5).trim()) as ApplyEvent);
        }
      }
      // Stream ended without a done frame (e.g. server crash).
      setPhase((p) => (p === 'running' ? 'error' : p));
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setPhase('error');
      setSummary((err as Error).message || 'Apply failed');
    } finally {
      abortRef.current = null;
    }
  };

  const running = phase === 'running';
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => (logLines.length ? setOpen((v) => !v) : void run())}
        disabled={openCount === 0 && phase === 'idle'}
        title="Apply the open comments with claude (runs the apply-comments skill)"
        style={{ ...applyBtn, opacity: openCount === 0 && phase === 'idle' ? 0.5 : 1 }}
      >
        {running ? <Spinner /> : '✨'} {running ? 'Applying…' : 'Apply'}
      </button>
      {open && logLines.length > 0 && (
        <div style={applyPop}>
          <div style={applyPopHead}>
            <span style={{ fontWeight: 700 }}>
              {running ? 'Applying comments' : phase === 'done' ? '✓ Done' : phase === 'error' ? '⚠ Stopped' : 'Apply'}
            </span>
            {!running && (
              <button type="button" onClick={() => void run()} style={rerunBtn} title="Run again">
                ↻ Run again
              </button>
            )}
          </div>
          {summary && <div style={{ fontSize: 12, color: phase === 'error' ? '#b91c1c' : '#15803d', padding: '0 10px 6px' }}>{summary}</div>}
          <pre style={applyLog}>{logLines.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        border: '2px solid rgba(255,255,255,0.5)',
        borderTopColor: 'white',
        borderRadius: '50%',
        animation: 'vs-spin 0.7s linear infinite',
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

export function MainHeader({ file, onNavigate, withInspector = false }: { file: string; onNavigate?: (f: string) => void; withInspector?: boolean }) {
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
        {withInspector && <InspectorToggle />}

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

        <ApplyButton openCount={open.length} />
      </div>
      <style>{'@keyframes vs-spin{to{transform:rotate(360deg)}}'}</style>
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
const startBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#334155', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const startBtnActive: React.CSSProperties = { ...startBtn, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8' };
const secondary: React.CSSProperties = { padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#334155', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const applyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const applyPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 420, maxWidth: '80vw', background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.16)', zIndex: 41, overflow: 'hidden' };
const applyPopHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid #f1f5f9', fontSize: 13 };
const rerunBtn: React.CSSProperties = { padding: '3px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: 'white', color: '#475569', cursor: 'pointer', font: '12px system-ui', fontWeight: 600 };
const applyLog: React.CSSProperties = { margin: 0, padding: '8px 10px', maxHeight: 280, overflow: 'auto', font: '11.5px ui-monospace, "SF Mono", monospace', color: '#334155', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fbfaff' };
const toast: React.CSSProperties = { color: '#16a34a', fontWeight: 600, fontSize: 13 };
const allPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.16)', padding: 10, zIndex: 41 };
const allTitle: React.CSSProperties = { fontSize: 12, opacity: 0.6, padding: '2px 4px 8px', borderBottom: '1px solid #f1f5f9', marginBottom: 4 };
const allFile: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '2px 4px', cursor: 'pointer', font: '12px ui-monospace, monospace', color: '#1d4ed8', fontWeight: 600 };
const allItem: React.CSSProperties = { padding: '4px 4px 4px 10px', borderLeft: '2px solid #e5e7eb', margin: '4px 0 4px 4px', fontSize: 13, color: '#334155' };
