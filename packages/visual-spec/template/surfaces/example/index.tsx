/**
 * Your first surface. The source file is the canonical model — specs you attach
 * in the browser get written directly into it as @vs-spec markers.
 *
 * Press I in the browser, click any element, and attach a spec.
 */
export const meta = {
  title: 'Example',
  projection: { kind: 'flow' as const },
};

export default [
  function Welcome() {
    return (
      <div style={page}>
        <span style={kicker}>visual-spec</span>
        <h1 style={h1}>Hello, surface</h1>
        <p style={lead}>Press I, click an element, and attach an EARS / OpenSpec / SpecKit spec.</p>
      </div>
    );
  },
];

const page: React.CSSProperties = {
  width: 720,
  margin: '48px auto',
  padding: 48,
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 16,
  boxShadow: '0 10px 40px rgba(0,0,0,0.06)',
};
const kicker: React.CSSProperties = { font: '600 12px ui-monospace, monospace', letterSpacing: 1, color: '#2563eb', textTransform: 'uppercase' };
const h1: React.CSSProperties = { fontSize: 44, margin: '12px 0 8px' };
const lead: React.CSSProperties = { fontSize: 18, color: '#475569' };
