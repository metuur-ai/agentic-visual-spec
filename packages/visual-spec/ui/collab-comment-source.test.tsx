// @vitest-environment jsdom
/**
 * collab-comment-source.test.tsx — task 7.3, wiring proofs #2 and #3, plus the
 * local-mode parity proof.
 *
 * The point of this suite is that the shared components are *actually driven* by
 * task 6.1's resolver, not merely that the resolver works (that is covered by
 * `core/collaboration/anchor-resolution.test.ts`). So every collaboration assertion
 * here goes through a real `IndicatorLayer` / `CommentPanel` mount over a real
 * `CollabDocumentView` render, and the expected outcome is derived from the document
 * fixture: bump the projected version and the *rendered marker* has to change.
 *
 *   #2  `resolveCollabAnchor` drives indicator placement — exact, outdated and
 *       orphaned each reach the DOM differently (R-6.2 … R-6.5).
 *   #3  a block stamped `data-vs-uncommentable` offers no comment affordance (R-7.3).
 *
 * And the one that matters most (R-10.1): local mode, mounted with exactly the props
 * `markdown-editor.tsx` passes, still resolves by line through `resolveMarkdownAnchors`
 * and still places its marker — end to end, not by source inspection.
 */
import './prism-global'; // must precede @lyfie/luthor
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorProvider, useInspector } from '../core/app';
import type { CollaborationDocument } from '../core/collaboration/document-protocol';
import type { CommentRecord } from '../core/editing/comment-doc';
import { CollabDocumentView } from './collab-document-view';
import { collabCommentPanelSource, collabIndicatorTargets, collabOrphans } from './collab-comment-source';
import { CommentPanel } from './comment-panel';
import { IndicatorLayer } from './indicator-layer';

/* ------------------------------------------------------------------ *
 * Fixture — two addressable paragraphs plus an image the renderer marks
 * uncommentable (`image` is in NODE_ID_UNSERIALIZABLE_TYPES, task 2.1).
 * ------------------------------------------------------------------ */
function fixture(versions: { n1: number; n2: number } = { n1: 4, n2: 1 }): CollaborationDocument {
  return {
    documentId: 'doc-1',
    documentPath: 'docs/spec.md',
    title: 'Spec',
    frontmatter: {},
    nodes: [
      { id: 'n-1', type: 'paragraph', version: versions.n1, content: 'First paragraph.' },
      { id: 'n-2', type: 'paragraph', version: versions.n2, content: 'Second paragraph.' },
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
}

/** A comment as `githubCommentStore` projects it: identity lives in the trailer. */
function comment(id: string, collab: Record<string, string>, text = 'needs work'): CommentRecord {
  return {
    id,
    workflow: 'visual-spec',
    target: { path: 'docs/spec.md', kind: 'file' },
    comment: text,
    status: 'open',
    ts: '2026-08-07T00:00:00.000Z',
    ...(Object.keys(collab).length ? { collab } : {}),
  } as CommentRecord;
}

/** Non-zero rects, so the rAF placement loop does not skip every element. */
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100, left: 200, width: 300, height: 20, right: 500, bottom: 120, x: 200, y: 100, toJSON: () => ({}),
  } as DOMRect);
  // One synchronous pass, then stop: the loop is production behaviour, not test behaviour.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const markers = () => Array.from(document.querySelectorAll('[aria-label$="on this block"], [aria-label*="on this block"]'));

/* ================================================================== *
 * WIRING PROOF #2 — resolveCollabAnchor drives indicator placement
 * ================================================================== */
describe('R-6.2 … R-6.5 — indicators are placed by resolveCollabAnchor', () => {
  it('exact: a comment on an unedited block gets a plain marker on that block', () => {
    const doc = fixture();
    const comments = [comment('c-1', { nodeId: 'n-1', nodeVersion: '4', text: 'First paragraph.' })];
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    const placed = markers();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.getAttribute('data-vs-indicator-state')).toBeNull();
  });

  it('outdated: the SAME comment renders `stale` once the projected version moves — R-6.3', () => {
    // Identical comment, identical DOM; only the document's projected version differs.
    // This is what proves the resolver's output reaches the marker rather than being
    // recomputed or ignored somewhere on the way.
    const doc = fixture({ n1: 9, n2: 1 });
    const comments = [comment('c-1', { nodeId: 'n-1', nodeVersion: '4', text: 'First paragraph.' })];
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    const placed = markers();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.getAttribute('data-vs-indicator-state')).toBe('stale');
    expect(placed[0]!.getAttribute('aria-label')).toContain('block edited since');
  });

  it('orphaned: no marker is placed, and the comment goes to the document-level view — R-6.4/R-6.5', () => {
    const doc = fixture();
    const comments = [comment('c-orphan', { nodeId: 'n-gone', nodeVersion: '2', text: 'A paragraph that was deleted.' })];
    expect(collabIndicatorTargets(doc, comments)).toEqual([]);
    expect(collabOrphans(doc, comments)).toEqual([
      { comment: comments[0], targetText: 'A paragraph that was deleted.' },
    ]);
  });

  it('an orphan is listed in the panel with an explicit marker and its last-known text', () => {
    const doc = fixture();
    const comments = [comment('c-orphan', { nodeId: 'n-gone', text: 'A paragraph that was deleted.' }, 'still relevant')];
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel width={320} source={collabCommentPanelSource({ document: doc, comments, add: async () => {}, reply: async () => {}, remove: async () => {} })} />
      </InspectorProvider>,
    );
    const card = document.querySelector('[data-vs-orphan="c-orphan"]')!;
    expect(card.textContent).toContain('ORPHANED');
    expect(card.textContent).toContain('A paragraph that was deleted.');
    expect(card.textContent).toContain('still relevant');
    // ...and it is NOT pinned to any block.
    expect(markers()).toHaveLength(0);
  });

  it('several comments on one block collapse into one marker; different blocks get their own', () => {
    const doc = fixture();
    const comments = [
      comment('c-1', { nodeId: 'n-1', nodeVersion: '4' }),
      comment('c-2', { nodeId: 'n-1', nodeVersion: '4' }),
      comment('c-3', { nodeId: 'n-2', nodeVersion: '1' }),
    ];
    const targets = collabIndicatorTargets(doc, comments);
    expect(targets.map((t) => t.comments.length)).toEqual([2, 1]);
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={targets} />
      </>,
    );
    expect(markers()).toHaveLength(2);
    expect(screen.getByLabelText('2 pending comments on this block')).toBeTruthy();
  });

  it('a target resolves to the block the renderer stamped, not to a line or a snippet', () => {
    const doc = fixture();
    const [target] = collabIndicatorTargets(doc, [comment('c-1', { nodeId: 'n-2' })]);
    render(<CollabDocumentView document={doc} />);
    expect(target!.element()?.textContent).toBe('Second paragraph.');
  });

  it('a document-level comment (no nodeId) is neither placed nor treated as an orphan — R-5.7', () => {
    const doc = fixture();
    const comments = [comment('c-doc', {})];
    expect(collabIndicatorTargets(doc, comments)).toEqual([]);
    expect(collabOrphans(doc, comments)).toEqual([]);
  });

  it('applied comments produce no marker', () => {
    const doc = fixture();
    const done = { ...comment('c-1', { nodeId: 'n-1' }), status: 'applied' as const };
    expect(collabIndicatorTargets(doc, [done])).toEqual([]);
  });
});

/* ================================================================== *
 * WIRING PROOF #3 — uncommentable blocks offer no comment affordance
 * ================================================================== */

/**
 * Activates the inspector and selects the first element matching `selector`.
 * Deferred a macrotask because `InspectorProvider`'s own mount effect clears the
 * selection, and a parent's effect runs after its children's.
 */
function SelectBlock({ selector }: { selector: string }) {
  const { setActive, setSelection } = useInspector();
  useEffect(() => {
    const timer = setTimeout(() => {
      setActive(true);
      const el = document.querySelector(selector) as HTMLElement | null;
      setSelection(el ? [{ line: 1, column: 0, anchor: el }] : []);
    }, 0);
    return () => clearTimeout(timer);
  }, [selector, setActive, setSelection]);
  return null;
}

function mountPanel(doc: CollaborationDocument, selector: string, add = vi.fn(async () => {})) {
  const source = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {}, remove: async () => {} });
  render(
    <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
      <CollabDocumentView document={doc} />
      <SelectBlock selector={selector} />
      <CommentPanel width={320} source={source} />
    </InspectorProvider>,
  );
  return { source, add };
}

describe('R-7.3/R-7.5 — a block with no durable identity offers no comment affordance', () => {
  it('selecting an identified block DOES offer the compose form', async () => {
    mountPanel(fixture(), '[data-vs-node-id="n-1"]');
    await waitFor(() => expect(screen.getByPlaceholderText('Your comment (⌘/Ctrl+Enter)…')).toBeTruthy());
    expect(screen.getByText('Add comment')).toBeTruthy();
    expect(document.querySelector('[data-vs-uncommentable-notice]')).toBeNull();
  });

  it('selecting an uncommentable block withdraws it and says why', async () => {
    mountPanel(fixture(), '[data-vs-uncommentable]');
    await waitFor(() => expect(document.querySelector('[data-vs-uncommentable-notice]')).not.toBeNull());
    expect(screen.queryByPlaceholderText('Your comment (⌘/Ctrl+Enter)…')).toBeNull();
    expect(screen.queryByText('Add comment')).toBeNull();
    // The reason comes from the renderer's own attribute, not from a hardcoded string.
    const reason = document.querySelector('[data-vs-uncommentable]')!.getAttribute('data-vs-uncommentable')!;
    expect(document.querySelector('[data-vs-uncommentable-notice]')!.textContent).toContain(reason);
  });

  it('creating on an uncommentable selection persists nothing', async () => {
    const doc = fixture();
    const { source } = mountPanel(doc, '[data-vs-uncommentable]');
    const add = vi.fn(async () => {});
    const guarded = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {}, remove: async () => {} });
    const el = document.querySelector('[data-vs-uncommentable]') as HTMLElement;
    await guarded.create([{ line: 1, column: 0, anchor: el }], 'hello', 'visual-spec');
    expect(add).not.toHaveBeenCalled();
    expect(source.describe([{ line: 1, column: 0, anchor: el }])).toHaveProperty('uncommentable');
  });

  it('R-7.5 — creating on an identified block persists against its nodeId', async () => {
    const doc = fixture();
    const add = vi.fn(async () => {});
    const source = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {}, remove: async () => {} });
    render(<CollabDocumentView document={doc} />);
    const el = document.querySelector('[data-vs-node-id="n-2"]') as HTMLElement;
    await source.create([{ line: 1, column: 0, anchor: el }], 'hello', 'visual-spec');
    expect(add).toHaveBeenCalledWith({ nodeId: 'n-2', comment: 'hello', workflow: 'visual-spec' });
  });
});

/* ================================================================== *
 * R-10.1 — local mode takes the same code path it took before
 * ================================================================== */
describe('R-10.1 — local mode, mounted exactly as markdown-editor.tsx mounts it', () => {
  const local: CommentRecord = {
    id: 'c-local',
    workflow: 'visual-spec',
    target: { path: 'a.md', kind: 'range', startLine: 10, heading: 'Intro', snippet: 's' },
    comment: 'local comment',
    status: 'open',
    ts: '2026-08-07T00:00:00.000Z',
  };

  it('places a marker on the [data-vs-loc] block, by line, via resolveMarkdownAnchors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toBe('/__vs/comments?path=a.md');
      return new Response(JSON.stringify([local]), { headers: { 'content-type': 'application/json' } });
    }));
    render(
      <>
        <div data-inspector-root>
          <p data-vs-loc="10:0">Anchored prose.</p>
        </div>
        <IndicatorLayer path="a.md" mode="markdown" />
      </>,
    );
    await waitFor(() => expect(screen.getByLabelText('1 pending comment on line 10')).toBeTruthy());
    const marker = screen.getByLabelText('1 pending comment on line 10');
    // Same wording and same absence of collaboration chrome as before this task.
    expect(marker.getAttribute('title')).toBe('Comment on line 10 — show in sidebar');
    expect(marker.getAttribute('data-vs-indicator-state')).toBeNull();
  });

  it('a comment for a different path places nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ ...local, target: { ...local.target, path: 'b.md' } }]))));
    render(
      <>
        <div data-inspector-root>
          <p data-vs-loc="10:0">Anchored prose.</p>
        </div>
        <IndicatorLayer path="a.md" mode="markdown" />
      </>,
    );
    await waitFor(() => expect(screen.queryByLabelText(/pending comment/)).toBeNull());
  });

  it('the local panel still lists open comments with their heading + line label', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([local]))));
    render(
      <InspectorProvider surfaceId="a" pageIndex={0}>
        <CommentPanel file="a" width={320} />
      </InspectorProvider>,
    );
    await waitFor(() => expect(screen.getByText('local comment')).toBeTruthy());
    expect(screen.getByText('Intro · L10')).toBeTruthy();
    expect(document.querySelector('[data-vs-orphan-list]')).toBeNull();
  });
});
