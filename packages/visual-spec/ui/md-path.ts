/**
 * md-path.ts — bridge between the markdown viewer's surface ids (relative .md
 * path without extension, e.g. "tasks/post-it-notes") and the comment model's
 * real target paths (with extension, "tasks/post-it-notes.md"). Phase 3 drops
 * this once navigation moves to real tree paths.
 */
export const toPath = (surfaceId: string): string => (surfaceId.endsWith('.md') ? surfaceId : `${surfaceId}.md`);
export const toSurfaceId = (path: string): string => path.replace(/\.md$/, '');

/** Normalize a relative path, collapsing `.`/`..` segments. */
export function normalizeRelPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Build a resolver for markdown image srcs. Absolute URLs/data URIs pass through;
 * relative paths resolve against the file's directory and stream from /__vs/raw.
 *
 * This is a render-time-only transform: the stored .md keeps its plain relative
 * paths, so the file stays portable to any simple markdown viewer.
 */
export function makeImageResolver(filePath: string): (src: string) => string {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  return (src: string) => {
    if (/^(https?:|data:|blob:|\/\/)/i.test(src)) return src;
    const joined = normalizeRelPath(dir ? `${dir}/${src}` : src);
    return `/__vs/raw?path=${encodeURIComponent(joined)}`;
  };
}
