import { Fragment } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitFrontmatter } from './frontmatter';
import { MermaidDiagram } from './mermaid-diagram';

/**
 * Route ```mermaid fences to the diagram renderer. Block code is split into
 * per-line spans so a CSS counter can render line numbers; inline code is left
 * untouched.
 */
const components: Components = {
  code({ node, ref, className, children, ...props }) {
    if (/\blanguage-mermaid\b/.test(className ?? '')) {
      return <MermaidDiagram code={String(children).replace(/\n$/, '')} />;
    }
    const text = String(children);
    const isBlock = text.includes('\n') || /\blanguage-/.test(className ?? '');
    if (!isBlock) {
      return <code className={className} {...props}>{children}</code>;
    }
    const lines = text.replace(/\n$/, '').split('\n');
    return (
      <code className={`${className ?? ''} md-codeblock`.trim()} {...props}>
        {lines.map((line, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <span className="md-line" key={i}>{line || '​'}</span>
        ))}
      </code>
    );
  },
};

/**
 * Stamp every rendered block element with data-vs-loc="<line>:<col>" taken from
 * its markdown source position, so the inspector resolves a click → source line.
 * `lineOffset` re-adds the frontmatter lines stripped before parsing, keeping the
 * stamps aligned to the real file.
 */
function rehypeVsLoc(lineOffset: number) {
  return () => (tree: unknown) => {
    const walk = (node: any) => {
      if (node?.type === 'element' && node.position?.start?.line != null) {
        node.properties = node.properties || {};
        node.properties['data-vs-loc'] = `${node.position.start.line + lineOffset}:${(node.position.start.column ?? 1) - 1}`;
      }
      for (const child of node?.children ?? []) walk(child);
    };
    walk(tree);
  };
}

/** Parse a flat `key: value` frontmatter into pairs; null if any line is nested/complex. */
function parseFlatFrontmatter(yaml: string): [string, string][] | null {
  const pairs: [string, string][] = [];
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^([A-Za-z0-9_.$-]+):[ \t]*(.*)$/.exec(line);
    if (!m) return null; // indentation, list items, or block scalars → not flat
    pairs.push([m[1]!, m[2]!]);
  }
  return pairs.length ? pairs : null;
}

/** Render the leading YAML frontmatter as a metadata card above the body. */
function FrontmatterBlock({ yaml }: { yaml: string }) {
  const pairs = parseFlatFrontmatter(yaml);
  return (
    <div style={fmCard} data-vs-loc="1:0">
      <div style={fmLabel}>Frontmatter</div>
      {pairs ? (
        <dl style={fmList}>
          {pairs.map(([k, v]) => (
            <Fragment key={k}>
              <dt style={fmKey}>{k}</dt>
              <dd style={fmVal}>{v.replace(/^["']|["']$/g, '') || <span style={{ opacity: 0.4 }}>—</span>}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre style={fmRaw}>{yaml}</pre>
      )}
    </div>
  );
}

export function MarkdownSurface({ source }: { source: string }) {
  const { inner, body } = splitFrontmatter(source);
  // Body is a suffix of source; the stripped prefix is the frontmatter block.
  // Count its lines so the inspector's source-line stamps stay accurate.
  const lineOffset = inner == null ? 0 : source.slice(0, source.length - body.length).split('\n').length - 1;
  return (
    <div data-inspector-root className="md">
      {inner != null && <FrontmatterBlock yaml={inner} />}
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeVsLoc(lineOffset)]} components={components}>
        {body}
      </Markdown>
    </div>
  );
}

const fmCard: React.CSSProperties = {
  margin: '0 0 24px',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  background: '#fbfaff',
  overflow: 'hidden',
};
const fmLabel: React.CSSProperties = {
  padding: '6px 14px',
  borderBottom: '1px solid #ece6fb',
  background: '#f5f3ff',
  color: '#7c3aed',
  font: '600 11px system-ui',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};
const fmList: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '2px 16px',
  margin: 0,
  padding: '10px 14px',
};
const fmKey: React.CSSProperties = { margin: 0, color: '#64748b', font: '600 13px system-ui' };
const fmVal: React.CSSProperties = { margin: 0, color: '#1e293b', font: '13px ui-monospace, "SF Mono", monospace', wordBreak: 'break-word' };
const fmRaw: React.CSSProperties = { margin: 0, padding: '10px 14px', color: '#334155', font: '12.5px ui-monospace, "SF Mono", monospace', whiteSpace: 'pre-wrap' };
