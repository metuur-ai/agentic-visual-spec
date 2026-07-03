/**
 * content-title.tsx — a slim header pinned to the top of the main content pane,
 * showing the open file's name (with its containing folder muted). Sticky so it
 * stays visible while scrolling a long document.
 */

export function ContentTitle({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  return (
    <div style={bar} title={path}>
      <span aria-hidden>📄</span>
      <span style={pathWrap}>
        {dir && <span style={dirStyle}>{dir}</span>}
        <span style={nameStyle}>{name}</span>
      </span>
    </div>
  );
}

const bar: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 6,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 16px',
  borderBottom: '1px solid #e5e7eb',
  background: 'white',
  font: '13px system-ui',
};
const pathWrap: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const dirStyle: React.CSSProperties = { color: '#94a3b8', font: '12px ui-monospace, "SF Mono", monospace' };
const nameStyle: React.CSSProperties = { color: '#1e293b', fontWeight: 700 };
