// @vitest-environment jsdom
/**
 * collab-anchor-resolver.test.tsx — the DOM half of R-6.1 … R-6.4, plus the R-6.6 guard.
 *
 * The document under test is rendered by `CollabDocumentView` itself rather than by a
 * hand-written DOM, so this pins the *contract between* task 7.1's renderer and task 6.1's
 * resolver — a renamed attribute breaks the test instead of silently unanchoring every
 * comment in the product.
 *
 * R-6.6 is guarded from the outside here: `resolveMarkdownAnchors` is imported and its
 * line-based / heading-fallback / range-extension behaviour is re-asserted independently of
 * `anchor-resolver.test.ts`, so "collaboration changed local resolution" fails in *this*
 * suite too, not only in the one a change to local mode would be tempted to update.
 */
import './prism-global'; // must precede @lyfie/luthor
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolveCollabAnchor } from '../core/collaboration/anchor-resolution';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import { resolveMarkdownAnchors } from './anchor-resolver';
import { findCollabBlock, resolveCollabAnchorElement } from './collab-anchor-resolver';
import { CollabDocumentView } from './collab-document-view';

/** Two addressable paragraphs and one image, which the renderer marks uncommentable. */
const doc: CollaborationDocument = {
  documentId: 'doc-1',
  documentPath: 'docs/a.md',
  title: 'A',
  frontmatter: {},
  nodes: [
    { id: 'n-1', type: 'paragraph', version: 3, content: 'First paragraph.' },
    { id: 'n-2', type: 'paragraph', version: 1, content: 'Second paragraph.' },
  ],
  doc: {
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', version: 1, $: { nodeId: 'n-1' }, children: [{ type: 'text', text: 'First paragraph.' }] },
        { type: 'paragraph', version: 1, $: { nodeId: 'n-2' }, children: [{ type: 'text', text: 'Second paragraph.' }] },
        { type: 'image', version: 1, src: 'a.png', altText: 'a' },
      ],
    },
  },
};

function renderDoc(): HTMLElement {
  return render(<CollabDocumentView document={doc} />).container;
}

describe('findCollabBlock', () => {
  it('R-6.1 — locates the block the renderer stamped, by documentId + nodeId', () => {
    const root = renderDoc();
    expect(findCollabBlock('doc-1', 'n-2', root)?.textContent).toBe('Second paragraph.');
  });

  it('returns null for another document, an unknown node, and no root', () => {
    const root = renderDoc();
    expect(findCollabBlock('doc-2', 'n-1', root)).toBeNull();
    expect(findCollabBlock('doc-1', 'n-gone', root)).toBeNull();
    expect(findCollabBlock('doc-1', 'n-1', null)).toBeNull();
    expect(findCollabBlock('', '', root)).toBeNull();
  });

  it('never returns a block the renderer marked uncommentable', () => {
    const root = renderDoc();
    const uncommentable = root.querySelector('[data-vs-uncommentable]');
    expect(uncommentable).not.toBeNull(); // the image — it carries no durable id at all
    expect(findCollabBlock('doc-1', '', root)).toBeNull();
  });
});

describe('resolveCollabAnchorElement — one element per state', () => {
  it('R-6.2 — exact anchors to its block', () => {
    const root = renderDoc();
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 3 }, doc);
    expect(r.state).toBe('exact');
    expect(resolveCollabAnchorElement(r, root)?.textContent).toBe('First paragraph.');
  });

  it('R-6.3 — outdated anchors to the same block; the flag changes presentation, not position', () => {
    const root = renderDoc();
    const outdated = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 1 }, doc);
    const exact = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-1', nodeVersion: 3 }, doc);
    expect(outdated.state).toBe('outdated');
    expect(resolveCollabAnchorElement(outdated, root)).toBe(resolveCollabAnchorElement(exact, root));
    // The renderer's stamped version is the one resolution compared against.
    expect(resolveCollabAnchorElement(outdated, root)?.getAttribute('data-vs-node-version')).toBe('3');
  });

  it('R-6.4 — orphaned resolves to no element and is not thrown away', () => {
    const root = renderDoc();
    const r = resolveCollabAnchor({ documentId: 'doc-1', nodeId: 'n-gone', targetText: 'Deleted.' }, doc);
    expect(r.state).toBe('orphaned');
    expect(resolveCollabAnchorElement(r, root)).toBeNull();
    expect(r.targetText).toBe('Deleted.'); // R-6.5 — still says what it was about
  });
});

describe('R-6.6 — resolveMarkdownAnchors is untouched, local-mode only', () => {
  /** A miniature of the local markdown surface: `data-vs-loc`, which collaboration never emits. */
  function localSurface(): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-inspector-root', '');
    root.innerHTML =
      '<h2 data-vs-loc="4:1">Intro</h2><p data-vs-loc="6:1">one</p><p data-vs-loc="7:1">two</p>';
    return root;
  }

  it('still resolves by line, falls back to heading, and extends across a range', () => {
    const root = localSurface();
    expect(resolveMarkdownAnchors({ startLine: 6 }, root).map((e) => e.textContent)).toEqual(['one']);
    expect(resolveMarkdownAnchors({ startLine: 6, endLine: 7 }, root).map((e) => e.textContent)).toEqual(['one', 'two']);
    expect(resolveMarkdownAnchors({ startLine: 99, heading: 'Intro' }, root).map((e) => e.textContent)).toEqual(['Intro']);
    expect(resolveMarkdownAnchors({ startLine: 99 }, root)).toEqual([]);
    expect(resolveMarkdownAnchors({}, root)).toEqual([]);
  });

  it('does not resolve against collaboration blocks, and collaboration does not resolve against its surface', () => {
    const collabRoot = renderDoc();
    // The collaboration renderer emits no `data-vs-loc`, so the local resolver finds nothing.
    expect(collabRoot.querySelector('[data-vs-loc]')).toBeNull();
    expect(resolveMarkdownAnchors({ startLine: 1, heading: 'First paragraph.' }, collabRoot)).toEqual([]);
    // And the local surface carries no node identity, so collaboration finds nothing.
    expect(findCollabBlock('doc-1', 'n-1', localSurface())).toBeNull();
  });
});
