/**
 * routes-host-agnostic.test.ts — R-4.6: nothing under `core/vite/routes/` may reach `vite`.
 *
 * WHY THIS EXISTS. This directory sits under `core/vite/` by accident of history, not by
 * dependency. It is the *shared* route layer: `src/server.ts` — the standalone host, which
 * never loads Vite — imports `routes/comments`, `routes/apply`, `routes/collab`,
 * `routes/collab-wiring` and `routes/upload` straight out of it. That works today only
 * because none of those modules happens to import `vite`, and "happens to" is not a
 * guarantee. The new write routes land here too, and a `vite` import creeping in via a
 * shared helper would not fail review — it would fail `npm run build` of the standalone
 * host, which is the same shape of defect `ui/browser-safety.test.ts` was written for:
 * every test green, the product unbuildable.
 *
 * The assertion is over the *directory*, not over a list of modules, so a route added
 * tomorrow is covered the day it is written rather than the day someone remembers to add
 * it here.
 *
 * Type-only edges are deliberately NOT excused. `walkImportGraph` sees `import type` and
 * `import` alike, and that is the behaviour this guard wants: `import type { Plugin } from
 * 'vite'` is one careless edit away from being a value import, and the whole point of the
 * boundary is that it cannot be crossed by accident. If a route ever genuinely needs a
 * Vite type, the repository's answer is the one `ui/use-tree.ts` uses for `TreeEntry` and
 * `FileKind` — redeclare it on this side of the boundary.
 */
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkImportGraph } from '../../import-graph';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..');

/** `vite` itself and any subpath of it (`vite/client`, …). Nothing else is forbidden. */
const FORBIDDEN = /^vite($|\/)/;

/** Every shipped module in this directory — tests excluded, they are not host code. */
function routeModules(): string[] {
  return readdirSync(here)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => relative(pkgRoot, resolve(here, name)))
    .sort();
}

/** Walk from `entry` and return every `entry → … → 'vite'` chain found. */
function viteReachableFrom(entry: string): string[] {
  const violations: string[] = [];
  walkImportGraph(pkgRoot, entry, ({ chain, specifiers }) => {
    for (const specifier of specifiers) {
      if (FORBIDDEN.test(specifier)) violations.push([...chain, specifier].join(' → '));
    }
  });
  return violations;
}

describe('core/vite/routes is host-agnostic (R-4.6)', () => {
  const modules = routeModules();

  // If the glob ever comes back empty — a rename, a moved directory — the per-module loop
  // below would silently assert nothing at all and stay green forever.
  it('finds the route modules it is meant to be guarding', () => {
    expect(modules.length).toBeGreaterThan(0);
    // The five the standalone host actually imports; the guard is worthless if it stops
    // covering them.
    expect(modules).toEqual(
      expect.arrayContaining([
        'core/vite/routes/apply.ts',
        'core/vite/routes/collab.ts',
        'core/vite/routes/collab-wiring.ts',
        'core/vite/routes/comments.ts',
        'core/vite/routes/upload.ts',
      ]),
    );
  });

  for (const entry of modules) {
    it(`${entry} reaches no \`vite\` import`, () => {
      // Joined rather than compared as an array so a failure prints the full chain — the
      // chain is the diagnosis, the offending file is rarely the one that was edited.
      expect(viteReachableFrom(entry).join('\n')).toBe('');
    });
  }

  /*
   * The negative control. Without it this test passes just as happily when the traversal
   * is broken as when the directory is clean. `visual-spec-plugin.ts` is one level up and
   * is Vite-by-definition — the walker must find `vite` there.
   */
  it('reports a `vite` import when one genuinely exists', () => {
    expect(viteReachableFrom('core/vite/visual-spec-plugin.ts').join('\n')).toMatch(/→ vite$/m);
  });
});
