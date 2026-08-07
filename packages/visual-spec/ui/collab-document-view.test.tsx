// @vitest-environment jsdom
/**
 * collab-document-view.test.tsx — R-7.3 and SC-10 for the reviewer's render surface.
 *
 * TWO THINGS ARE PINNED HERE.
 *
 * 1. **Identity (R-7.3).** Every block in the fixture that carries a `nodeId` in the
 *    JSON has exactly one DOM element stamped with that id, plus `data-vs-document-id`
 *    and the `data-vs-node-version` the document's `nodes` projection reports. The
 *    fixture is real Luthor output (`headless.markdownToJSON`) with ids stamped the way
 *    `ui/node-id-extension.ts` stamps them — under the NodeState `$` key — so the test
 *    reads ids the same way the store will hand them over.
 *
 * 2. **Visual parity with the published Markdown (SC-10) — structurally.** There is no
 *    browser screenshot to diff against here, so parity is established as an equality of
 *    **block outlines**: the fixture is rendered twice, once by `CollabDocumentView` from
 *    the JSON and once by react-markdown from `headless.jsonToMarkdown(...)` — which is
 *    exactly the artifact that gets published — and the same normalizer is run over both
 *    DOMs. The outline records, in document order and nesting depth, every block-level
 *    element and its text.
 *
 *    Three normalizations are applied, each because Markdown's renderer emits a wrapper
 *    that has no node in Lexical (or vice versa). They are listed in `BLOCK_TAGS` /
 *    `isStructuralParagraph` and nowhere else:
 *      - elements that are not block-level (`thead`, `tbody`, `figure`, `div`, `span`,
 *        `code` inside `pre`, `strong`/`em`/`a`/…) are transparent — walked through, not
 *        recorded;
 *      - a `<p>` that Markdown inserts inside a blockquote / list item / table cell, or
 *        around a lone image, is transparent in those positions only;
 *      - subtrees marked `data-vs-annotation` are dropped from the text, because they are
 *        visual-spec chrome (the "not commentable" badge) with no Markdown counterpart —
 *        the same status `data-vs-loc` has in the local viewer.
 *
 *    WHAT THIS DOES **NOT** COVER, stated plainly: it is a structural check, not a visual
 *    one. It says nothing about pixels, fonts, spacing, colour, or wrapping; nothing about
 *    inline-level markup (bold renders as `<strong>` here and `<strong>` there, but the
 *    outline would not notice if it did not); nothing about attributes (`href`, `src`,
 *    `start`, `colspan`); and nothing about the block types Markdown cannot express at all
 *    — `iframe-embed` and `youtube-embed` are excluded from the parity fixture precisely
 *    because `jsonToMarkdown` has no syntax for them without the preset's extra
 *    transformers, so there is no published form to be at parity with. Shared typography
 *    is carried by the shared `className="md"` root, which is asserted separately but is
 *    a claim about one class name, not about the rendered result.
 */
import './prism-global'; // must precede @lyfie/luthor
import { headless } from '@lyfie/luthor';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import { CollabDocumentView, collabBlockSelector } from './collab-document-view';
import { getSerializedNodeId } from './node-id-extension';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Real Luthor output: a representative Markdown document put through
 * `headless.markdownToJSON`, then stamped with `$: { nodeId }` on every block except the
 * three `NODE_ID_UNSERIALIZABLE_TYPES` — which is exactly the state a document read back
 * from the store is in. The `nodes` projection is the flattened block list; its second
 * entry is deliberately at version 7 while its Lexical `version` is 1.
 */
const fixture = JSON.parse(readFileSync(resolve(here, 'fixtures/collab-document.json'), 'utf8')) as CollaborationDocument;

/** Every serialized node in the fixture, in document order. */
function walk(node: Record<string, unknown>, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  out.push(node);
  for (const child of (Array.isArray(node.children) ? node.children : []) as Record<string, unknown>[]) walk(child, out);
  return out;
}
const allNodes = ((fixture.doc.root.children ?? []) as Record<string, unknown>[]).flatMap((n) => walk(n));
const idBearing = allNodes.filter((n) => getSerializedNodeId(n));

function renderDoc(document: CollaborationDocument = fixture): HTMLElement {
  return render(<CollabDocumentView document={document} />).container;
}

// ---------------------------------------------------------------- block outline

/** Block-level tags. Everything else is a transparent wrapper and is walked through. */
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol', 'li', 'pre', 'hr', 'table', 'tr', 'th', 'td', 'img']);
const P_WRAPPER_PARENTS = new Set(['BLOCKQUOTE', 'LI', 'TD', 'TH']);

/** A `<p>` Markdown's renderer inserts where Lexical has no node. */
function isStructuralParagraph(el: Element): boolean {
  if (el.tagName !== 'P') return false;
  return P_WRAPPER_PARENTS.has(el.parentElement?.tagName ?? '') || el.querySelector('img') !== null;
}

function textOf(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const chrome of Array.from(clone.querySelectorAll('[data-vs-annotation]'))) chrome.remove();
  return (clone.textContent ?? '').replace(/​/g, '').replace(/\s+/g, ' ').trim();
}

function isRecorded(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName.toLowerCase()) && !isStructuralParagraph(el);
}

function hasRecordedDescendant(el: Element): boolean {
  return Array.from(el.children).some((child) => isRecorded(child) || hasRecordedDescendant(child));
}

function outline(root: Element): string[] {
  const lines: string[] = [];
  const visit = (el: Element, depth: number) => {
    let next = depth;
    if (isRecorded(el)) {
      const tag = el.tagName.toLowerCase();
      // Text is recorded on leaf blocks only. A container's text is just the
      // concatenation of its children's, and the two renderers differ in the
      // whitespace they leave *between* child elements — which is not structure.
      const label = tag === 'img' ? el.getAttribute('alt') ?? '' : hasRecordedDescendant(el) ? '' : textOf(el);
      lines.push(`${'  '.repeat(depth)}${tag}|${label}`);
      next = depth + 1;
    }
    for (const child of Array.from(el.children)) visit(child, next);
  };
  for (const child of Array.from(root.children)) visit(child, 0);
  return lines;
}

// ---------------------------------------------------------------- tests

describe('R-7.3 — every rendered block carries its node identity', () => {
  it('stamps data-vs-node-id on every id-bearing block in the fixture', () => {
    const container = renderDoc();
    expect(idBearing.length).toBeGreaterThan(20); // fixture is not vacuous
    for (const node of idBearing) {
      const id = getSerializedNodeId(node)!;
      const matches = container.querySelectorAll(`[data-vs-node-id="${id}"]`);
      expect(matches.length, `nodeId ${id} (${String(node.type)})`).toBe(1);
    }
  });

  it('stamps no data-vs-node-id that is not in the JSON, and never twice', () => {
    const container = renderDoc();
    const stamped = Array.from(container.querySelectorAll('[data-vs-node-id]')).map((el) => el.getAttribute('data-vs-node-id')!);
    expect(new Set(stamped).size).toBe(stamped.length);
    expect([...stamped].sort()).toEqual(idBearing.map((n) => getSerializedNodeId(n)!).sort());
  });

  it('stamps data-vs-document-id on every block, including the id-less ones', () => {
    const container = renderDoc();
    const blocks = container.querySelectorAll('[data-vs-node-id], [data-vs-uncommentable]');
    expect(blocks.length).toBe(idBearing.length + 1); // + the image, which has no id
    for (const el of Array.from(blocks)) expect(el.getAttribute('data-vs-document-id')).toBe('doc-fixture-1');
  });

  it('takes data-vs-node-version from the document projection, not the Lexical node version', () => {
    const container = renderDoc();
    // The fixture's second block is projected at version 7 while its serialized Lexical
    // `version` is 1 — proving the attribute is read from `nodes`, not from the node.
    const bumped = fixture.nodes.find((n) => n.version === 7)!;
    const el = container.querySelector(collabBlockSelector('doc-fixture-1', bumped.id))!;
    expect(el.getAttribute('data-vs-node-version')).toBe('7');
    for (const node of fixture.nodes) {
      const block = container.querySelector(collabBlockSelector('doc-fixture-1', node.id))!;
      expect(block.getAttribute('data-vs-node-version'), node.id).toBe(String(node.version));
    }
  });

  it('emits no data-vs-loc — the canonical JSON has no source positions', () => {
    expect(renderDoc().querySelectorAll('[data-vs-loc]').length).toBe(0);
  });
});

describe('id-less block types (NODE_ID_UNSERIALIZABLE_TYPES)', () => {
  const embeds: CollaborationDocument = {
    documentId: 'doc-embeds',
    documentPath: 'docs/embeds.md',
    title: 'Embeds',
    frontmatter: {},
    nodes: [],
    doc: {
      root: {
        children: [
          { type: 'iframe-embed', version: 1, src: 'https://example.com/x', width: 640, height: 360, alignment: 'center', caption: 'A page' },
          { type: 'youtube-embed', version: 1, src: 'https://www.youtube.com/embed/abc', width: 560, height: 315, alignment: 'center' },
        ],
      },
    },
  };

  it('renders the image, embeds no fabricated id, and says why', () => {
    const container = renderDoc();
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('./diagram.png');
    const block = image.closest('[data-vs-document-id]')!;
    expect(block.hasAttribute('data-vs-node-id')).toBe(false);
    expect(block.getAttribute('data-vs-uncommentable')).toContain('exportJSON');
  });

  it('shows the reviewer a visible marker that the block cannot be commented on', () => {
    const container = renderDoc();
    const badge = container.querySelector('[data-vs-annotation="uncommentable"]')!;
    expect(badge.textContent).toBe('no anchor — not commentable');
    expect(badge.getAttribute('title')).toContain('super.exportJSON()');
  });

  it('renders iframe and youtube embeds without an id and without crashing', () => {
    const container = render(<CollabDocumentView document={embeds} />).container;
    const frames = container.querySelectorAll('iframe');
    expect(Array.from(frames).map((f) => f.getAttribute('src'))).toEqual([
      'https://example.com/x',
      'https://www.youtube.com/embed/abc',
    ]);
    expect(container.querySelectorAll('[data-vs-node-id]').length).toBe(0);
    expect(container.querySelectorAll('[data-vs-uncommentable]').length).toBe(2);
    expect(container.querySelector('figcaption')!.textContent).toBe('A page');
  });
});

describe('SC-10 — structural parity with the published Markdown', () => {
  it('renders the same block outline as react-markdown renders jsonToMarkdown(doc)', () => {
    const published = headless.jsonToMarkdown(fixture.doc, { metadataMode: 'none' });
    const fromJson = outline(renderDoc());
    const fromMarkdown = outline(render(<Markdown remarkPlugins={[remarkGfm]}>{published}</Markdown>).container);
    expect(fromJson.join('\n')).toBe(fromMarkdown.join('\n'));
    // Guard against a vacuous pass: the outline must actually contain the document.
    expect(fromJson).toContain('h1|Collaboration renderer fixture');
    expect(fromJson).toContain('  li|first item');
    expect(fromJson).toContain('    th|Col A');
    expect(fromJson.length).toBeGreaterThan(20);
  });

  it('shares the local viewer’s `md` typography class rather than duplicating styles', () => {
    expect(renderDoc().firstElementChild!.className).toBe('md');
  });

  it('does not import the local markdown renderer (R-10.6)', () => {
    const source = readFileSync(resolve(here, 'collab-document-view.tsx'), 'utf8');
    const imports = source.match(/(?:^|\n)\s*import[\s\S]*?from\s*'[^']+'/g) ?? [];
    expect(imports.join('\n')).not.toMatch(/markdown-surface|react-markdown|remark|rehype/);
  });
});

describe('block type coverage', () => {
  const doc = (children: unknown[]): CollaborationDocument => ({
    documentId: 'doc-cov',
    documentPath: 'docs/cov.md',
    title: 'Coverage',
    frontmatter: {},
    nodes: [],
    doc: { root: { children } },
  });
  const text = (value: string, format = 0) => ({ type: 'text', version: 1, text: value, format });

  it('maps every heading level', () => {
    const container = render(
      <CollabDocumentView
        document={doc(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => ({ type: 'heading', version: 1, tag, children: [text(tag)] })))}
      />,
    ).container;
    expect(Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el) => el.tagName.toLowerCase())).toEqual([
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
    ]);
  });

  it('renders nested lists, ordered starts and inert checklist boxes', () => {
    const container = render(
      <CollabDocumentView
        document={doc([
          {
            type: 'list',
            version: 1,
            listType: 'number',
            start: 3,
            children: [
              {
                type: 'listitem',
                version: 1,
                children: [text('outer'), { type: 'list', version: 1, listType: 'check', children: [{ type: 'listitem', version: 1, checked: true, children: [text('done')] }] }],
              },
            ],
          },
        ])}
      />,
    ).container;
    expect(container.querySelector('ol')!.getAttribute('start')).toBe('3');
    expect(container.querySelector('ol > li > ul > li')!.textContent).toBe('done');
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  it('renders inline types as content, with no id of their own', () => {
    const container = render(
      <CollabDocumentView
        document={doc([
          {
            type: 'paragraph',
            version: 1,
            $: { nodeId: 'p1' },
            children: [
              text('a'),
              { type: 'linebreak', version: 1 },
              { type: 'tab', version: 1, text: '\t' },
              { type: 'link', version: 1, url: 'https://example.com', children: [text('link')] },
              { type: 'autolink', version: 1, url: 'https://auto.example', children: [text('auto')] },
            ],
          },
          { type: 'code', version: 1, language: 'ts', $: { nodeId: 'c1' }, children: [{ type: 'code-highlight', version: 1, text: 'const', format: 0, highlightType: 'keyword' }, text(' x = 1')] },
        ])}
      />,
    ).container;
    expect(container.querySelectorAll('[data-vs-node-id]').length).toBe(2); // paragraph + code only
    expect(container.querySelector('br')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com',
      'https://auto.example',
    ]);
    // `code-highlight` children are flattened into the block's text — the code block is
    // styled as a whole (`.md pre`), not token by token.
    expect(container.querySelector('pre')!.textContent).toBe('const x = 1');
  });

  it('renders all eight text format bits', () => {
    const bits: [number, string][] = [
      [1, 'strong'],
      [2, 'em'],
      [4, 's'],
      [8, 'u'],
      [16, 'code'],
      [32, 'sub'],
      [64, 'sup'],
      [128, 'mark'],
    ];
    const container = render(
      <CollabDocumentView document={doc(bits.map(([format]) => ({ type: 'paragraph', version: 1, children: [text('x', format)] })))} />,
    ).container;
    expect(Array.from(container.querySelectorAll('p')).map((p) => p.firstElementChild!.tagName.toLowerCase())).toEqual(bits.map(([, tag]) => tag));
  });

  it('composes combined format bits inner-to-outer, deterministically', () => {
    const container = render(<CollabDocumentView document={doc([{ type: 'paragraph', version: 1, children: [text('x', 1 | 2 | 16)] }])} />).container;
    // code is innermost, then strong, then em — the FORMAT_TAGS order.
    expect(container.querySelector('p')!.innerHTML).toBe('<em><strong><code>x</code></strong></em>');
  });

  it('renders a table cell as th only for the header ROW bit', () => {
    const container = render(
      <CollabDocumentView
        document={doc([
          {
            type: 'table',
            version: 1,
            children: [
              { type: 'tablerow', version: 1, children: [{ type: 'tablecell', version: 1, headerState: 3, colSpan: 2, rowSpan: 1, children: [text('head')] }] },
              { type: 'tablerow', version: 1, children: [{ type: 'tablecell', version: 1, headerState: 2, colSpan: 1, rowSpan: 1, children: [text('col')] }] },
            ],
          },
        ])}
      />,
    ).container;
    expect(container.querySelector('th')!.getAttribute('colspan')).toBe('2');
    expect(container.querySelector('td')!.textContent).toBe('col'); // COLUMN bit alone ⇒ td
  });
});

describe('unknown node types', () => {
  const unknownDoc: CollaborationDocument = {
    documentId: 'doc-unknown',
    documentPath: 'docs/unknown.md',
    title: 'Unknown',
    frontmatter: {},
    nodes: [{ id: 'u1', type: 'callout', version: 4, content: 'heads up' }],
    doc: {
      root: {
        children: [
          { type: 'callout', version: 1, $: { nodeId: 'u1' }, children: [{ type: 'text', version: 1, text: 'heads up', format: 0 }] },
          { type: 'wikilink', version: 1, text: 'a page' },
        ],
      },
    },
  };

  it('renders a visible, inert placeholder instead of crashing or vanishing', () => {
    const container = render(<CollabDocumentView document={unknownDoc} />).container;
    const blocks = Array.from(container.querySelectorAll('[data-vs-unknown-type]'));
    expect(blocks.map((el) => el.getAttribute('data-vs-unknown-type'))).toEqual(['callout', 'wikilink']);
    expect(blocks[0]!.textContent).toBe('unsupported block: calloutheads up');
    expect(blocks[1]!.textContent).toBe('unsupported block: wikilinka page');
  });

  it('still stamps identity when the unknown node carries a nodeId', () => {
    const container = render(<CollabDocumentView document={unknownDoc} />).container;
    const known = container.querySelector(collabBlockSelector('doc-unknown', 'u1'))!;
    expect(known.getAttribute('data-vs-node-version')).toBe('4');
    const idless = container.querySelector('[data-vs-unknown-type="wikilink"]')!;
    expect(idless.hasAttribute('data-vs-node-id')).toBe(false);
    expect(idless.getAttribute('data-vs-uncommentable')).toContain('wikilink');
  });
});

describe('degenerate input', () => {
  it('renders an empty document without throwing', () => {
    const empty: CollaborationDocument = {
      documentId: 'doc-empty',
      documentPath: 'docs/empty.md',
      title: '',
      frontmatter: {},
      nodes: [],
      doc: { root: {} },
    };
    expect(render(<CollabDocumentView document={empty} />).container.textContent).toBe('');
  });
});
