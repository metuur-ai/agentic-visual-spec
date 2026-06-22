import { defineConfig } from 'tsup';

/**
 * Build the consumable entry points to dist (ESM + d.ts) so installed projects
 * resolve real JavaScript. Source stays the dev path (tests, demo preset, CLI run
 * via tsx all import from src directly).
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'editing/index': 'src/editing/index.ts',
    'app/index': 'src/app/index.ts',
    'vite/index': 'src/vite/index.ts',
    config: 'src/config.ts',
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
