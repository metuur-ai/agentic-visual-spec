// Browser surface — components + hooks for hosting and annotating surfaces.
export * from './lib/sdk';
export { useSurfaceModule } from './lib/use-surface-module';
export type { SurfaceState } from './lib/use-surface-module';
export { findSurfaceSource } from './lib/inspector/fiber';
export type { SourceLoc } from './lib/inspector/fiber';
export { useMarkdownSource, useSpecsRoot, useSurfaceList } from './lib/use-markdown-source';
export { useComments } from './lib/use-comments';
export type { NewComment, UseComments } from './lib/use-comments';
export type { CommentRecord, CommentTarget, CommentTargetKind } from '../editing/comment-doc';

export { SurfaceHost } from './components/surface-host';
export {
  InspectorProvider,
  useInspector,
} from './components/inspector/inspector-provider';
export type { SelectedTarget } from './components/inspector/inspector-provider';
export { InspectOverlay } from './components/inspector/inspect-overlay';
export { collectSection, headingBlockOf } from './lib/inspector/blocks';
export { SelectionReporter } from './components/inspector/selection-reporter';
