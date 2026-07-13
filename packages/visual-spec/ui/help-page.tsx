import { useEffect, useRef, useState } from 'react';

function HelpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** The "Help" link for the header. Self-contained: owns the open state and renders the overlay. */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="How to use Visual Specs" style={helpLink}>
        <HelpIcon /> Help
      </button>
      {open && <HelpPage onClose={() => setOpen(false)} />}
    </>
  );
}

// Quick-jump targets for the header nav — keep in sync with the Section numbers below.
const QUICK_LINKS: { n: number; label: string }[] = [
  { n: 1, label: 'What it is' },
  { n: 2, label: 'Start' },
  { n: 3, label: 'Comment' },
  { n: 4, label: 'Hand off' },
  { n: 5, label: 'Skills' },
  { n: 6, label: 'Workflows' },
  { n: 7, label: 'Ignore' },
];

/** Full-screen tutorial overlay: what Visual Specs is, how to drive it, and how the skills apply your comments. */
function HelpPage({ onClose }: { onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Close on Escape, like a normal dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Smooth-scroll the body to a section anchor.
  const jump = (n: number) => {
    bodyRef.current?.querySelector(`#vs-help-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={sheet} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="How to use Visual Specs">
        <div style={sheetHeader}>
          <div>
            <div style={title}>How to use Visual Specs</div>
            <div style={subtitle}>Point at your UI, leave comments, let your agent apply them.</div>
          </div>
          <button type="button" onClick={onClose} title="Close (Esc)" style={closeBtn}>✕</button>
        </div>

        <nav style={quickNav} aria-label="Jump to section">
          {QUICK_LINKS.map((l) => (
            <button key={l.n} type="button" onClick={() => jump(l.n)} style={quickLink} title={`Jump to “${l.label}”`}>
              {l.label}
            </button>
          ))}
        </nav>

        <div ref={bodyRef} style={body}>
          <Section n={1} heading="What this is">
            <p style={p}>
              Visual Specs is a browser for the files and folders of a project. You read what's there,
              <b> point at the exact thing you want changed</b> — a file, a range of lines, a folder, or an
              element on a rendered markdown surface — and leave a plain-language comment. The comments are
              collected into one sidecar file, <Code>visual-spec-comments.json</Code>, which your AI agent
              then reads and applies. You never have to describe <i>where</i> in prose; the pin carries the location.
            </p>
          </Section>

          <Section n={2} heading="Start the viewer">
            <p style={p}>Install the CLI once, then point it at any project directory:</p>
            <Pre>{`npm install -g @metuur/visual-spec
visual-spec .            # serve the current directory
visual-spec ./my-project # …or any path`}</Pre>
            <p style={p}>
              It opens on <Code>http://localhost:5180</Code>. Use <b>Change…</b> next to the path in the header
              to switch directories at any time.
            </p>
          </Section>

          <Section n={3} heading="Browse & comment">
            <ol style={ol}>
              <li>Pick a file or folder from the left sidebar.</li>
              <li>
                For markdown, press <Kbd>I</Kbd> or click <b>Start comments</b> to turn on the inspector, then click an
                element. For code/other files, select a line range. For a folder, comment on the folder itself.
              </li>
              <li>Type your instruction (e.g. <i>"validate the input here"</i>) and save it.</li>
              <li>
                Each comment lands in the <b>cart</b> — the <CartChip /> counter in the header. Click it to see every
                comment collected so far, grouped by file.
              </li>
            </ol>
            <p style={pMuted}>
              Markdown renders fully, including <b>relative image paths</b> like <Code>![](images/diagram.png)</Code> —
              they're resolved for display only, so the underlying <Code>.md</Code> keeps its original relative links and
              stays portable to any plain markdown viewer.
            </p>
          </Section>

          <Section n={4} heading="Hand the comments to your agent">
            <p style={p}>
              When you're done, click <b>📋 Copy prompt</b>. That copies a ready-to-paste instruction plus all your open
              comments. Paste it into your agent (Claude Code, etc.). The prompt tells the agent to apply everything via the
              <Code>apply-comments</Code> skill, using <Code>visual-spec-comments.json</Code> as the source of truth.
            </p>
          </Section>

          <Section n={5} heading="The three skills">
            <p style={p}>
              Visual Specs pairs with three agent skills. <Code>visual-spec</Code> is the entry point that routes to the
              other two depending on what you did:
            </p>
            <Skill
              name="visual-spec"
              tag="the driver"
              desc="The entry point. Checks where you are — is the viewer running? are there open comments? is there a live selection? — and routes to the right skill below. Say “use visual-spec” or “open the visual editor”."
            />
            <Skill
              name="current-target"
              tag="“change THIS”"
              desc="Conversational, marker-less edits. When you have an element selected in the viewer and just say “make this bigger” or “change this heading”, it resolves “this” from the live selection (node_modules/.visual-spec/current.json) and edits in place — no comment needed."
            />
            <Skill
              name="apply-comments"
              tag="batch apply"
              desc="The workhorse for the cart. Reads visual-spec-comments.json, takes only status:“open” comments, resolves each target by its text snippet (line numbers may have drifted), then applies in place or hands off to the comment’s workflow tag — and marks each one applied for an audit trail."
            />

            <p style={p}>Make them available to your agent once:</p>
            <Pre>{`visual-spec install-skills    # copies skills to ~/.claude/skills`}</Pre>

            <p style={{ ...p, marginTop: 14, fontWeight: 600 }}>Sample session — leave comments, then apply</p>
            <Example>{`You:   use visual-spec on ./my-specs
Agent: (Step 0) checks \`visual-spec --version\` → installs if missing,
       starts \`visual-spec ./my-specs\`, opens http://localhost:5180

You:   (in the browser) click overview.md, leave a couple of comments,
       optionally set "Apply via" → architecture-review, then come back

You:   apply my comments
Agent: (apply-comments) reads ./my-specs/visual-spec-comments.json,
       groups by workflow, applies the "visual-spec" comments in place,
       hands the "architecture-review" ones to that skill, marks each
       applied, and reports each change with its source file:line`}</Example>

            <p style={{ ...p, marginTop: 14, fontWeight: 600 }}>Or fully conversational — a live selection</p>
            <Example>{`You:   (click a heading in the viewer) change THIS heading to "Goals"
Agent: (current-target) reads node_modules/.visual-spec/current.json,
       confirms the node by tagName/text, edits it in place — no comment`}</Example>

            <table style={sayTable}>
              <thead>
                <tr>
                  <th style={th}>You say</th>
                  <th style={th}>The skill does</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={td}>"use visual-spec" / "open the visual editor"</td>
                  <td style={td}>Ensure installed, start the viewer, check state</td>
                </tr>
                <tr>
                  <td style={td}>"change this element" (pointing at it)</td>
                  <td style={td}><Code>current-target</Code> — live <Code>current.json</Code></td>
                </tr>
                <tr>
                  <td style={td}>"apply my comments"</td>
                  <td style={td}><Code>apply-comments</Code> — sidecar JSON → apply / hand off</td>
                </tr>
                <tr>
                  <td style={td}>"what's commented?"</td>
                  <td style={td}>Reads the sidecar, summarizes open comments</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <Section n={6} heading="Two ways to work">
            <Pre>{`A) Point & say          B) Batch & apply
─────────────────       ─────────────────────────
click an element        leave many comments (the cart)
say "change this"       click 📋 Copy prompt → paste
current-target edits    apply-comments resolves + applies
in place                each one, marks them applied`}</Pre>
            <p style={pMuted}>
              Comments are pinned by a text <i>snippet</i> (plus the nearest heading for markdown), so they survive small
              line-number drift. If the agent can't locate a target confidently, it skips and reports rather than guessing —
              nothing is ever silently dropped.
            </p>
          </Section>

          <Section n={7} heading="Hide files from the viewer">
            <p style={p}>
              The viewer scans the <b>whole tree</b> under your directory. To keep noise out, add a
              <Code>.visualspecignore</Code> file at the directory root — it uses <b>gitignore syntax</b>:
            </p>
            <Pre>{`# .visualspecignore  (at the root of the served directory)
dist/
build/
*.log
coverage/
**/*.snap`}</Pre>
            <ul style={ul}>
              <li><Code>.git/</Code>, <Code>node_modules/</Code>, and the comments sidecar are <b>always</b> hidden — you don't list them.</li>
              <li>Only a <Code>.visualspecignore</Code> at the root is honored. <Code>.gitignore</Code> is <b>not</b> read.</li>
            </ul>
          </Section>
        </div>

        <div style={sheetFooter}>
          <span style={{ opacity: 0.6 }}>Tip: press <Kbd>I</Kbd> on a markdown file to start commenting.</span>
          <button type="button" onClick={onClose} style={doneBtn}>Got it</button>
        </div>
      </div>
    </div>
  );
}

function Section({ n, heading, children }: { n: number; heading: string; children: React.ReactNode }) {
  return (
    <section id={`vs-help-${n}`} style={{ marginBottom: 26, scrollMarginTop: 8 }}>
      <h3 style={h3}>
        <span style={stepNum}>{n}</span>
        {heading}
      </h3>
      {children}
    </section>
  );
}

function Skill({ name, tag, desc }: { name: string; tag: string; desc: string }) {
  return (
    <div style={skillCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <code style={skillName}>{name}</code>
        <span style={skillTag}>{tag}</span>
      </div>
      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.55 }}>{desc}</div>
    </div>
  );
}

function CartChip() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f1f5f9', borderRadius: 99, padding: '1px 8px', fontSize: 12, color: '#475569', verticalAlign: 'middle' }}>
      💬 N
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code style={inlineCode}>{children}</code>;
}
function Pre({ children }: { children: React.ReactNode }) {
  return <pre style={pre}>{children}</pre>;
}
function Example({ children }: { children: React.ReactNode }) {
  return <pre style={example}>{children}</pre>;
}
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd style={kbd}>{children}</kbd>;
}

const DISPLAY = "'Bricolage Grotesque', system-ui, sans-serif";

const helpLink: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#475569', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 100, padding: 24 };
const sheet: React.CSSProperties = { width: 'min(720px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'white', borderRadius: 16, boxShadow: '0 24px 80px rgba(0,0,0,0.35)', overflow: 'hidden', font: '13px system-ui' };
const sheetHeader: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '20px 24px', borderBottom: '1px solid #f1f5f9', background: 'linear-gradient(180deg, #ffffff 0%, #fbfaff 100%)' };
const title: React.CSSProperties = { font: `700 20px ${DISPLAY}`, letterSpacing: '-0.02em', color: '#4f46e5' };
const subtitle: React.CSSProperties = { fontSize: 13, color: '#64748b', marginTop: 3 };
const closeBtn: React.CSSProperties = { flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', color: '#64748b', cursor: 'pointer', fontSize: 14, lineHeight: 1 };
const quickNav: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 24px', borderBottom: '1px solid #f1f5f9', background: '#fdfdff' };
const quickLink: React.CSSProperties = { padding: '4px 11px', border: '1px solid #ece6fb', borderRadius: 99, background: '#faf9ff', color: '#6d28d9', cursor: 'pointer', font: '12px system-ui', fontWeight: 600 };
const body: React.CSSProperties = { padding: '20px 24px', overflow: 'auto' };
const h3: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, font: `700 15px ${DISPLAY}`, color: '#1e293b', margin: '0 0 8px' };
const stepNum: React.CSSProperties = { display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 99, background: '#7c3aed', color: 'white', fontSize: 12, fontWeight: 700, flexShrink: 0 };
const p: React.CSSProperties = { fontSize: 13.5, color: '#334155', lineHeight: 1.6, margin: '0 0 8px' };
const pMuted: React.CSSProperties = { ...p, color: '#64748b', fontSize: 12.5 };
const ol: React.CSSProperties = { margin: '0 0 4px', paddingLeft: 20, fontSize: 13.5, color: '#334155', lineHeight: 1.7 };
const ul: React.CSSProperties = { margin: '4px 0 0', paddingLeft: 20, fontSize: 13, color: '#475569', lineHeight: 1.7 };
const example: React.CSSProperties = { font: '12px ui-monospace, "SF Mono", monospace', background: '#f8fafc', color: '#334155', border: '1px solid #e8edf3', borderRadius: 10, padding: '12px 14px', overflow: 'auto', lineHeight: 1.6, margin: '4px 0 8px' };
const sayTable: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', marginTop: 14, fontSize: 12.5 };
const th: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', borderBottom: '2px solid #ece6fb', color: '#6d28d9', fontWeight: 700, background: '#faf9ff' };
const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #f1f5f9', color: '#334155', verticalAlign: 'top', lineHeight: 1.5 };
const inlineCode: React.CSSProperties = { font: '12px ui-monospace, "SF Mono", monospace', background: '#f1f5f9', color: '#7c3aed', borderRadius: 5, padding: '1px 5px' };
const pre: React.CSSProperties = { font: '12px ui-monospace, "SF Mono", monospace', background: '#0f172a', color: '#e2e8f0', borderRadius: 10, padding: '12px 14px', overflow: 'auto', lineHeight: 1.55, margin: '4px 0 8px' };
const kbd: React.CSSProperties = { font: '11px ui-monospace, monospace', background: '#fff', border: '1px solid #cbd5e1', borderBottomWidth: 2, borderRadius: 5, padding: '1px 6px', color: '#334155' };
const skillCard: React.CSSProperties = { border: '1px solid #ece6fb', background: '#faf9ff', borderRadius: 10, padding: '12px 14px', marginBottom: 8 };
const skillName: React.CSSProperties = { font: '600 13px ui-monospace, "SF Mono", monospace', color: '#6d28d9' };
const skillTag: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#a78bca', background: '#f3f0fc', border: '1px solid #ece6fb', borderRadius: 5, padding: '2px 6px' };
const sheetFooter: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 24px', borderTop: '1px solid #f1f5f9', fontSize: 12, color: '#64748b' };
const doneBtn: React.CSSProperties = { padding: '7px 16px', border: 'none', borderRadius: 8, background: '#7c3aed', color: 'white', cursor: 'pointer', font: '13px system-ui', fontWeight: 600 };
