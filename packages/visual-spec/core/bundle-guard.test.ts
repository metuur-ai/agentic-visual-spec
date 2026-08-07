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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entrypoints whose code runs in (or is bundled for) Node. */
const NODE_REACHABLE_ENTRIES = ['src/cli.ts', 'core/vite/index.ts', 'core/index.ts'];

/** Bare specifiers that must never appear anywhere in those graphs. */
const FORBIDDEN = /^(react|react-dom|@lyfie\/luthor)($|\/)/;

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

/** Every `from '…'`, bare `import '…'` and `import('…')` specifier in a source file. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** Resolve a relative specifier to a real source file, or null if it isn't one. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => resolve(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Walk the static import graph, returning `entry → … → offender` chains. */
function forbiddenPaths(entry: string): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  const queue: { file: string; chain: string[] }[] = [
    { file: resolve(pkgRoot, entry), chain: [entry] },
  ];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (FORBIDDEN.test(specifier)) {
        violations.push([...chain, specifier].join(' → '));
        continue;
      }
      if (!specifier.startsWith('.')) continue; // other bare deps are somebody else's problem
      const next = resolveRelative(file, specifier);
      if (next) queue.push({ file: next, chain: [...chain, relative(pkgRoot, next)] });
    }
  }
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
