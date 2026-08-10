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

/** Every module reachable from `entry`, package-relative. */
function reachedFrom(entry: string): string[] {
  const files: string[] = [];
  walkImportGraph(pkgRoot, entry, ({ chain }) => files.push(chain[chain.length - 1]!));
  return files;
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
   * R-W5.7 — WHERE A REVIEW READS FROM IS DECIDED IN THE SHARED LAYER, FOR BOTH HOSTS.
   *
   * The loop above already covers `collab.ts` because it is in this directory, and the
   * walk is transitive, so the review-source modules are covered too. That is exactly why
   * this is stated rather than left implicit: the coverage is real and invisible, and the
   * first person to move source selection somewhere a host can reach it directly would
   * break R-W5.7 without failing a single test that names it.
   *
   * Two claims, and the second is what stops the first being vacuous. `resolveReviewSource`
   * must be REACHED from the shared route module — if it is not, the guard below is walking
   * a graph that no longer contains the thing it is guarding. And nothing on that graph may
   * reach `vite`, because the standalone host imports `routes/collab` and never loads Vite:
   * a `vite` edge anywhere under it is a review that only one of the two hosts can build.
   */
  it('decides where a review reads from inside the shared route layer, reachable from neither host’s own code (R-W5.7)', () => {
    const reached = reachedFrom('core/vite/routes/collab.ts');
    expect(reached).toEqual(
      expect.arrayContaining([
        'core/collaboration/review-source.ts',
        'core/collaboration/review-source-resolve.ts',
        'core/collaboration/review-source-api.ts',
        'core/collaboration/review-source-worktree.ts',
      ]),
    );
    expect(viteReachableFrom('core/collaboration/review-source-resolve.ts').join('\n')).toBe('');
  });

  /*
   * The negative control. Without it this test passes just as happily when the traversal
   * is broken as when the directory is clean. `visual-spec-plugin.ts` is one level up and
   * is Vite-by-definition — the walker must find `vite` there.
   */
  it('reports a `vite` import when one genuinely exists', () => {
    expect(viteReachableFrom('core/vite/visual-spec-plugin.ts').join('\n')).toMatch(/→ vite$/m);
  });
});
