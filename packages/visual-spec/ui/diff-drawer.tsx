/**
 * diff-drawer.tsx — "what did this say before?", as a right-side panel.
 *
 * WHY NOT JUST THE POPOVER. The apply popover already shows the comparison, and for a
 * one-line edit that is enough. It stops being enough the moment the answer is prose: the
 * popover is a 440px column pinned under a toolbar button, and two columns of paragraph
 * inside it are five words wide. This panel is the same comparison given the width that
 * prose needs, opened deliberately, and closed without disturbing the run behind it.
 *
 * READ-ONLY, SO IT DISMISSES. Unlike the collaboration picker this shares a shell with,
 * nothing here is in flight — there is no request a stray Escape could tear down. So
 * Escape and a click on the scrim both close it. See `drawer.tsx` for that policy.
 *
 * IT NEVER CLAIMS TO BE THE FILE. A patch carries the changed regions and a few lines of
 * context, and that is all it carries; the unchanged bulk of the document is not in the
 * payload. Every file here is labelled with the regions it is showing, and a file whose
 * patch was truncated says so rather than presenting a short read as a complete one. The
 * failure this whole feature exists to fix was a preview that misled in silence, and a
 * roomier preview that misled in silence would be the same bug with better typography.
 */
import { useState } from 'react';

import { patchRows } from '../core/app/lib/patch-rows';
import type { PatchRow } from '../core/app/lib/patch-rows';
import { Drawer } from './drawer';

export type DiffDrawerEntry = { path: string; patch: string; truncated?: boolean };

export type DiffDrawerProps = {
  entries: DiffDrawerEntry[];
  onClose: () => void;
};

const PANEL_LABEL = 'Before and after';

export function DiffDrawer({ entries, onClose }: DiffDrawerProps) {
  return (
    <Drawer
      label={PANEL_LABEL}
      dismissible
      /*
       * Wider than the picker's 720px because this panel is two columns, not one. At 720px
       * each side of a prose comparison lands near 40 characters, which is the narrow
       * column the popover was already being blamed for.
       */
      width="min(1040px, 100vw)"
      slug="diff-drawer"
      onClose={onClose}
    >
      <div style={body}>
        {entries.length === 0 ? (
          // Reachable: a run can finish having written nothing, and an empty panel with no
          // sentence in it reads as a panel that failed to load.
          <p style={empty}>Claude did not change any file in this run.</p>
        ) : (
          entries.map((entry) => <FileBlock key={entry.path} entry={entry} />)
        )}
      </div>
    </Drawer>
  );
}

function FileBlock({ entry }: { entry: DiffDrawerEntry }) {
  const [open, setOpen] = useState(true);
  const { hunks } = patchRows(entry.patch);

  return (
    <section style={card}>
      <button type="button" style={cardHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span style={caret}>{open ? '▾' : '▸'}</span>
        <code style={pathChip}>{entry.path}</code>
        <span style={scopeNote}>
          {hunks.length === 0
            ? 'unreadable patch'
            : `${hunks.length === 1 ? 'only the changed region' : `only the ${hunks.length} changed regions`}`}
        </span>
      </button>

      {entry.truncated && (
        // The server capped the payload. Saying so is the difference between a short
        // answer and a wrong one.
        <p style={warn}>This patch was truncated — some changed lines are not shown here.</p>
      )}

      {open &&
        (hunks.length === 0 ? (
          /*
           * `patchRows` is all-or-nothing by design: a patch cut mid-hunk has line numbers
           * that have slid out of step, so rather than render rows that are confidently
           * mislabelled, we hand over the raw text and let the reader judge it.
           */
          <pre style={raw}>{entry.patch}</pre>
        ) : (
          hunks.map((h, i) => (
            <div key={i}>
              <div style={hunkBar}>
                line {h.oldStart} → {h.newStart}
              </div>
              <div style={grid} data-testid="diff-drawer-split">
                <div style={colHead}>Before</div>
                <div style={colHead}>After</div>
                {h.rows.map((row, j) => (
                  <Row key={j} row={row} />
                ))}
              </div>
            </div>
          ))
        ))}
    </section>
  );
}

/**
 * One row, both sides.
 *
 * Each side is its own grid cell rather than a flex pair so that a long line wrapping on
 * one side cannot push its counterpart out of alignment — the whole point of the panel is
 * that the eye can travel straight across.
 */
function Row({ row }: { row: PatchRow }) {
  if (row.kind === 'context') {
    return (
      <>
        <Cell no={row.oldNo} text={row.text} tone="ctx" />
        <Cell no={row.newNo} text={row.text} tone="ctx" />
      </>
    );
  }
  if (row.kind === 'change') {
    return (
      <>
        <Cell no={row.oldNo} text={row.before} tone="del" />
        <Cell no={row.newNo} text={row.after} tone="add" />
      </>
    );
  }
  if (row.kind === 'remove') {
    return (
      <>
        <Cell no={row.oldNo} text={row.text} tone="del" />
        <Cell tone="none" />
      </>
    );
  }
  return (
    <>
      <Cell tone="none" />
      <Cell no={row.newNo} text={row.text} tone="add" />
    </>
  );
}

function Cell({ no, text, tone }: { no?: number; text?: string; tone: 'ctx' | 'del' | 'add' | 'none' }) {
  const style =
    tone === 'del' ? cellDel : tone === 'add' ? cellAdd : tone === 'none' ? cellNone : cellCtx;
  return (
    <div style={style}>
      {/*
        * A blank on one side is a real part of the comparison — it is how "this line did
        * not exist yet" is said. It carries no number because there is no line to number.
        */}
      <span style={lineNo}>{no ?? ''}</span>
      <span style={lineText}>{text ?? ''}</span>
    </div>
  );
}

const body: React.CSSProperties = { padding: '12px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 };

const empty: React.CSSProperties = { margin: 0, padding: '24px 4px', color: '#64748b', font: '13px system-ui, sans-serif' };

const card: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  background: 'white',
  overflow: 'hidden',
};

const cardHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 12px',
  border: 0,
  borderBottom: '1px solid #f1f5f9',
  background: '#fbfaff',
  cursor: 'pointer',
  textAlign: 'left',
};

const caret: React.CSSProperties = { color: '#8b5cf6', fontSize: 11 };

const pathChip: React.CSSProperties = {
  font: '600 12px ui-monospace, monospace',
  color: '#6d28d9',
  background: '#f5f3ff',
  border: '1px solid #ece6fb',
  borderRadius: 6,
  padding: '1px 7px',
};

const scopeNote: React.CSSProperties = { fontSize: 11, color: '#94a3b8' };

const warn: React.CSSProperties = {
  margin: 0,
  padding: '6px 12px',
  fontSize: 11.5,
  color: '#92400e',
  background: '#fffbeb',
  borderBottom: '1px solid #fde68a',
};

const hunkBar: React.CSSProperties = {
  padding: '4px 12px',
  font: '700 11px ui-monospace, monospace',
  color: '#6d28d9',
  background: '#f8f7ff',
  borderBottom: '1px solid #f1f5f9',
};

/** Two equal halves, so the panel's width is split rather than negotiated. */
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
};

const colHead: React.CSSProperties = {
  padding: '4px 10px',
  font: '700 10.5px system-ui, sans-serif',
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  borderBottom: '1px solid #f1f5f9',
};

const cellBase: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '0 10px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

const cellCtx: React.CSSProperties = { ...cellBase, color: '#64748b' };
const cellDel: React.CSSProperties = { ...cellBase, color: '#b91c1c', background: '#fef2f2' };
const cellAdd: React.CSSProperties = { ...cellBase, color: '#166534', background: '#f0fdf4' };
const cellNone: React.CSSProperties = { ...cellBase, background: '#fafafa' };

const lineNo: React.CSSProperties = {
  flexShrink: 0,
  width: 30,
  textAlign: 'right',
  color: '#cbd5e1',
  userSelect: 'none',
};

const lineText: React.CSSProperties = { flex: 1, minWidth: 0 };

const raw: React.CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  font: '12px/1.6 ui-monospace, monospace',
  color: '#475569',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};
