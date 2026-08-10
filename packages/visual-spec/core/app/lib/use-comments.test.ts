// @vitest-environment jsdom
/**
 * use-comments.test.ts — the two properties that make one shared cache worth having.
 *
 * Before the store existed, each call site held its own copy: five hooks on a screen
 * meant five requests per change and five render cascades, including on a plain window
 * focus that found nothing new. Both are pinned here because both are invisible — the
 * screen looks identical either way, and only the request log and the profiler differ.
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRecord } from '../../editing/comment-doc';
import { resetCommentsCache, useComments } from './use-comments';

const record: CommentRecord = {
  id: 'c1',
  workflow: 'visual-spec',
  target: { path: 'a.md', kind: 'range', startLine: 3, heading: null, snippet: 's' },
  comment: 'look at this',
  status: 'open',
  ts: '2026-08-09T00:00:00.000Z',
};

/** Counts renders and reports the comments each reader saw. */
function Reader({ path, renders }: { path?: string; renders: { n: number } }) {
  useComments(path);
  renders.n += 1;
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: string[];

beforeEach(() => {
  resetCommentsCache();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify([record]), { headers: { 'content-type': 'application/json' } });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useComments shares one cache per query', () => {
  it('three readers of the same path cost one request, not three', async () => {
    const renders = { n: 0 };
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(Reader, { path: 'a.md', renders }),
          createElement(Reader, { path: 'a.md', renders }),
          createElement(Reader, { path: 'a.md', renders }),
        ),
      );
    });

    expect(calls).toEqual(['/__vs/comments?path=a.md']);
  });

  it('keeps the unfiltered list and a path as separate queries', async () => {
    const renders = { n: 0 };
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(Reader, { renders }),
          createElement(Reader, { path: 'a.md', renders }),
        ),
      );
    });

    expect([...calls].sort()).toEqual(['/__vs/comments', '/__vs/comments?path=a.md']);
  });

  /*
   * The one that pays for the whole design. `refetch` runs on window focus and after
   * every mutation anywhere in the app; if an unchanged sidecar still installed a new
   * array, alt-tabbing back would re-render every reader and re-reconcile the file tree.
   */
  it('a refetch that finds the same records re-renders nobody', async () => {
    const renders = { n: 0 };
    await act(async () => {
      root.render(createElement(Reader, { path: 'a.md', renders }));
    });
    const settled = renders.n;
    expect(calls).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('vs:comments-changed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toHaveLength(2); // it did re-read the sidecar…
    expect(renders.n).toBe(settled); // …and told nobody, because nothing changed
  });

  it('a refetch that finds a change does re-render', async () => {
    const renders = { n: 0 };
    await act(async () => {
      root.render(createElement(Reader, { path: 'a.md', renders }));
    });
    const settled = renders.n;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify([{ ...record, comment: 'edited' }]), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await act(async () => {
      window.dispatchEvent(new CustomEvent('vs:comments-changed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renders.n).toBeGreaterThan(settled);
  });
});
