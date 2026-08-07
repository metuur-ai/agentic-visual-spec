import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `lexical` is reachable both directly and through Luthor's dependency tree. Vite
  // keeps the package-local symlink path for one and the pnpm store path for the
  // other, producing two module instances — and Lexical then rejects every node
  // class with "does not subclass LexicalNode". Dedupe pins one instance.
  resolve: { dedupe: ['lexical'] },
  test: {
    globals: true,
    // .tsx tests opt into jsdom per-file with a `// @vitest-environment jsdom`
    // docblock; the default stays `node` so the existing suite is untouched.
    include: ['core/**/*.test.ts', 'ui/**/*.test.ts', 'ui/**/*.test.tsx'],
    server: {
      deps: {
        // Luthor ships ESM that imports `lexical` itself. Left external, Node
        // loads it natively while the test's own `import ... from 'lexical'`
        // comes from Vite's pipeline — two module instances, and Lexical rejects
        // the node classes with "does not subclass LexicalNode". Inlining puts
        // both on the same instance.
        inline: [/node_modules\/(@lyfie|@lexical|lexical)\//],
      },
    },
  },
});
