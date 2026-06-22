/**
 * The Vite preset — drop `visualSpec()` into a project's vite.config.ts to wire
 * loc-tags, surface discovery, and the live-selection bridge.
 */
import type { Plugin } from 'vite';
import { type VisualSpecConfig, resolveConfig } from '../config';
import { currentPlugin } from './current-plugin';
import { locTagsPlugin } from './loc-tags';
import { visualSpecPlugin } from './visual-spec-plugin';

export function visualSpec(config: VisualSpecConfig = {}): Plugin[] {
  const { surfacesDir } = resolveConfig(config);
  return [
    locTagsPlugin({ surfacesDir }),
    visualSpecPlugin({ surfacesDir }),
    currentPlugin(),
  ];
}

export { currentPlugin, locTagsPlugin, visualSpecPlugin };
export { visualSpecMarkdown } from './md-plugin';
export type { MarkdownOptions } from './md-plugin';
export * from './surface-store';
export * from './tree-store';
