/**
 * reachability.test.ts — task U-1's standing guard.
 *
 * WHY THIS EXISTS. Four finished, fully-tested collaboration modules — `collab-editor`,
 * `collab-comment-source`, `cache-lifecycle` and `createRecoveryBodies` — sat in the tree
 * for weeks with a green suite and zero non-test callers. Nothing imported them from the
 * running app, so nothing they did reached a user. The suite could not see it: a module
 * with its own passing tests looks exactly like a module that ships.
 *
 * "Is it tested" and "is it reachable" are different questions, and only the first one was
 * being asked. This asks the second: every browser-side collaboration module must be
 * reachable, through the static import graph, from the app's real entry point.
 *
 * WHAT IT WILL AND WILL NOT CATCH. It is a *wiring* check, not a behaviour check. A module
 * that is imported and then never rendered still passes here — reachability is the floor,
 * not the ceiling. What it does catch is the specific, silent, repeated failure above:
 * building the thing and forgetting to plug it in.
 *
 * The list is derived from disk, not hand-written, so a `ui/collab-*.tsx` module added by
 * a later task is covered the moment it lands rather than when someone remembers to add
 * it here. That is the property that would have caught all four originals.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkImportGraph } from '../core/import-graph';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one route into the browser app. If this is wrong, every assertion below is vacuous. */
const APP_ENTRY = 'ui/App.tsx';

/**
 * Modules that must be reachable from `APP_ENTRY`. Prefix-matched against `ui/` rather
 * than listed, for the reason in the header. `.ts` and `.tsx` both count: the collaboration
 * UI is a mix of components and the plain-module helpers they are built from, and an
 * orphaned helper is as dead as an orphaned component.
 */
const COLLAB_UI = /^collab-[\w-]+\.tsx?$/;

/** Test files are not the app; a module reachable only from its own test is the bug. */
const IS_TEST = /\.test\.tsx?$/;

/**
 * Modules that are unreachable **on purpose**, each with the decision that made them so.
 *
 * This list is the point of the guard, not a hole in it. An orphan is only a defect when
 * nobody chose it; the failure this test exists to prevent is the *silent* one. Adding an
 * entry here costs a line of justification and shows up in review — which is exactly the
 * conversation that never happened for the four originals.
 *
 * Every entry must name the decision, not merely restate the fact.
 */
const DELIBERATELY_UNMOUNTED: Record<string, string> = {};

function collabUiModules(): string[] {
  return readdirSync(resolve(pkgRoot, 'ui'))
    .filter((entry) => COLLAB_UI.test(entry) && !IS_TEST.test(entry))
    .map((entry) => `ui/${entry}`)
    .sort();
}

/** Every module the app entry statically reaches, package-relative. */
function reachableFromApp(): Set<string> {
  const reached = new Set<string>();
  walkImportGraph(pkgRoot, APP_ENTRY, ({ file }) => reached.add(relative(pkgRoot, file)));
  return reached;
}

describe('the collaboration UI is reachable from the app (task U-1)', () => {
  const modules = collabUiModules();

  it('finds the collaboration UI modules on disk (guards against a vacuous pass)', () => {
    // If a rename empties this list, every test below would pass by having nothing to check.
    expect(modules.length).toBeGreaterThanOrEqual(7);
    expect(modules).toContain('ui/collab-editor.tsx');
    expect(modules).toContain('ui/collab-comment-source.ts');
  });

  const expected = modules.filter((module) => !(module in DELIBERATELY_UNMOUNTED));

  it.each(expected)('%s is imported, directly or transitively, from ui/App.tsx', (module) => {
    expect([...reachableFromApp()].sort()).toContain(module);
  });

  // The list is empty today — every collaboration module is mounted. `it.each([])` is an
  // error in vitest, so the exception suite reports itself as skipped rather than vanishing
  // silently; the moment an entry is added it runs.
  const unmounted = Object.keys(DELIBERATELY_UNMOUNTED);
  const eachUnmounted = unmounted.length
    ? it.each(unmounted)
    : it.skip.each(['(no recorded exceptions)']);

  eachUnmounted(
    '%s is unreachable, and that is a recorded decision — not an oversight',
    (module) => {
      // Asserted in both directions. If someone wires it up, this fails and the entry
      // above must be deleted; the exception cannot outlive the reason for it.
      expect(modules).toContain(module);
      expect(reachableFromApp().has(module)).toBe(false);
      expect(DELIBERATELY_UNMOUNTED[module].length).toBeGreaterThan(80);
    },
  );

  it('reports absence rather than always passing', () => {
    const reached = reachableFromApp();
    // The negative control needs a module that exists on disk and is never imported by
    // the app. A test file is that by construction, so this control cannot rot the way
    // naming a production module does the moment someone mounts it.
    expect(existsSync(resolve(pkgRoot, 'ui/collab-editor.test.tsx'))).toBe(true);
    expect(reached.has('ui/collab-editor.test.tsx')).toBe(false);
    expect(reached.has('ui/collab-document-view.tsx')).toBe(true);
    expect(reached.size).toBeGreaterThan(modules.length);
  });
});
