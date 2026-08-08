/**
 * browser-safety.test.ts — no node builtin may be reachable from the browser bundle.
 *
 * WHY THIS EXISTS. `core/bundle-guard.test.ts` guards the other direction: no react in a
 * Node-reachable entrypoint. Nothing guarded this one, and the cost was real — from
 * `3fd0095`, the commit that first mounted the collaboration UI in `App.tsx`, until this
 * file was written, **`npm run build` failed outright**. Mounting the UI made
 * `ui/collab-app.tsx` → `failure-states.ts` → `cache-lifecycle.ts` and
 * `ui/collab-editor.tsx` → `node-identity.ts` → `document-store.ts` reachable, dragging
 * `node:fs/promises` and `node:path` into the browser graph, and Vite failed on
 * `"rm" is not exported by "__vite-browser-external"`.
 *
 * The whole test suite stayed green throughout, because vitest runs in Node and resolves
 * those imports perfectly well. Only the bundler ever saw the problem, and nobody was
 * running the bundler. A green suite said nothing about whether the product could build.
 *
 * WHY IT DOES NOT REUSE `walkImportGraph`. That walker's `specifiersOf` matches `import`
 * and `import type` alike. Type-only edges are erased at compile time and reach no
 * runtime code, so following them here would report modules the bundle never contains —
 * `ui/collab-client.ts` type-imports `job-hub`, and half of `ui/` type-imports
 * `document-protocol`. A guard that cries wolf gets deleted, so this one traverses value
 * imports only.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'ui/App.tsx';
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Value-import specifiers only. `import type { X } from 'y'` and `export type { X } from
 * 'y'` are dropped; `import { type X, y } from 'z'` is kept, because `y` is a value.
 */
export function valueSpecifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => resolve(base, `index${e}`))]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every `entry → … → module` chain whose final module imports a `node:` builtin. */
function nodeBuiltinChains(entry: string): string[] {
  const offences: string[] = [];
  const seen = new Set<string>();
  const queue: { file: string; chain: string[] }[] = [{ file: resolve(pkgRoot, entry), chain: [entry] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    const specifiers = valueSpecifiersOf(source);

    const builtins = [...new Set(specifiers.filter((s) => s.startsWith('node:')))].sort();
    if (builtins.length > 0) offences.push(`${chain.join(' → ')}  imports ${builtins.join(', ')}`);

    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const next = resolveRelative(file, specifier);
      if (next) queue.push({ file: next, chain: [...chain, relative(pkgRoot, next)] });
    }
  }
  return offences.sort();
}

describe('the browser bundle reaches no node builtin', () => {
  it(`nothing value-imported from ${ENTRY} imports \`node:*\``, () => {
    // Joined rather than compared as an array so a failure prints the offending chains in
    // full instead of vitest's `[ …(6) ]` elision — the chain is the whole diagnosis.
    expect(nodeBuiltinChains(ENTRY).join('\n')).toBe('');
  });

  /*
   * The negative control. Without it this test passes just as happily when the traversal
   * is broken as when the graph is clean, which is how the original defect survived a
   * green suite for so long.
   */
  it('reports offences rather than always passing', () => {
    // `document-store.ts` is Node-only by design and is *not* reachable by value from the
    // app. Pointed at it directly, the walker must find the builtins it really imports.
    const chains = nodeBuiltinChains('core/collaboration/document-store.ts');
    expect(chains.join('\n')).toMatch(/node:fs\/promises/);
  });

  it('does not follow type-only edges', () => {
    expect(valueSpecifiersOf("import type { A } from './a';")).toEqual([]);
    expect(valueSpecifiersOf("export type { A } from './a';")).toEqual([]);
    // A value binding alongside an inline type is still a value import.
    expect(valueSpecifiersOf("import { type A, b } from './a';")).toEqual(['./a']);
    expect(valueSpecifiersOf("import { a } from './a';")).toEqual(['./a']);
  });
});
