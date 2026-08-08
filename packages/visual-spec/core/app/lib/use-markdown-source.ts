/**
 * use-markdown-source.ts — fetch the surface list and raw markdown source from
 * the /__vs/source endpoints, refetching on HMR. Renderer-agnostic (the viewer
 * supplies react-markdown), so these live in core; MarkdownSurface does not.
 */
import { useCallback, useEffect, useState } from 'react';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function useSurfaceList(): { surfaces: string[]; loading: boolean } {
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch('/__vs/source/list')
      .then((r) => json<string[]>(r))
      .then(setSurfaces)
      .catch(() => setSurfaces([]))
      .finally(() => setLoading(false));
  }, []);
  return { surfaces, loading };
}

export function useSpecsRoot(): string {
  const [root, setRoot] = useState('');
  useEffect(() => {
    fetch('/__vs/source/root')
      .then((r) => json<{ root: string }>(r))
      // `json<T>` is an unchecked cast, so a response without `root` puts
      // `undefined` behind a `string` type and every consumer that calls a string
      // method on it throws — `Brand` in main-header.tsx takes the whole header
      // down that way. The type is the contract; make the runtime honour it.
      .then((d) => setRoot(d.root ?? ''))
      .catch(() => setRoot(''));
  }, []);
  return root;
}

export function useMarkdownSource(surfaceId: string): { source: string; loading: boolean } {
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!surfaceId) return;
    setLoading(true);
    fetch(`/__vs/source?surfaceId=${encodeURIComponent(surfaceId)}`)
      .then((r) => json<{ source: string }>(r))
      .then((d) => setSource(d.source))
      .catch(() => setSource(''))
      .finally(() => setLoading(false));
  }, [surfaceId]);

  useEffect(() => {
    refetch();
    // Dev mode pings over HMR when a watched .md changes. The standalone server
    // has no HMR, so the Apply button fires a window event after `claude -p`
    // rewrites the file — listen for both.
    const hot = import.meta.hot;
    // `hot?.on(...)` guards the wrong thing. Optional chaining only answers "is
    // `hot` there", and the object that actually breaks is one that IS there
    // with half the API on it: the test runner's `import.meta.hot` shim
    // implements `on` and not `off`. The cleanup then threw
    // `hot.off is not a function`, React reported it as an unmount error, and
    // the tree came down — no test could mount a markdown pane for real. Check
    // the method is callable, not that its owner exists.
    if (typeof hot?.on === 'function') hot.on('visual-spec:surface-changed', refetch);
    window.addEventListener('vs:source-changed', refetch);
    return () => {
      // Guarded first for the same reason, and because this cleanup owns the
      // window listener too: a throw here would leave that one attached forever.
      if (typeof hot?.off === 'function') hot.off('visual-spec:surface-changed', refetch);
      window.removeEventListener('vs:source-changed', refetch);
    };
  }, [refetch]);

  return { source, loading };
}
