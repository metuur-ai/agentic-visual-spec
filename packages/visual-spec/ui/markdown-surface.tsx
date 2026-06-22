import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
 */
function rehypeVsLoc() {
  return (tree: unknown) => {
    const walk = (node: any) => {
      if (node?.type === 'element' && node.position?.start?.line != null) {
        node.properties = node.properties || {};
        node.properties['data-vs-loc'] = `${node.position.start.line}:${(node.position.start.column ?? 1) - 1}`;
      }
      for (const child of node?.children ?? []) walk(child);
    };
    walk(tree);
  };
}

export function MarkdownSurface({ source }: { source: string }) {
  return (
    <div data-inspector-root className="md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeVsLoc]} components={components}>
        {source}
      </Markdown>
    </div>
  );
}
