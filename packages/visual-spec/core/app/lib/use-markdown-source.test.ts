// @vitest-environment jsdom
/**
 * use-markdown-source.test.ts — unmounting a component that uses
 * `useMarkdownSource` must not throw.
 *
 * The effect subscribes to the HMR channel with `import.meta.hot?.on(...)` and
 * unsubscribes with `import.meta.hot?.off(...)`. Optional chaining guards the
 * wrong thing: it protects against `hot` being *absent*, not against `hot` being
 * present without an `off` method — which is exactly the shape of the shim the
 * test runner injects. The result was a `hot.off is not a function` thrown from
 * cleanup, which React surfaces as an unmount error and which takes the whole
 * tree down mid-test. This file mounts and unmounts for real, so a regression to
 * "the object exists, therefore the method exists" fails here.
 *
 * No JSX: `core/**` tests are collected as `.test.ts` only (see vitest.config.ts),
 * so the component is built with `createElement`.
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarkdownSource } from './use-markdown-source';

function Probe({ id }: { id: string }) {
  const { source } = useMarkdownSource(id);
  return createElement('div', { 'data-testid': 'src' }, source);
}

/** Mount `<Probe />` into a detached container and hand back its unmount. */
async function mount(id = 'a.md') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe, { id }));
  });
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useMarkdownSource — subscribing to HMR must not break unmount', () => {
  it('mounts and unmounts without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ source: '# a' }), text: async () => '' }) as unknown as Response),
    );

    const { host, unmount } = await mount();
    expect(host.textContent).toBe('# a');
    // The assertion is that this does not throw. Before the fix it threw
    // `hot.off is not a function` out of the effect cleanup.
    await expect(unmount()).resolves.toBeUndefined();
  });

  it('still tears the window listener down — the HMR guard must not abort cleanup', async () => {
    // The two unsubscribes share one cleanup function, and the `off` one runs
    // first. A throw there skipped `removeEventListener`, so the unmounted
    // component kept refetching on every `vs:source-changed`. Guarding `off`
    // has to leave the rest of the cleanup reachable, which is what this asserts.
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ source: '# b' }), text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = await mount('b.md');
    await unmount();
    const after = fetchMock.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event('vs:source-changed'));
    });
    expect(fetchMock.mock.calls.length).toBe(after);
  });
});
