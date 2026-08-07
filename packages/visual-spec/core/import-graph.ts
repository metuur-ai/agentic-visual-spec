/**
 * import-graph.ts — the static import-graph walker shared by the source-level guards.
 *
 * Extracted verbatim from `core/bundle-guard.test.ts` (task 0.3) when a second guard
 * needed the same traversal (`core/collaboration/import-boundary.test.ts`, R-2.13).
 * One walker, two forbidden-thing predicates: 0.3 asks "does this graph reach a
 * forbidden *package*", 2.4 asks "does this graph reach a forbidden *binding*".
 *
 * Test-support only — nothing in the shipped runtime imports it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

/** Every `from '…'`, bare `import '…'` and `import('…')` specifier in a source file. */
export function specifiersOf(source: string): string[] {
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
export function resolveRelative(fromFile: string, specifier: string): string | null {
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

/** One module reached from an entry, plus the `entry → … → module` chain that got there. */
export type VisitedModule = {
  /** Absolute path of the module. */
  file: string;
  /** Its source text. */
  source: string;
  /** Every import specifier it declares. */
  specifiers: string[];
  /** Package-relative chain from the entry to (and including) this module. */
  chain: string[];
};

/**
 * Breadth-first walk of the static import graph from `entry`, visiting each reachable
 * module exactly once. Only relative specifiers are followed — bare ones are reported
 * to `visit` via `specifiers` so the caller can judge them, but are not traversed.
 */
export function walkImportGraph(pkgRoot: string, entry: string, visit: (module: VisitedModule) => void): void {
  const seen = new Set<string>();
  const queue: { file: string; chain: string[] }[] = [{ file: resolve(pkgRoot, entry), chain: [entry] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    const specifiers = specifiersOf(source);
    visit({ file, source, specifiers, chain });

    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue; // bare deps are the caller's to judge
      const next = resolveRelative(file, specifier);
      if (next) queue.push({ file: next, chain: [...chain, relative(pkgRoot, next)] });
    }
  }
}
