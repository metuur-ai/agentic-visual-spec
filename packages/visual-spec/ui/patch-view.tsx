/**
 * patch-view.tsx — a unified diff, rendered as the thing the reader is deciding about.
 *
 * R-4.5 / R-6.2: the proposal's `patch` is not a description of the change, it *is* the
 * change — `POST /__vs/review/approve` runs `git apply` on these exact bytes. So the
 * review view shows it the way a reader reads code, not the way a log shows a blob:
 * per file, per hunk, with both line numbers in the gutter and every added/removed line
 * marked. A patch pasted into a `<pre>` as one grey wall asks the reader to be a diff
 * parser before they can be a reviewer, and that is the moment approval turns into a
 * shrug.
 *
 * IT FOLLOWS `code-view.tsx` RATHER THAN INVENTING A THIRD RENDERER. That file is the
 * repository's line-anchored viewer — monospace `<pre>`, a fixed-width right-aligned
 * gutter, one row element per line, decoration applied per row — and this is the same
 * shape with a second gutter and three row tones. Sharing the *idiom* rather than the
 * component is deliberate: `CodeView` renders one file's whole text and reports a click
 * selection back up, and a diff has neither of those (no single line numbering, nothing
 * to select). Bending it to cover both would cost more than the ~40 lines below.
 *
 * PARSING IS DELIBERATELY FORGIVING. The patch arrives from a model through a pinned
 * schema, and the server is the thing that decides whether it applies — `git apply`
 * refuses a bad one and that refusal is the drift signal (R-6.3). This renderer's job is
 * therefore to *show* whatever arrived, including a malformed patch, rather than to
 * validate it: `parseUnifiedDiff` never throws, and text it cannot place lands in the
 * preamble where the reader can still see it.
 */

/** One rendered line. `meta` is a `\ No newline…` marker or anything unrecognised. */
export type PatchLine = {
  kind: 'add' | 'del' | 'context' | 'meta';
  /** Line number in the pre-image, or null for an added line. */
  oldLine: number | null;
  /** Line number in the post-image, or null for a removed line. */
  newLine: number | null;
  text: string;
};

export type PatchHunk = { header: string; lines: PatchLine[] };

export type PatchFile = {
  /** The best name available: the `+++` path, else the `---` path, else the raw header. */
  path: string;
  hunks: PatchHunk[];
  /** Non-hunk lines that belong to this file's header (mode changes, rename lines…). */
  notes: string[];
};

export type ParsedPatch = {
  files: PatchFile[];
  /** Anything before the first file header — kept rather than dropped. */
  preamble: string[];
  added: number;
  removed: number;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Strip git's `a/` / `b/` prefixes, and read `/dev/null` as the absence of a side. */
function cleanPath(raw: string): string {
  const p = raw.replace(/\t.*$/, '').trim();
  if (p === '/dev/null') return '';
  return p.replace(/^[ab]\//, '');
}

/**
 * Split a unified diff into files and hunks. Never throws: unparseable input comes back
 * as a preamble, which is what the reader needs to see when a patch is wrong.
 *
 * A `---` line is a header only when a `+++` line follows it, and the pair is consumed
 * together. Unified diff is genuinely ambiguous here — deleting the line `-- x` produces
 * `--- x` inside a hunk — and the paired lookahead is what keeps a deleted `---` in a
 * Markdown file (this app's main content type) from being read as a second file header.
 */
export function parseUnifiedDiff(patch: string): ParsedPatch {
  const out: ParsedPatch = { files: [], preamble: [], added: 0, removed: 0 };
  const src = patch.replace(/\n$/, '').split('\n');
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = (line: string) => {
    if (file) file.notes.push(line);
    else out.preamble.push(line);
  };
  // Returns the new file rather than assigning it, so the assignment stays visible to
  // the type checker at each call site (a closure write would narrow `file` to `never`).
  const openFile = (path: string): PatchFile => {
    const opened: PatchFile = { path, hunks: [], notes: [] };
    out.files.push(opened);
    hunk = null;
    return opened;
  };

  for (let i = 0; i < src.length; i += 1) {
    const line = src[i] as string;
    if (line.startsWith('diff --git ')) {
      file = openFile(cleanPath(line.slice('diff --git '.length).split(' ')[1] ?? ''));
      continue;
    }
    if (line.startsWith('--- ') && (src[i + 1] ?? '').startsWith('+++ ')) {
      const from = cleanPath(line.slice(4));
      const to = cleanPath((src[i + 1] as string).slice(4));
      i += 1;
      // `diff --git` already opened one and named it; the pair only refines the name.
      if (file && file.hunks.length === 0) file.path = to || from || file.path;
      else file = openFile(to || from);
      continue;
    }
    const m = HUNK.exec(line);
    if (m) {
      if (!file) file = openFile('');
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      push(line);
      continue;
    }
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine: newNo++, text: line.slice(1) });
      out.added += 1;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldLine: oldNo++, newLine: null, text: line.slice(1) });
      out.removed += 1;
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', oldLine: null, newLine: null, text: line });
    } else {
      hunk.lines.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return out;
}

/** `+12 −3`, the one-glance size of the change. */
export function PatchStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span style={stat} data-vs-patch-stat>
      <span style={{ color: '#15803d', fontWeight: 700 }}>+{added}</span>
      <span style={{ color: '#b91c1c', fontWeight: 700 }}>−{removed}</span>
    </span>
  );
}

export function PatchView({ patch }: { patch: string }) {
  const parsed = parseUnifiedDiff(patch);
  const empty = parsed.files.every((f) => f.hunks.length === 0);
  // Blank lines carry no information outside a hunk; showing them would turn an empty
  // patch into a box of whitespace rather than the warning below.
  const preamble = parsed.preamble.filter((l) => l.trim() !== '');

  return (
    <div style={wrap} data-vs-patch>
      <div style={patchHead}>
        <span style={{ fontWeight: 700, color: '#0f172a' }}>The change you are approving</span>
        <span style={{ flex: 1 }} />
        <PatchStat added={parsed.added} removed={parsed.removed} />
      </div>
      {preamble.length > 0 && <pre style={rawBlock}>{preamble.join('\n')}</pre>}
      {/*
        * A patch with no hunk is not "nothing to show" — it is a proposal whose diff did
        * not survive, and the reader has to be told rather than shown an empty box they
        * might read as "no change needed".
        */}
      {empty && preamble.length === 0 && (
        <p style={emptyNote} data-vs-patch-empty>
          This proposal carried no diff. There is nothing to apply yet — ask for one below.
        </p>
      )}
      {parsed.files.map((f, fi) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a patch's file order is its identity
        <div key={fi} style={fileBlock} data-vs-patch-file={f.path || '(unnamed)'}>
          <div style={fileHead}>{f.path || '(unnamed file)'}</div>
          {f.notes.length > 0 && <pre style={rawBlock}>{f.notes.join('\n')}</pre>}
          {f.hunks.map((h, hi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: hunks are positional
            <pre key={hi} style={hunkBlock}>
              <code style={{ display: 'block' }}>
                <span style={{ ...row, ...hunkHeaderRow }}>
                  <span style={gutter} />
                  <span style={gutter} />
                  <span style={{ ...sign }} />
                  <span style={codeCell}>{h.header}</span>
                </span>
                {h.lines.map((l, li) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                  <span key={li} style={{ ...row, ...toneOf(l.kind) }} data-vs-patch-line={l.kind}>
                    <span style={gutter}>{l.oldLine ?? ''}</span>
                    <span style={gutter}>{l.newLine ?? ''}</span>
                    <span style={{ ...sign, ...signTone(l.kind) }}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                    <span style={codeCell}>{l.text || '​'}</span>
                  </span>
                ))}
              </code>
            </pre>
          ))}
        </div>
      ))}
    </div>
  );
}

/*
 * Tone, not colour alone: the sign column carries `+`/`−` for every added and removed
 * line, so the diff still reads without colour vision.
 */
function toneOf(kind: PatchLine['kind']): React.CSSProperties {
  if (kind === 'add') return { background: 'rgba(34,197,94,0.12)' };
  if (kind === 'del') return { background: 'rgba(239,68,68,0.12)' };
  if (kind === 'meta') return { color: '#94a3b8', fontStyle: 'italic' };
  return {};
}
function signTone(kind: PatchLine['kind']): React.CSSProperties {
  if (kind === 'add') return { color: '#15803d', fontWeight: 700 };
  if (kind === 'del') return { color: '#b91c1c', fontWeight: 700 };
  return { color: '#cbd5e1' };
}

const wrap: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 8, background: 'white', overflow: 'hidden' };
const patchHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
  font: '12.5px system-ui',
};
const stat: React.CSSProperties = { display: 'inline-flex', gap: 8, font: '12px ui-monospace, "SF Mono", monospace' };
const fileBlock: React.CSSProperties = { borderTop: '1px solid #f1f5f9' };
const fileHead: React.CSSProperties = {
  padding: '6px 10px',
  background: '#f1f5f9',
  color: '#334155',
  font: '600 12px ui-monospace, "SF Mono", monospace',
  overflowWrap: 'anywhere',
};
const hunkBlock: React.CSSProperties = {
  margin: 0,
  padding: '4px 0',
  background: 'white',
  overflowX: 'auto',
  font: '12.5px/1.6 ui-monospace, "SF Mono", monospace',
};
const rawBlock: React.CSSProperties = { ...hunkBlock, padding: '6px 10px', color: '#64748b' };
const row: React.CSSProperties = { display: 'flex', whiteSpace: 'pre' };
const hunkHeaderRow: React.CSSProperties = { color: '#64748b', background: '#f8fafc' };
const gutter: React.CSSProperties = {
  flexShrink: 0,
  width: '3.2em',
  paddingRight: '0.6em',
  textAlign: 'right',
  color: '#94a3b8',
  userSelect: 'none',
};
const sign: React.CSSProperties = { flexShrink: 0, width: '1.4em', textAlign: 'center', userSelect: 'none' };
const codeCell: React.CSSProperties = { paddingRight: 16, color: '#0f172a' };
const emptyNote: React.CSSProperties = { margin: 0, padding: '14px 12px', color: '#b45309', font: '12.5px system-ui' };
