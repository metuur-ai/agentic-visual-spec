import './prism-global'; // must precede @lyfie/luthor (via node-id-extension) — sets the global Prism
import type { CollaborationDocument, CollaborationNode } from '../core/collaboration/document-protocol';
import { NODE_ID_UNSERIALIZABLE_TYPES, getSerializedNodeId } from './node-id-extension';

/**
 * collab-document-view.tsx — the reviewer's read-only surface for a collaboration
 * document (R-7.3).
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `markdown-surface.tsx`. The local viewer renders
 * Markdown through react-markdown and stamps `data-vs-loc` from mdast source positions.
 * Markdown is `nodeId`-stripped by construction (LLD §2 — it is the *derived* artifact),
 * so no amount of work in that path can produce `data-vs-node-id`. The canonical form is
 * the Luthor `JsonDocument`, and identity rides on it under the NodeState `$` key
 * (`ui/node-id-extension.ts`). This module walks that JSON directly.
 *
 * Keeping the two renderers separate is a requirement, not an accident: R-10.6 forbids
 * the collaboration view from becoming the renderer for local markdown files, and R-6.6
 * keeps the local resolver untouched. `markdown-surface.tsx` is not imported here and
 * must not be — a shared renderer is what would put local mode at risk.
 *
 * NOT read back from Markdown. This module matches `ui/(node-id|publish|collab)*`, the
 * import-boundary pattern enforced by `core/collaboration/import-boundary.test.ts`
 * (R-2.13): nothing reachable from here may touch `markdownToInjectable`,
 * `canonicalizeMarkdown`, or `markdownToJSON`. This renderer reads JSON, never Markdown.
 *
 * It is a browser module and lives under `ui/`; `core/bundle-guard.test.ts` fails the
 * build if Luthor/React become reachable from the CLI or Vite-plugin entrypoints.
 */

/** Attribute names the reviewer UI (tasks 6.1, 7.3, 11.1) queries against. */
export const VS_DOCUMENT_ID_ATTR = 'data-vs-document-id';
export const VS_NODE_ID_ATTR = 'data-vs-node-id';
export const VS_NODE_VERSION_ATTR = 'data-vs-node-version';
/** Present, with a human-readable reason, on a block that cannot carry a durable id. */
export const VS_UNCOMMENTABLE_ATTR = 'data-vs-uncommentable';
/**
 * Marks visual-spec's own chrome (the "not commentable" badge). It has no counterpart in
 * the published Markdown, so parity checks and text extraction skip these subtrees.
 */
export const VS_ANNOTATION_ATTR = 'data-vs-annotation';

/**
 * CSS selector locating one block of one document. Values are quoted, so only `"` and `\`
 * need escaping — `CSS.escape` is not used because it is absent in jsdom.
 */
export function collabBlockSelector(documentId: string, nodeId: string): string {
  const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;
  return `[${VS_DOCUMENT_ID_ATTR}=${quote(documentId)}][${VS_NODE_ID_ATTR}=${quote(nodeId)}]`;
}

/**
 * Lexical's text `format` bitmask. All eight bits are rendered — the reviewer reads the
 * canonical JSON, and four of these (underline, subscript, superscript, highlight) are
 * *not* Markdown-native, so the published artifact drops them while the document still
 * carries them. Showing them is the honest rendering of what is actually stored.
 * Order is inner → outer, so the wrapping is deterministic across renders.
 */
const FORMAT_TAGS: readonly [bit: number, tag: 'code' | 'strong' | 'em' | 's' | 'u' | 'sub' | 'sup' | 'mark'][] = [
  [16, 'code'],
  [1, 'strong'],
  [2, 'em'],
  [4, 's'],
  [8, 'u'],
  [32, 'sub'],
  [64, 'sup'],
  [128, 'mark'],
];

type Json = Record<string, unknown>;

const str = (node: Json, key: string): string | undefined => (typeof node[key] === 'string' ? (node[key] as string) : undefined);
const num = (node: Json, key: string): number | undefined => (typeof node[key] === 'number' ? (node[key] as number) : undefined);
const childrenOf = (node: Json): Json[] => (Array.isArray(node.children) ? (node.children as Json[]) : []);

/** Heading `tag` is authored by Lexical as `h1`…`h6`; anything else degrades to `h6`. */
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export type CollabDocumentViewProps = {
  /** The stored collaboration document. `nodes` supplies `data-vs-node-version`. */
  document: CollaborationDocument;
  /**
   * Optional render-time transform for image srcs (e.g. resolving a repo-relative path
   * to a stream endpoint). Omitted ⇒ srcs render as authored.
   */
  resolveImageSrc?: (src: string) => string;
  /** Extra class on the root, appended after `md`. */
  className?: string;
};

/**
 * Render a collaboration document to DOM, stamping block identity on every block.
 *
 * The root carries `className="md"`, the same class the local markdown viewer uses, so
 * both surfaces inherit one typography stylesheet (`index.html`). That is the mechanism
 * behind SC-10 visual parity — not a second, parallel set of styles.
 */
export function CollabDocumentView({ document: doc, resolveImageSrc, className }: CollabDocumentViewProps) {
  const versions = new Map<string, number>();
  for (const node of doc.nodes ?? []) {
    if (node && typeof node.id === 'string') versions.set(node.id, versionOf(node));
  }
  const root = (doc.doc?.root ?? {}) as Json;
  return (
    <div
      data-vs-collab-root
      {...{ [VS_DOCUMENT_ID_ATTR]: doc.documentId }}
      className={className ? `md ${className}` : 'md'}
    >
      {childrenOf(root).map((child, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Block key={i} node={child} ctx={{ documentId: doc.documentId, versions, resolveImageSrc }} />
      ))}
    </div>
  );
}

function versionOf(node: CollaborationNode): number {
  return typeof node.version === 'number' ? node.version : 1;
}

type Ctx = {
  documentId: string;
  versions: Map<string, number>;
  resolveImageSrc?: (src: string) => string;
};

/**
 * The three identity attributes (R-7.3), plus the uncommentable marker.
 *
 * `data-vs-node-id` is **omitted, never fabricated**, when the serialized node carries no
 * id: `image`, `iframe-embed` and `youtube-embed` lose theirs on serialization
 * (`NODE_ID_UNSERIALIZABLE_TYPES`), and a synthesized id would be a different string on
 * the next load — every comment anchored to it would silently mis-resolve. An absent id
 * is a block that cannot be commented on; a wrong id is a comment pointing at the wrong
 * paragraph.
 *
 * `data-vs-node-version` comes from the document's `nodes` projection, never from the
 * serialized node's own `version` field — that one is Lexical's *node class schema*
 * version and has nothing to do with content changes (LLD §2, R-6.3). It is omitted when
 * the projection does not know the node, for the same reason: a fabricated version would
 * mis-flag a comment as outdated (or fail to flag one that is).
 *
 * `data-vs-loc` is not emitted at all. It is the local viewer's source-line stamp, taken
 * from mdast positions; the canonical JSON has no source positions to take it from. R-7.3
 * lists it as optional.
 */
function identityAttrs(node: Json, ctx: Ctx): Record<string, string> {
  const attrs: Record<string, string> = { [VS_DOCUMENT_ID_ATTR]: ctx.documentId };
  const id = getSerializedNodeId(node);
  if (id) {
    attrs[VS_NODE_ID_ATTR] = id;
    const version = ctx.versions.get(id);
    if (version !== undefined) attrs[VS_NODE_VERSION_ATTR] = String(version);
  } else {
    const type = str(node, 'type') ?? 'unknown';
    attrs[VS_UNCOMMENTABLE_ATTR] = NODE_ID_UNSERIALIZABLE_TYPES[type] ?? `no nodeId on the serialized \`${type}\` node`;
  }
  return attrs;
}

/** The visible "you cannot comment here" affordance for an id-less block. */
function UncommentableBadge({ type }: { type: string }) {
  return (
    <span
      {...{ [VS_ANNOTATION_ATTR]: 'uncommentable' }}
      title={NODE_ID_UNSERIALIZABLE_TYPES[type] ?? `no nodeId on the serialized \`${type}\` node`}
      style={badge}
    >
      no anchor — not commentable
    </span>
  );
}

function Children({ node, ctx }: { node: Json; ctx: Ctx }) {
  return (
    <>
      {childrenOf(node).map((child, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Block key={i} node={child} ctx={ctx} />
      ))}
    </>
  );
}

/**
 * One serialized node → DOM. Blocks get the identity attributes; inline nodes (`text`,
 * `linebreak`, `tab`, `code-highlight`, `link`, `autolink`) carry no id by design
 * (`NODE_ID_EXCLUDED_TYPES`) and render as plain content.
 */
function Block({ node, ctx }: { node: Json; ctx: Ctx }): React.ReactNode {
  const type = str(node, 'type') ?? '';
  switch (type) {
    // ---- inline: content inside a block, never a comment target ----
    case 'text':
    case 'code-highlight':
      return <TextRun node={node} />;
    case 'tab':
      return '\t';
    case 'linebreak':
      return <br />;
    case 'link':
    case 'autolink': {
      const url = str(node, 'url') ?? '';
      return (
        <a href={url} title={str(node, 'title') ?? undefined} target={str(node, 'target') ?? undefined} rel={str(node, 'rel') ?? undefined}>
          <Children node={node} ctx={ctx} />
        </a>
      );
    }

    // ---- blocks ----
    case 'paragraph':
      return (
        <p {...identityAttrs(node, ctx)}>
          <Children node={node} ctx={ctx} />
        </p>
      );
    case 'heading': {
      const tag = str(node, 'tag') ?? 'h1';
      const Heading = (HEADING_TAGS.has(tag) ? tag : 'h6') as 'h1';
      return (
        <Heading {...identityAttrs(node, ctx)}>
          <Children node={node} ctx={ctx} />
        </Heading>
      );
    }
    case 'quote':
      return (
        <blockquote {...identityAttrs(node, ctx)}>
          <Children node={node} ctx={ctx} />
        </blockquote>
      );
    case 'list': {
      const ordered = str(node, 'listType') === 'number';
      const List = (ordered ? 'ol' : 'ul') as 'ol';
      const start = num(node, 'start');
      return (
        <List {...identityAttrs(node, ctx)} start={ordered && start !== undefined && start !== 1 ? start : undefined}>
          <Children node={node} ctx={ctx} />
        </List>
      );
    }
    case 'listitem': {
      // A checklist item's box is inert: this surface is read-only.
      const checked = typeof node.checked === 'boolean' ? (node.checked as boolean) : undefined;
      return (
        <li {...identityAttrs(node, ctx)}>
          {checked !== undefined && <input type="checkbox" checked={checked} disabled readOnly />}
          <Children node={node} ctx={ctx} />
        </li>
      );
    }
    case 'code': {
      const language = str(node, 'language');
      return (
        <pre {...identityAttrs(node, ctx)}>
          <code className={language ? `language-${language}` : undefined}>
            {/* Split into per-line spans so the shared `.md-line` CSS counter renders line
                numbers, exactly as the local markdown viewer does for a fenced block. */}
            {codeLines(node).map((line, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <span className="md-line" key={i}>
                {line || '​'}
              </span>
            ))}
          </code>
        </pre>
      );
    }
    case 'horizontalrule':
      return <hr {...identityAttrs(node, ctx)} />;
    case 'image': {
      const src = str(node, 'src') ?? '';
      const caption = str(node, 'caption');
      return (
        <figure {...identityAttrs(node, ctx)} style={figure}>
          <img src={ctx.resolveImageSrc ? ctx.resolveImageSrc(src) : src} alt={str(node, 'alt') ?? ''} />
          {caption ? <figcaption>{caption}</figcaption> : null}
          <UncommentableBadge type={type} />
        </figure>
      );
    }
    case 'iframe-embed':
    case 'youtube-embed': {
      const caption = str(node, 'caption');
      return (
        <figure {...identityAttrs(node, ctx)} style={figure}>
          <iframe
            src={str(node, 'src') ?? ''}
            title={str(node, 'title') ?? (type === 'youtube-embed' ? 'YouTube video' : 'Embedded page')}
            width={num(node, 'width')}
            height={num(node, 'height')}
          />
          {caption ? <figcaption>{caption}</figcaption> : null}
          <UncommentableBadge type={type} />
        </figure>
      );
    }
    case 'table':
      return (
        // `tbody` is React's required wrapper for rows; Lexical has no node for it, and
        // Markdown's renderer emits `thead`/`tbody` of its own. Both are structural only.
        <table {...identityAttrs(node, ctx)}>
          <tbody>
            <Children node={node} ctx={ctx} />
          </tbody>
        </table>
      );
    case 'tablerow':
      return (
        <tr {...identityAttrs(node, ctx)}>
          <Children node={node} ctx={ctx} />
        </tr>
      );
    case 'tablecell': {
      // `headerState` is a bitmask (ROW=1, COLUMN=2). A Markdown table has header *rows*
      // only, so the ROW bit alone decides `th` vs `td` — honouring the COLUMN bit would
      // render a `th` the published document cannot express (SC-10).
      const header = ((num(node, 'headerState') ?? 0) & 1) !== 0;
      const Cell = (header ? 'th' : 'td') as 'td';
      return (
        <Cell
          {...identityAttrs(node, ctx)}
          colSpan={num(node, 'colSpan') !== 1 ? num(node, 'colSpan') : undefined}
          rowSpan={num(node, 'rowSpan') !== 1 ? num(node, 'rowSpan') : undefined}
        >
          <Children node={node} ctx={ctx} />
        </Cell>
      );
    }

    default:
      return <UnknownBlock node={node} ctx={ctx} type={type} />;
  }
}

/**
 * A node type this renderer does not know — a future Luthor block, or a preset node
 * (`callout`, `wikilink`, `saved-card`, …) that reached the store.
 *
 * It renders as a **visible, inert placeholder that still shows the node's own children**.
 * Silently dropping it would show the reviewer a document that is missing content without
 * saying so, and they would review the gap as if it were the document. Throwing would take
 * the whole surface down over one unrecognized block. So: a labelled box, its content
 * rendered inside it, and the identity attributes stamped if the node has an id — an
 * unknown type is still commentable when it carries a `nodeId`.
 */
function UnknownBlock({ node, ctx, type }: { node: Json; ctx: Ctx; type: string }) {
  const text = typeof node.text === 'string' ? (node.text as string) : '';
  return (
    <div {...identityAttrs(node, ctx)} data-vs-unknown-type={type || '(untyped)'} style={unknown}>
      <span {...{ [VS_ANNOTATION_ATTR]: 'unknown-type' }} style={badge}>
        unsupported block: {type || '(untyped)'}
      </span>
      {text}
      <Children node={node} ctx={ctx} />
    </div>
  );
}

/**
 * A `text` run, wrapped per the `format` bitmask. `code-highlight` reaches here only if
 * one ever appears outside a `code` block — inside one it is flattened by `codeLines`,
 * because the block is highlighted as a whole by the shared `.md pre` styling rather than
 * token by token.
 */
function TextRun({ node }: { node: Json }) {
  const format = num(node, 'format') ?? 0;
  let out: React.ReactNode = str(node, 'text') ?? '';
  for (const [bit, Tag] of FORMAT_TAGS) {
    if ((format & bit) !== 0) out = <Tag>{out}</Tag>;
  }
  return <>{out}</>;
}

/**
 * The lines of a code block. Lexical stores code content either as a single `text` child
 * or as a run of `code-highlight` / `linebreak` children; both flatten to the same string.
 */
function codeLines(node: Json): string[] {
  const flatten = (current: Json): string => {
    if (str(current, 'type') === 'linebreak') return '\n';
    if (typeof current.text === 'string') return current.text as string;
    return childrenOf(current).map(flatten).join('');
  };
  return childrenOf(node).map(flatten).join('').replace(/\n$/, '').split('\n');
}

const figure: React.CSSProperties = { margin: '14px 0' };
const unknown: React.CSSProperties = {
  margin: '14px 0',
  padding: '10px 12px',
  border: '1px dashed #cbd5e1',
  borderRadius: 8,
  background: '#f8fafc',
};
const badge: React.CSSProperties = {
  display: 'inline-block',
  marginRight: 8,
  padding: '1px 6px',
  borderRadius: 6,
  background: '#f1f5f9',
  color: '#64748b',
  font: '600 10px system-ui',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  verticalAlign: 'middle',
};
