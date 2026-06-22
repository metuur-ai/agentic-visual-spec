/**
 * workflow-select.tsx — pick the `workflow` tag a comment is routed to when
 * applied. Default "visual-spec" = apply in place; "other…" lets you type any
 * slug to hand the comment off to that primary skill (see the apply-comments
 * contract). The choice is remembered so a whole review pass keeps one tag.
 */
const PRESETS = ['visual-spec'];
const KEY = 'vs:workflow';

export const loadWorkflow = (): string => localStorage.getItem(KEY) || 'visual-spec';

export function WorkflowSelect({ value, onChange }: { value: string; onChange: (w: string) => void }) {
  const known = PRESETS.includes(value) ? value : '__custom';
  return (
    <label style={wrap}>
      <span style={lbl}>Apply via</span>
      <select
        value={known}
        onChange={(e) => {
          const v = e.target.value === '__custom' ? '' : e.target.value;
          localStorage.setItem(KEY, v);
          onChange(v);
        }}
        style={sel}
        title="Which skill applies this comment. 'visual-spec' edits the file in place; others hand off."
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value="__custom">other…</option>
      </select>
      {known === '__custom' && (
        <input
          value={value}
          onChange={(e) => {
            localStorage.setItem(KEY, e.target.value);
            onChange(e.target.value);
          }}
          placeholder="workflow slug"
          style={txt}
        />
      )}
    </label>
  );
}

const wrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 8px' };
const lbl: React.CSSProperties = { fontSize: 11, color: '#64748b', flexShrink: 0 };
const sel: React.CSSProperties = { font: '12px ui-monospace, monospace', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, background: 'white', color: '#334155' };
const txt: React.CSSProperties = { font: '12px ui-monospace, monospace', padding: '2px 6px', border: '1px solid #d1d5db', borderRadius: 4, width: 120 };
