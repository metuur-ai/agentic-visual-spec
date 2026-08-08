/**
 * browser-safety.test.ts — no node builtin may be reachable from the browser bundle.
 *
 * WHY THIS EXISTS. `core/bundle-guard.test.ts` guards the other direction: no react in a
 * Node-reachable entrypoint. Nothing guarded this one, and the cost was real — from
 * `3fd0095`, the commit that first mounted the collaboration UI in `App.tsx`, until this
 * file was written, **`npm run build` failed outright**. Mounting the UI made
 * `ui/collab-app.tsx` → `failure-states.ts` → `cache-lifecycle.ts` reachable, and the
 * collaboration editor reachable the store that holds documents on disk, dragging
 * `node:fs/promises` and `node:path` into the browser graph; Vite failed on
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
 * `document-record`. A guard that cries wolf gets deleted, so this one traverses value
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

/** Every module value-reachable from `entry`, as package-relative paths. */
function valueReachableModules(entry: string): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [resolve(pkgRoot, entry)];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const rel = relative(pkgRoot, file);
    if (reached.has(rel)) continue;
    reached.add(rel);

    for (const specifier of valueSpecifiersOf(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const next = resolveRelative(file, specifier);
      if (next) queue.push(next);
    }
  }
  return reached;
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
    // `record-store.ts` is Node-only by design and is *not* reachable by value from the
    // app — `document-record.ts` next door is the half that is. Pointed at the Node-only
    // one directly, the walker must find the builtins it really imports.
    const chains = nodeBuiltinChains('core/collaboration/record-store.ts');
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

/*
 * R-1.3 — the git reader stays out of the browser bundle.
 *
 * `core/git-context.ts` shells out to git through `node:child_process`. The blanket
 * `node:*` assertion above would catch it once it were reachable, but naming it here is
 * not redundant: the failure message is the difference between "something in this graph
 * imports node:child_process" and "the git reader crossed the boundary", and that module
 * is the one the header chip work is actively pulling on.
 *
 * WHY THIS IS PHRASED AS REACHABILITY, NOT AS ABSENCE. Today nothing imports
 * `core/git-context.ts` at all, so it is outside every graph by omission. An assertion
 * that merely said "the browser graph does not contain node:child_process" would pass
 * trivially now and go on passing for the wrong reason — right up until someone wires the
 * chip up wrongly, at which point it would finally do its job, having taught nobody
 * anything in between. So the module is named explicitly, and the control below asserts
 * the graph the assertion is drawn over is a real one.
 *
 * THE INTENDED WAY ACROSS. Not `import type`. `ui/use-tree.ts` redeclares `TreeEntry` and
 * `FileKind` rather than importing them from `tree-store.ts`, precisely because a `type`
 * keyword a later edit deletes is not a boundary. `ui/use-git-context.ts` redeclares
 * `GitContext` for the same reason; this test is what keeps that honest.
 */
describe('the browser bundle does not reach the git reader (R-1.3)', () => {
  const GIT_CONTEXT = 'core/git-context.ts';

  it(`${GIT_CONTEXT} is not value-reachable from ${ENTRY}`, () => {
    expect([...valueReachableModules(ENTRY)]).not.toContain(GIT_CONTEXT);
  });

  it(`nothing value-reachable from ${ENTRY} imports node:child_process`, () => {
    const offences = nodeBuiltinChains(ENTRY).filter((chain) => chain.includes('node:child_process'));
    expect(offences.join('\n')).toBe('');
  });

  /*
   * The two controls, one per half of the claim above.
   *
   * First: the reachability set is genuinely populated by walking, so "git-context is not
   * in it" means something. `ui/use-tree.ts` is a module the app really does import.
   */
  it('the reachability set is a real graph, not an empty one', () => {
    const reached = valueReachableModules(ENTRY);
    expect(reached.size).toBeGreaterThan(1);
    expect([...reached]).toContain('ui/use-tree.ts');
  });

  /*
   * Second: the module being excluded is genuinely the dangerous one. If `git-context.ts`
   * ever stops shelling out, this fails and someone gets to ask whether the guard above is
   * still guarding anything.
   */
  it(`${GIT_CONTEXT} really does import node:child_process`, () => {
    expect(nodeBuiltinChains(GIT_CONTEXT).join('\n')).toMatch(/node:child_process/);
  });
});
