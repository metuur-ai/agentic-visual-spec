/**
 * md-path.ts — bridge between the markdown viewer's surface ids (relative .md
 * path without extension, e.g. "tasks/post-it-notes") and the comment model's
 * real target paths (with extension, "tasks/post-it-notes.md"). Phase 3 drops
 * this once navigation moves to real tree paths.
 */
export const toPath = (surfaceId: string): string => (surfaceId.endsWith('.md') ? surfaceId : `${surfaceId}.md`);
export const toSurfaceId = (path: string): string => path.replace(/\.md$/, '');
