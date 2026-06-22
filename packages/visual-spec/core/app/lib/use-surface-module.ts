/**
 * use-surface-module.ts — dynamically load a surface module and reload on HMR.
 */
import { useEffect, useState } from 'react';
import { loadSurface } from 'virtual:visual-spec/surfaces';
import type { SurfaceModule } from './sdk';

export type SurfaceState =
  | { status: 'loading' }
  | { status: 'ready'; module: SurfaceModule }
  | { status: 'error'; error: Error };

export function useSurfaceModule(surfaceId: string): SurfaceState {
  const [state, setState] = useState<SurfaceState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    const load = () => {
      loadSurface(surfaceId)
        .then((module) => alive && setState({ status: 'ready', module }))
        .catch((error: Error) => alive && setState({ status: 'error', error }));
    };
    load();

    // Reload when the dev plugin signals this surface changed.
    const hot = import.meta.hot;
    const onChange = (payload: { surfaceId?: string }) => {
      if (!payload?.surfaceId || payload.surfaceId === surfaceId) load();
    };
    hot?.on('visual-spec:surface-changed', onChange);
    return () => {
      alive = false;
      hot?.off('visual-spec:surface-changed', onChange);
    };
  }, [surfaceId]);

  return state;
}
