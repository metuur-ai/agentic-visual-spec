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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  /*
   * A badge in the gutter says a comment exists; it does not say what it is about. The
   * shaded area does — it is drawn from the block's own box, so it always covers exactly
   * the stretch under discussion.
   */
  it('the commented block is shaded, over its own box, and never intercepts clicks', () => {
    const doc = fixture();
    const comments = [comment('c-1', { nodeId: 'n-1', nodeVersion: '4', text: 'First paragraph.' })];
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    const shaded = document.querySelector('[data-vs-comment-area="c-1"]') as HTMLElement;
    expect(shaded).toBeTruthy();
    // The mocked rect for every element in this suite.
    expect(shaded.style.width).toBe('300px');
    expect(shaded.style.height).toBe('20px');
    // The inspector hit-tests clicks through this layer to start a comment.
    expect(shaded.style.pointerEvents).toBe('none');
  });

  /*
   * The badge and the shading's left rule were both drawn into the same strip of gutter, so
   * the rule ran under the badge and out its bottom edge — the pair read as one lollipop
   * rather than as a count beside a highlighted passage. They own separate lanes now, and
   * this pins the separation rather than the coordinates, so the lanes can be retuned
   * without the test having to be rewritten to match.
   */
  it('the badge and the shading do not overlap', () => {
    const doc = fixture();
    const comments = [comment('c-1', { nodeId: 'n-1', nodeVersion: '4', text: 'First paragraph.' })];
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    const badge = screen.getByLabelText('1 pending comment on this block');
    const shaded = document.querySelector('[data-vs-comment-area="c-1"]') as HTMLElement;

    const badgeLeft = Number.parseFloat(badge.style.left);
    const badgeRight = badgeLeft + Number.parseFloat(String(badge.style.minWidth || 0));
    const shadedLeft = Number.parseFloat(shaded.style.left);

    expect(badgeRight).toBeLessThan(shadedLeft);
  });

  it('an outdated anchor shades dashed, matching its badge — R-6.3', () => {
    const doc = fixture({ n1: 9, n2: 1 });
    const comments = [comment('c-1', { nodeId: 'n-1', nodeVersion: '4', text: 'First paragraph.' })];
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    const shaded = document.querySelector('[data-vs-comment-area="c-1"]') as HTMLElement;
    expect(shaded.style.borderLeft).toContain('dashed');
  });

  it('an orphan shades nothing — it has no block to shade — R-6.4', () => {
    const doc = fixture();
    const comments = [comment('c-orphan', { nodeId: 'n-gone', text: 'A paragraph that was deleted.' })];
    render(
      <>
        <CollabDocumentView document={doc} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    expect(document.querySelector('[data-vs-comment-area]')).toBeNull();
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
        <CommentPanel width={320} source={collabCommentPanelSource({ document: doc, comments, add: async () => {}, reply: async () => {} })} />
      </InspectorProvider>,
    );
    const card = document.querySelector('[data-vs-orphan="c-orphan"]')!;
    expect(card.textContent).toContain('ORPHANED');
    expect(card.textContent).toContain('A paragraph that was deleted.');
    expect(card.textContent).toContain('still relevant');
    // ...and it is NOT pinned to any block.
    expect(markers()).toHaveLength(0);
  });

  /*
   * R-5.13 / R-5.14 — a thread carries a link out and no control that writes. The panel
   * used to draw a Resolve button here (and an Unresolve in History); both wrote a
   * resolution this system must not write, so both are gone and the link replaced them.
   */
  it('offers a link to the thread on github.com and no control that resolves it', () => {
    const doc = fixture();
    const open = {
      ...comment('c-open', { nodeId: 'n-1' }, 'a real remark'),
      github: { reviewCommentId: 700001, isOutdated: false, isResolved: false, htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r700001', user: 'octocat', updatedAt: 'T0' },
      replies: [],
    } as unknown as CommentRecord;

    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel width={320} source={collabCommentPanelSource({ document: doc, comments: [open], add: async () => {}, reply: async () => {} })} />
      </InspectorProvider>,
    );

    const link = screen.getByText('Open on GitHub') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/acme/docs/pull/42#discussion_r700001');
    expect(screen.queryByLabelText('Resolve comment')).toBeNull();
    expect(screen.queryByLabelText('Delete comment')).toBeNull();
  });

  /* R-5.15 — "we could not read it" is not "it is done", so the way out is still offered. */
  it('links a thread whose resolution could not be read, and not one GitHub says is resolved', () => {
    const doc = fixture();
    const withGithub = (id: string, isResolved?: boolean) =>
      ({
        ...comment(id, { nodeId: 'n-1' }),
        github: { reviewCommentId: 700002, isOutdated: false, ...(isResolved === undefined ? {} : { isResolved }), htmlUrl: 'https://x/t', user: 'octocat', updatedAt: 'T0' },
        replies: [],
      }) as unknown as CommentRecord;

    const link = (c: CommentRecord) =>
      collabCommentPanelSource({ document: doc, comments: [c], add: async () => {}, reply: async () => {} }).link?.(c);

    expect(link(withGithub('c-unknown'))).toBe('https://x/t');
    expect(link(withGithub('c-resolved', true))).toBeUndefined();
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
  const source = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {} });
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
    const guarded = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {} });
    const el = document.querySelector('[data-vs-uncommentable]') as HTMLElement;
    await guarded.create([{ line: 1, column: 0, anchor: el }], 'hello', 'visual-spec');
    expect(add).not.toHaveBeenCalled();
    expect(source.describe([{ line: 1, column: 0, anchor: el }])).toHaveProperty('uncommentable');
  });

  it('R-7.5 — creating on an identified block persists against its nodeId', async () => {
    const doc = fixture();
    const add = vi.fn(async () => {});
    const source = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {} });
    render(<CollabDocumentView document={doc} />);
    const el = document.querySelector('[data-vs-node-id="n-2"]') as HTMLElement;
    await source.create([{ line: 1, column: 0, anchor: el }], 'hello', 'visual-spec');
    expect(add).toHaveBeenCalledWith({ nodeId: 'n-2', comment: 'hello', workflow: 'visual-spec' });
  });
});

/* ================================================================== *
 * R-10.1 — local mode takes the same code path it took before
 * ================================================================== */
/* ================================================================== *
 * The three presentation defects the first screenshot of this panel showed
 * ================================================================== */
describe('the row controls say what the system actually does', () => {
  const mount = (comments: CommentRecord[]) =>
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({
            document: fixture(),
            comments,
            add: async () => {},
            reply: async () => {},
          })}
        />
      </InspectorProvider>,
    );

  /*
   * R-5.13 — the row draws no destructive control and no resolving one. It drew a red
   * trash can labelled "Resolve comment" once; the act it named is not one this system
   * performs at all, and a collaboration row now offers a link out instead.
   */
  it('draws neither a delete nor a resolve', () => {
    mount([comment('c-1', { nodeId: 'n-1' })]);
    expect(screen.queryByLabelText('Delete comment')).toBeNull();
    expect(screen.queryByLabelText('Resolve comment')).toBeNull();
  });

  /* "Reply" borrowed a 22×22 icon square and rendered as "Re / ply". */
  it('worded buttons are sized for words, not for icons', () => {
    mount([comment('c-1', { nodeId: 'n-1' })]);
    const reply = screen.getByLabelText('Reply');
    expect(reply.style.width).toBe('auto');
    expect(reply.style.whiteSpace).toBe('nowrap');
  });
});

/* ================================================================== *
 * R-5.13 — History writes nothing, in either mode
 * ================================================================== */
describe('R-5.13 — the History tab offers no way to change resolution', () => {
  const resolved = (id: string): CommentRecord =>
    ({ ...comment(id, { nodeId: 'n-1' }, 'was addressed'), status: 'applied' }) as CommentRecord;

  /*
   * History briefly offered "Unresolve", which posted the reopening marker of a protocol
   * this package invented. Resolution is GitHub's now, read and never written, so there
   * is nothing here to undo — a reviewer reopens the thread on github.com.
   */
  it('a collaboration document lists applied comments read-only', async () => {
    const doc = fixture();
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({ document: doc, comments: [resolved('c-done')], add: async () => {}, reply: async () => {} })}
        />
      </InspectorProvider>,
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('was addressed')).toBeTruthy());
    expect(document.querySelector('[data-vs-unresolve]')).toBeNull();
  });

  /* R-10.1 — local mode is untouched: its History was always read-only. */
  it('local mode leaves History read-only — its remove destroys the record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'c-local', workflow: 'visual-spec',
        target: { path: 'a.md', kind: 'range', startLine: 10, heading: 'Intro', snippet: 's' },
        comment: 'done', status: 'applied', ts: '2026-08-07T00:00:00.000Z',
      }]), { headers: { 'content-type': 'application/json' } }),
    ));
    render(
      <InspectorProvider surfaceId="a.md" pageIndex={0}>
        <CommentPanel width={320} file="a.md" />
      </InspectorProvider>,
    );

    fireEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy());
    expect(document.querySelector('[data-vs-unresolve]')).toBeNull();
  });
});

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
