import { defineConfig } from 'tsup';

/**
 * Build the consumable library entry points to dist (ESM + d.ts) so scaffolded
 * projects resolve real JavaScript via `visual-spec/{config,vite,app,editing}`.
 * The engine source lives in core/; the CLI (dist/cli.js, built by build.mjs)
 * bundles that same source inline, so it needs no runtime dependency on these.
 */
export default defineConfig({
  entry: {
    index: 'core/index.ts',
    'editing/index': 'core/editing/index.ts',
    'app/index': 'core/app/index.ts',
    'vite/index': 'core/vite/index.ts',
    config: 'core/config.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'vite',
    '@babel/parser',
    '@babel/traverse',
    '@babel/types',
    'virtual:visual-spec/surfaces',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
