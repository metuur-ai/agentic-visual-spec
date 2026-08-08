/**
 * bundle-guard.test.ts — R-12.6 / R-3.3.
 *
 * Luthor is UI-only. `@lyfie/luthor` drags `react-dom/server` in with it, and
 * esbuild turns that into a 3.8 MB CLI artifact that throws
 * `Dynamic require of "react-dom/server.node.js"` the moment it is imported.
 * One stray import from core/ ships a broken binary, so the import graph of every
 * Node-reachable entrypoint is walked here and asserted clean.
 *
 * This is the STATIC layer (TypeScript sources, no build needed). The complementary
 * BUILD-OUTPUT layer is `npm run check:bundle`, which greps the emitted bundles.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkImportGraph } from './import-graph';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entrypoints whose code runs in (or is bundled for) Node. */
const NODE_REACHABLE_ENTRIES = ['src/cli.ts', 'core/vite/index.ts', 'core/index.ts'];

/** Bare specifiers that must never appear anywhere in those graphs. */
const FORBIDDEN = /^(react|react-dom|@lyfie\/luthor)($|\/)/;

/** Walk the static import graph, returning `entry → … → offender` chains. */
function forbiddenPaths(entry: string): string[] {
  const violations: string[] = [];
  walkImportGraph(pkgRoot, entry, ({ chain, specifiers }) => {
    for (const specifier of specifiers) {
      // other bare deps are somebody else's problem; relative ones the walker follows
      if (FORBIDDEN.test(specifier)) violations.push([...chain, specifier].join(' → '));
    }
  });
  return violations;
}

describe('Node-reachable import graph (R-12.6, R-3.3)', () => {
  for (const entry of NODE_REACHABLE_ENTRIES) {
    it(`${entry} reaches no react / react-dom / @lyfie/luthor`, () => {
      expect(forbiddenPaths(entry)).toEqual([]);
    });
  }

  // Proves the walker actually traverses rather than vacuously passing: the UI
  // graph, which legitimately owns Luthor and React, must trip the same check.
  it('detects a forbidden import when one genuinely exists (ui/luthor-bridge.ts)', () => {
    expect(forbiddenPaths('ui/luthor-bridge.ts').join('\n')).toContain('@lyfie/luthor');
  });
});

/*
 * The prompt that hands review comments to an agent names the document by its own
 * `documentPath`, and the agent is spawned with the apply hub's `cwd`. `documentPath` is
 * only resolvable from there because `fsCollaborationStore` writes the Markdown at
 * `<baseDir>/<documentPath>` — so the two directories have to be the same one. They are
 * two different expressions in two different hosts, and they only agree because each host
 * derives both from one variable. Let them drift and the agent opens a file that is not
 * there — or worse, one that is.
 *
 * The store this reads used to be `fsDocumentStore`, which held the document as JSON at a
 * path of its own choosing; the invariant did not change with the format, only the name
 * of the thing that establishes the root.
 */
describe('the agent runs where the documents are', () => {
  const HOSTS = ['src/server.ts', 'core/vite/md-plugin.ts'];

  it.each(HOSTS)('%s spawns apply in the same directory it stores documents in', (host) => {
    const source = readFileSync(resolve(pkgRoot, host), 'utf8');
    const cwd = /createApplyHub\(\(\) => \(\{ cwd: (\w+)/.exec(source)?.[1];
    const base = /fsCollaborationStore\((\w+)\)/.exec(source)?.[1];
    expect(cwd).toBeDefined();
    expect(base).toBeDefined();
    expect(cwd).toBe(base);
  });
});
