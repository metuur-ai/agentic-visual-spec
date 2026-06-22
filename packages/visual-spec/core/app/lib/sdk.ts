/**
 * sdk.ts — the surface authoring contract. A surface is `surfaces/<id>/index.tsx`
 * default-exporting an array of zero-prop page components.
 */
import type { ComponentType } from 'react';

export type Page = ComponentType;

export type Projection =
  | { kind: 'canvas'; width: number; height: number } // fixed-size, scale-to-fit (slide-like)
  | { kind: 'flow' }; // natural document flow (screen/mockup)

export type SurfaceMeta = {
  title?: string;
  projection?: Projection;
};

export type SurfaceModule = {
  default: Page[];
  meta?: SurfaceMeta;
};

/** Default projection when a surface declares none. */
export const DEFAULT_PROJECTION: Projection = { kind: 'canvas', width: 1920, height: 1080 };

export function resolveProjection(meta?: SurfaceMeta): Projection {
  return meta?.projection ?? DEFAULT_PROJECTION;
}
