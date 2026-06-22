import { type CommentRecord, useComments, useInspector, useSpecsRoot } from '@visual-spec/core/app';
import { useEffect, useRef, useState } from 'react';

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

/** Build a paste-into-chat prompt from the collected comments (the "cart"). */
function buildPrompt(open: CommentRecord[]): string {
  const lines: string[] = [];
  lines.push('{{your skill/command/prompt}}');
  lines.push('');
  lines.push(`Apply ${open.length} review comment(s) I left in the visual-spec browser using the "apply-comments" skill.`);
  lines.push('');
  lines.push('Source of truth is visual-spec-comments.json. Take only status:"open" and GROUP BY workflow. For each comment, locate the target by SNIPPET (+ heading for markdown; the line number may have drifted, do not trust it blindly). For workflow "visual-spec", apply the change in place and keep the file well-formed; for any other workflow, hand the resolved comment to that workflow skill. Then set each handled comment\'s status to "applied" (audit trail — do not delete). Finish with a traceability table: id · workflow · target · what changed / handed off.');
  lines.push('');
  lines.push(`Comments (${open.length}):`);
  open.forEach((c, i) => {
    const t = c.target;
    const isRange = t.endLine != null && t.endLine > (t.startLine ?? 0);
    lines.push('');
    lines.push(`${i + 1}. [${c.workflow}] ${t.kind === 'folder' ? 'Folder' : 'File'}: ${t.path}`);
    if (t.kind !== 'folder') {
      const where = t.startLine != null ? (isRange ? `lines ${t.startLine}–${t.endLine}` : `line ${t.startLine}`) : 'whole file';
      lines.push(`   Where: ${t.heading ? `${t.heading} · ` : ''}${where}`);
      if (t.snippet) lines.push(`   ${isRange ? 'From' : 'Context'}: "${t.snippet}"`);
      if (isRange && t.endSnippet) lines.push(`   Through: "${t.endSnippet}"`);
    }
    lines.push(`   Comment: ${c.comment}`);
  });
  return lines.join('\n');
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
          style={{ ...primary, opacity: open.length === 0 ? 0.5 : 1 }}
        >
          📋 Copy prompt
        </button>
      </div>
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
const primary: React.CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const toast: React.CSSProperties = { color: '#16a34a', fontWeight: 600, fontSize: 13 };
const allPop: React.CSSProperties = { position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.16)', padding: 10, zIndex: 41 };
const allTitle: React.CSSProperties = { fontSize: 12, opacity: 0.6, padding: '2px 4px 8px', borderBottom: '1px solid #f1f5f9', marginBottom: 4 };
const allFile: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '2px 4px', cursor: 'pointer', font: '12px ui-monospace, monospace', color: '#1d4ed8', fontWeight: 600 };
const allItem: React.CSSProperties = { padding: '4px 4px 4px 10px', borderLeft: '2px solid #e5e7eb', margin: '4px 0 4px 4px', fontSize: 13, color: '#334155' };
