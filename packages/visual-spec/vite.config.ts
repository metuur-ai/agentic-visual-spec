import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Source import: pulls in the virtual-surfaces stub so the UI's `../core/app`
// import resolves cleanly during the static build (markdown mode has no TSX surfaces).
import { visualSpecMarkdown } from './core/vite/md-plugin';

// Surface the package version to the UI (rendered in the sidebar footer).
const pkgVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

// `pnpm --filter visual-spec dev <dir>` sets VS_CONTENT_DIR to the specs folder
// to serve in dev (see dev.mjs). For the static build it's unset → default 'content'.
const contentDir = process.env.VS_CONTENT_DIR || 'content';
// Keep comments next to the specs (matches the production CLI) for an absolute dir.
const commentsFile = isAbsolute(contentDir)
  ? join(contentDir, 'visual-spec-comments.json')
  : 'visual-spec-comments.json';

/**
 * `VS_COLLAB_REPO=owner/repo` — name the collaboration repository explicitly in dev.
 *
 * With nothing set, the plugin infers it from the served directory's git origin. That is
 * right almost always, and wrong in one case that costs an afternoon: a repository renamed
 * or transferred on GitHub while `origin` still holds the old name. Reads keep working —
 * `gh` follows the redirect on a GET — so the surface looks healthy until the first write,
 * which GitHub answers with a 307 that `gh` will not follow. This is the escape hatch for
 * that, and for pointing a dev server at a repository the checkout is not a clone of.
 *
 * Deliberately an environment variable and not a literal here: this file is shared, and a
 * repository hard-coded in it would follow every contributor. `VS_NO_COLLAB` is the same
 * shape of override for the same reason — a plugin takes flags from nobody.
 */
const repoRef = process.env.VS_COLLAB_REPO?.trim();
const [collabOwner, collabRepo] = repoRef ? repoRef.split('/') : [];
if (repoRef && (!collabOwner || !collabRepo)) {
  throw new Error(`VS_COLLAB_REPO must be "owner/repo", got: ${repoRef}`);
}
const collaboration = collabOwner && collabRepo ? { owner: collabOwner, repo: collabRepo } : null;

// Builds the browser UI to dist/ui as static assets, served at runtime by the
// CLI's Node server. Content is fetched from the /__vs API, never baked in.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [
    react(),
    ...visualSpecMarkdown({ contentDir, commentsFile, ...(collaboration ? { config: { collaboration } } : {}) }),
  ],
  // Lexical must be ONE module instance in the page, or every editor is a stranger to
  // every other one: Lexical stamps `LexicalEditor.version` per module copy and refuses
  // to talk across copies (error #195), which shows up as an editor that renders and
  // then ignores every keystroke — no update listener, so `dirty` never flips and
  // Publish stays disabled forever. Two copies is the default here, not a fluke:
  // `@lexical/*` and `@lyfie/luthor-headless` sit in the workspace pnpm store and
  // resolve `lexical` there, while `ui/wysiwyg-editor.tsx` resolves it from this
  // package's own node_modules. Same version, two files, two instances.
  resolve: { dedupe: ['lexical'] },
  build: { outDir: 'dist/ui', emptyOutDir: true },
});
