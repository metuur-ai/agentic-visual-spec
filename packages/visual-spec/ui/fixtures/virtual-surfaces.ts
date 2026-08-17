/**
 * virtual-surfaces.ts — test-only stand-in for the `virtual:visual-spec/surfaces`
 * module the Vite plugin generates at dev time.
 *
 * `core/app/index.ts` re-exports `useSurfaceModule`, which imports that virtual id, so
 * any jsdom test that mounts a component importing the `core/app` barrel (the comment
 * panel, the indicator layer) fails to resolve it. `vitest.config.ts` aliases the id
 * here. Nothing in the shipped bundle reaches this file.
 */
import type { SurfaceMeta, SurfaceModule } from '../../core/app/lib/sdk';

export const surfaceIds: string[] = [];
export const surfaceMeta: Record<string, SurfaceMeta> = {};

export function loadSurface(id: string): Promise<SurfaceModule> {
  return Promise.reject(new Error(`no surface module in tests: ${id}`));
}
