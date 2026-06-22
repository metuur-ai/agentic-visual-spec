declare module 'virtual:visual-spec/surfaces' {
  import type { SurfaceModule, SurfaceMeta } from './lib/sdk';
  export const surfaceIds: string[];
  export const surfaceMeta: Record<string, SurfaceMeta>;
  export function loadSurface(id: string): Promise<SurfaceModule>;
}
