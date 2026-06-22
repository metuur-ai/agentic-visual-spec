import { useEffect, useRef, useState } from 'react';

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;

/** Load + init mermaid once, lazily (keeps it out of the initial bundle). */
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      return mermaid;
    });
  }
  return mermaidReady;
}

let idSeq = 0;

/** Render a ```mermaid fenced block as an SVG diagram. */
export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`vs-mermaid-${++idSeq}`);

  useEffect(() => {
    let alive = true;
    setError(null);
    getMermaid()
      .then((mermaid) => mermaid.render(idRef.current, code))
      .then(({ svg }) => alive && setSvg(svg))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [code]);

  if (error) {
    return (
      <div style={errorBox}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Mermaid error</div>
        <div style={{ marginBottom: 6, opacity: 0.8 }}>{error}</div>
        <pre style={pre}>{code}</pre>
      </div>
    );
  }
  if (!svg) return <pre style={pre}>{code}</pre>;
  // dangerouslySetInnerHTML is safe here: securityLevel 'strict' sanitizes mermaid output.
  return <div style={wrap} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const wrap: React.CSSProperties = { display: 'flex', justifyContent: 'center', padding: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'auto' };
const pre: React.CSSProperties = { margin: 0, padding: 12, background: '#0f172a', color: '#e2e8f0', borderRadius: 8, overflow: 'auto', font: '12px ui-monospace, monospace' };
const errorBox: React.CSSProperties = { padding: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', font: '12px system-ui' };
