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

// Builds the browser UI to dist/ui as static assets, served at runtime by the
// CLI's Node server. Content is fetched from the /__vs API, never baked in.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [react(), ...visualSpecMarkdown({ contentDir, commentsFile })],
  // Lexical must be ONE module instance in the page, or every editor is a stranger to
  // every other one: Lexical stamps `LexicalEditor.version` per module copy and refuses
  // to talk across copies (error #195), which shows up as an editor that renders and
  // then ignores every keystroke — no update listener, so `dirty` never flips and
  // Publish stays disabled forever. Two copies is the default here, not a fluke:
  // `@lexical/*` and `@lyfie/luthor-headless` sit in the workspace pnpm store and
  // resolve `lexical` there, while `ui/node-id-extension.ts` resolves it from this
  // package's own node_modules. Same version, two files, two instances.
  resolve: { dedupe: ['lexical'] },
  build: { outDir: 'dist/ui', emptyOutDir: true },
});
