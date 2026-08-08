// @vitest-environment jsdom
/**
 * collab-comment-source.test.tsx — the collaboration comment surface, end to end.
 *
 * The point of this suite is that the shared components are *actually driven* by the
 * projected targets, not merely that the resolver works. So every collaboration assertion
 * goes through a real `IndicatorLayer` / `CommentPanel` mount over a real
 * `MarkdownSurface` render, and the expected outcome is derived from the fixture: move
 * the comment's line and the *rendered marker* has to move with it.
 *
 * R-6.6 is the claim under test throughout: collaboration and local mode resolve through
 * the SAME `resolveMarkdownAnchors`, against the same `data-vs-loc` stamps. The last
 * describe block mounts local mode with exactly the props `markdown-editor.tsx` passes,
 * so R-10.1 is proved end to end rather than by source inspection.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorProvider } from '../core/app';
import type { CollaborationRecord } from '../core/collaboration/document-record';
import type { CommentRecord } from '../core/editing/comment-doc';
import { collabCommentPanelSource, collabIndicatorTargets, collabOrphans } from './collab-comment-source';
import { CommentPanel } from './comment-panel';
import { IndicatorLayer } from './indicator-layer';
import { MarkdownSurface } from './markdown-surface';

/* ------------------------------------------------------------------ *
 * Fixture — a heading and two paragraphs. Line numbers are what anchors.
 *   1  # Spec
 *   3  First paragraph.
 *   5  Second paragraph.
 * ------------------------------------------------------------------ */
const MARKDOWN = '# Spec\n\nFirst paragraph.\n\nSecond paragraph.\n';

const record = (): CollaborationRecord => ({
  documentId: 'doc-1',
  documentPath: 'docs/spec.md',
  title: 'Spec',
  markdown: MARKDOWN,
});

/** A thread as the route projects it: an ordinary `CommentTarget` (R-5.16). */
function comment(
  id: string,
  target: Partial<CommentRecord['target']> = {},
  extra: { text?: string; outdated?: boolean; status?: CommentRecord['status'] } = {},
): CommentRecord {
  return {
    id,
    workflow: 'visual-spec',
    target: { path: 'docs/spec.md', kind: 'range', startLine: 3, heading: 'Spec', ...target } as CommentRecord['target'],
    comment: extra.text ?? 'needs work',
    status: extra.status ?? 'open',
    ts: '2026-08-07T00:00:00.000Z',
    ...(extra.outdated === undefined
      ? {}
      : {
          github: {
            reviewCommentId: 700001,
            isOutdated: extra.outdated,
            htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r700001',
            user: 'octocat',
            updatedAt: 'T0',
          },
          replies: [],
        }),
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

const markers = () => Array.from(document.querySelectorAll('[aria-label*="pending comment"]'));

/* ================================================================== *
 * R-6.1 … R-6.4 / R-6.10 — the projected target drives indicator placement
 * ================================================================== */
describe('indicators are placed from the comment target, through the markdown resolver', () => {
  const mount = (comments: CommentRecord[]) => {
    const doc = record();
    render(
      <>
        <MarkdownSurface source={doc.markdown} />
        <IndicatorLayer targets={collabIndicatorTargets(doc, comments)} />
      </>,
    );
    return doc;
  };

  it('anchors a comment to the block whose data-vs-loc holds its line — R-6.2', () => {
    mount([comment('c-1', { startLine: 3 })]);
    const placed = markers();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.getAttribute('data-vs-indicator-state')).toBeNull();
    expect(placed[0]!.getAttribute('title')).toBe('Comment on line 3 — show in sidebar');
  });

  it('the target really resolves to the block that line renders as, not to any block', () => {
    const doc = record();
    render(<MarkdownSurface source={doc.markdown} />);
    const [first] = collabIndicatorTargets(doc, [comment('c-1', { startLine: 3 })]);
    const [second] = collabIndicatorTargets(doc, [comment('c-2', { startLine: 5 })]);
    expect(first!.element()?.textContent).toBe('First paragraph.');
    expect(second!.element()?.textContent).toBe('Second paragraph.');
  });

  /*
   * The SAME comment, the SAME DOM: only `github.isOutdated` differs. That is what proves
   * GitHub's own answer reaches the marker rather than being recomputed here (R-6.10 — an
   * outdated comment renders as visually distinct wherever it appears).
   */
  it('renders `stale` for a thread GitHub reports outdated, in the same place — R-6.3 / R-6.10', () => {
    mount([comment('c-1', { startLine: 3 }, { outdated: true })]);
    const placed = markers();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.getAttribute('data-vs-indicator-state')).toBe('stale');
    expect(placed[0]!.getAttribute('aria-label')).toContain('the text moved since');
  });

  it('the commented block is shaded, over its own box, and never intercepts clicks', () => {
    mount([comment('c-1', { startLine: 3 })]);
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
   * this pins the separation rather than the coordinates.
   */
  it('the badge and the shading do not overlap', () => {
    mount([comment('c-1', { startLine: 3 })]);
    const badge = markers()[0] as HTMLElement;
    const shaded = document.querySelector('[data-vs-comment-area="c-1"]') as HTMLElement;
    const badgeLeft = Number.parseFloat(badge.style.left);
    const badgeRight = badgeLeft + Number.parseFloat(String(badge.style.minWidth || 0));
    expect(badgeRight).toBeLessThan(Number.parseFloat(shaded.style.left));
  });

  it('an outdated anchor shades dashed, matching its badge — R-6.3', () => {
    mount([comment('c-1', { startLine: 3 }, { outdated: true })]);
    const shaded = document.querySelector('[data-vs-comment-area="c-1"]') as HTMLElement;
    expect(shaded.style.borderLeft).toContain('dashed');
  });

  it('an unanchored comment shades nothing — it has no block to shade — R-6.4', () => {
    mount([comment('c-1', { kind: 'file', startLine: undefined, snippet: 'a paragraph that was deleted' })]);
    expect(document.querySelector('[data-vs-comment-area]')).toBeNull();
    expect(markers()).toHaveLength(0);
  });

  it('several comments on one line collapse into one marker; different lines get their own', () => {
    mount([comment('c-1', { startLine: 3 }), comment('c-2', { startLine: 3 }), comment('c-3', { startLine: 5 })]);
    expect(markers()).toHaveLength(2);
    expect(screen.getByLabelText(/2 pending comments on line 3/)).toBeTruthy();
  });

  it('applied comments produce no marker', () => {
    expect(collabIndicatorTargets(record(), [comment('c-1', { startLine: 3 }, { status: 'applied' })])).toEqual([]);
  });
});

/* ================================================================== *
 * R-6.4 / R-6.9 — nothing is hidden because it could not be placed
 * ================================================================== */
describe('the document-level list carries everything that has no line', () => {
  it('an unanchored comment is listed with the text it was written about — R-6.4', () => {
    const doc = record();
    const orphan = comment('c-orphan', { kind: 'file', startLine: undefined, snippet: 'a paragraph that was deleted' });
    expect(collabIndicatorTargets(doc, [orphan])).toEqual([]);
    expect(collabOrphans(doc, [orphan])).toEqual([{ comment: orphan, targetText: 'a paragraph that was deleted' }]);
  });

  /* R-6.9 — a comment about another file in the PR is still a reviewer's words. */
  it('a comment on another file is kept, and names the file it is about', () => {
    const doc = record();
    const elsewhere = comment('c-other', { path: 'docs/other.md', startLine: 2, snippet: 'over there' });
    expect(collabIndicatorTargets(doc, [elsewhere])).toEqual([]);
    expect(collabOrphans(doc, [elsewhere])[0]?.targetText).toBe('docs/other.md — over there');
  });

  it('the panel renders it document-level with an explicit marker', () => {
    const doc = record();
    const orphan = comment('c-orphan', { kind: 'file', startLine: undefined, snippet: 'a paragraph that was deleted' }, { text: 'still relevant' });
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel width={320} source={collabCommentPanelSource({ document: doc, comments: [orphan], add: async () => {}, reply: async () => {} })} />
      </InspectorProvider>,
    );
    const card = document.querySelector('[data-vs-orphan="c-orphan"]')!;
    expect(card.textContent).toContain('ORPHANED');
    expect(card.textContent).toContain('a paragraph that was deleted');
    expect(card.textContent).toContain('still relevant');
    expect(markers()).toHaveLength(0);
  });
});

/* ================================================================== *
 * R-7.5 — creating a comment persists a line range
 * ================================================================== */
describe('R-7.5 — a new comment is anchored by line', () => {
  const selectionOf = (selector: string, line: number) => {
    const el = document.querySelector(selector) as HTMLElement;
    return [{ line, column: 0, anchor: el }];
  };

  it('posts the selected block’s line, and the text it holds for R-7.12', async () => {
    const doc = record();
    const add = vi.fn(async () => {});
    const source = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {} });
    render(<MarkdownSurface source={doc.markdown} />);
    await source.create(selectionOf('[data-vs-loc^="5:"]', 5), 'hello', 'visual-spec');
    expect(add).toHaveBeenCalledWith({
      comment: 'hello',
      workflow: 'visual-spec',
      startLine: 5,
      selectedText: 'Second paragraph.',
    });
  });

  it('a multi-block selection posts the whole range', async () => {
    const doc = record();
    const add = vi.fn(async () => {});
    const source = collabCommentPanelSource({ document: doc, comments: [], add, reply: async () => {} });
    render(<MarkdownSurface source={doc.markdown} />);
    const first = document.querySelector('[data-vs-loc^="3:"]') as HTMLElement;
    const last = document.querySelector('[data-vs-loc^="5:"]') as HTMLElement;
    await source.create(
      [
        { line: 3, column: 0, anchor: first },
        { line: 5, column: 0, anchor: last },
      ],
      'about both',
      '',
    );
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ startLine: 3, endLine: 5, workflow: 'visual-spec' }));
  });

  it('describes the selection by its line, which is what the anchor is', () => {
    const doc = record();
    const source = collabCommentPanelSource({ document: doc, comments: [], add: async () => {}, reply: async () => {} });
    render(<MarkdownSurface source={doc.markdown} />);
    expect(source.describe(selectionOf('[data-vs-loc^="3:"]', 3))).toEqual({
      title: 'First paragraph.',
      detail: ' · line 3',
    });
  });
});

/* ================================================================== *
 * R-5.13 / R-5.14 — a link out, and no control that writes resolution
 * ================================================================== */
describe('R-5.13 / R-5.14 — resolution is read, never written', () => {
  const withGithub = (id: string, isResolved?: boolean): CommentRecord =>
    ({
      ...comment(id, { startLine: 3 }),
      github: {
        reviewCommentId: 700002,
        isOutdated: false,
        ...(isResolved === undefined ? {} : { isResolved }),
        htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r700002',
        user: 'octocat',
        updatedAt: 'T0',
      },
      replies: [],
    }) as unknown as CommentRecord;

  it('offers a link to the thread on github.com and no control that resolves it', () => {
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({ document: record(), comments: [withGithub('c-open', false)], add: async () => {}, reply: async () => {} })}
        />
      </InspectorProvider>,
    );
    const link = screen.getByText('Open on GitHub') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/acme/docs/pull/42#discussion_r700002');
    expect(screen.queryByLabelText('Resolve comment')).toBeNull();
    expect(screen.queryByLabelText('Delete comment')).toBeNull();
  });

  /* R-5.15 — "we could not read it" is not "it is done", so the way out is still offered. */
  it('links a thread whose resolution could not be read, and not one GitHub says is resolved', () => {
    const link = (c: CommentRecord) =>
      collabCommentPanelSource({ document: record(), comments: [c], add: async () => {}, reply: async () => {} }).link?.(c);
    expect(link(withGithub('c-unknown'))).toBe('https://github.com/acme/docs/pull/42#discussion_r700002');
    expect(link(withGithub('c-resolved', true))).toBeUndefined();
  });

  it('labels a row by its heading and line, and flags an outdated one', () => {
    const source = collabCommentPanelSource({ document: record(), comments: [], add: async () => {}, reply: async () => {} });
    expect(source.label(comment('c-1', { startLine: 3 }))).toBe('Spec · L3');
    expect(source.label(comment('c-2', { startLine: 3 }, { outdated: true }))).toBe('Spec · L3 · outdated');
  });
});

/* ================================================================== *
 * The presentation defects the first screenshot of this panel showed
 * ================================================================== */
describe('the row controls say what the system actually does', () => {
  const mount = (comments: CommentRecord[]) =>
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({ document: record(), comments, add: async () => {}, reply: async () => {} })}
        />
      </InspectorProvider>,
    );

  it('draws neither a delete nor a resolve', () => {
    mount([comment('c-1', { startLine: 3 })]);
    expect(screen.queryByLabelText('Delete comment')).toBeNull();
    expect(screen.queryByLabelText('Resolve comment')).toBeNull();
  });

  /* "Reply" borrowed a 22×22 icon square and rendered as "Re / ply". */
  it('worded buttons are sized for words, not for icons', () => {
    mount([comment('c-1', { startLine: 3 })]);
    const reply = screen.getByLabelText('Reply');
    expect(reply.style.width).toBe('auto');
    expect(reply.style.whiteSpace).toBe('nowrap');
  });
});

/* ================================================================== *
 * R-5.13 — History writes nothing, in either mode
 * ================================================================== */
describe('R-5.13 — the History tab offers no way to change resolution', () => {
  it('a collaboration document lists applied comments read-only', async () => {
    const done = comment('c-done', { startLine: 3 }, { text: 'was addressed', status: 'applied' });
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({ document: record(), comments: [done], add: async () => {}, reply: async () => {} })}
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

/* ================================================================== *
 * R-13.18 — a comment says where it lives, and never by omission
 * ================================================================== */
describe('R-13.18 — provenance is a label, not an inference', () => {
  const bound = (): CollaborationRecord => ({
    ...record(),
    github: { owner: 'acme', repo: 'docs', branch: 'spec/1', pullNumber: 42, resolved: false },
  });

  const thread = (id: string, github: Partial<{ htmlUrl: string; isResolved: boolean }>): CommentRecord =>
    ({
      ...comment(id, { startLine: 3 }),
      github: {
        reviewCommentId: 700003,
        isOutdated: false,
        htmlUrl: '',
        user: 'octocat',
        updatedAt: 'T0',
        ...github,
      },
      replies: [],
    }) as unknown as CommentRecord;

  const mount = (comments: CommentRecord[]) =>
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({ document: bound(), comments, add: async () => {}, reply: async () => {} })}
        />
      </InspectorProvider>,
    );

  it('names the pull request a thread lives on', () => {
    mount([thread('c-1', { htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r700003' })]);
    const chip = document.querySelector('[data-vs-comment-origin]') as HTMLElement;
    expect(chip.getAttribute('data-vs-comment-origin')).toBe('github');
    expect(chip.textContent).toBe('On GitHub · #42');
  });

  /*
   * The trap. Both of these render with NO "Open on GitHub" link — one is resolved, so
   * there is no act left to send the reader to, and the other has no permalink to give.
   * Before the chip, each was a card with a comment on it and no control at all: exactly
   * what a local comment looked like. The label must not be derived from the link.
   */
  it('still labels a GitHub thread whose link does not resolve as a GitHub thread', () => {
    mount([
      thread('c-resolved', { htmlUrl: 'https://github.com/acme/docs/pull/42#discussion_r700003', isResolved: true }),
      thread('c-nolink', {}),
    ]);
    const chips = Array.from(document.querySelectorAll('[data-vs-comment-origin]')) as HTMLElement[];
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.getAttribute('data-vs-comment-origin'))).toEqual(['github', 'github']);
    expect(chips.map((c) => c.textContent)).toEqual(['On GitHub · #42', 'On GitHub · #42']);
    // The absence this used to be read from is still there — it just no longer says anything.
    expect(screen.queryByText('Open on GitHub')).toBeNull();
  });

  it('says "On GitHub" without a number when the document has no pull request bound yet', () => {
    render(
      <InspectorProvider surfaceId="docs/spec.md" pageIndex={0}>
        <CommentPanel
          width={320}
          source={collabCommentPanelSource({
            document: record(),
            comments: [thread('c-1', {})],
            add: async () => {},
            reply: async () => {},
          })}
        />
      </InspectorProvider>,
    );
    expect((document.querySelector('[data-vs-comment-origin]') as HTMLElement).textContent).toBe('On GitHub');
  });

  it('labels the sidecar panel’s own comments as local, for a source that declares no origin', async () => {
    const local: CommentRecord = {
      id: 'c-local',
      workflow: 'visual-spec',
      target: { path: 'a.md', kind: 'range', startLine: 10, heading: 'Intro' },
      comment: 'local comment',
      status: 'open',
      ts: '2026-08-07T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([local]))));
    render(
      <InspectorProvider surfaceId="a" pageIndex={0}>
        <CommentPanel file="a" width={320} />
      </InspectorProvider>,
    );
    await waitFor(() => expect(screen.getByText('local comment')).toBeTruthy());
    const chip = document.querySelector('[data-vs-comment-origin]') as HTMLElement;
    expect(chip.getAttribute('data-vs-comment-origin')).toBe('local');
    expect(chip.textContent).toBe('Local only — not on GitHub');
  });
});
