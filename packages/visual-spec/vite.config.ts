import { isAbsolute, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Source import: pulls in the virtual-surfaces stub so `@visual-spec/core/app`
// resolves cleanly during the static build (markdown mode has no TSX surfaces).
import { visualSpecMarkdown } from '../core/src/vite/md-plugin';

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
  plugins: [react(), ...visualSpecMarkdown({ contentDir, commentsFile })],
  build: { outDir: 'dist/ui', emptyOutDir: true },
  optimizeDeps: { exclude: ['@visual-spec/core'] },
});
