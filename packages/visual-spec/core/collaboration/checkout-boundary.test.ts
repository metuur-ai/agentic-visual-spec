/**
 * checkout-boundary.test.ts — R-6.9: no collaboration action changes the branch.
 *
 * WHY THIS IS AN IMPORT-GRAPH TEST AND NOT A BEHAVIOURAL ONE. A behavioural test can
 * only assert that the collaboration actions which exist *today* leave `HEAD` where
 * they found it. The requirement is about the ones written tomorrow: the tempting
 * change is a publish that "helpfully" checks out `visual-spec/<documentId>` when it
 * is done, and a suite of per-action assertions would say nothing about it until
 * somebody wrote an assertion for that action too. A boundary that fails at the
 * moment it is crossed needs to be drawn over the graph, in the style of
 * `ui/browser-safety.test.ts`.
 *
 * WHY THE TWO HALVES TOUCH GIT AT ALL, AND STILL DO NOT MEET. Starting a
 * collaboration commits through the GitHub API and mounts pull requests as detached
 * worktrees beside the served directory — deliberately, so a review never disturbs
 * the working copy (`core/collaboration/worktree.ts`). `checkoutBranch` moves that
 * working copy. They are two different relationships with git, and joining them
 * reintroduces exactly the disturbance the worktree design exists to avoid.
 *
 * Note the edge that legitimately runs the other way: `core/git-branches.ts` imports
 * `ensureIgnored` from `worktree.ts` (R-5.8). This guard is directional and says
 * nothing about that.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRelative, specifiersOf } from '../import-graph';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../..');
const GIT_BRANCHES = resolve(pkgRoot, 'core/git-branches.ts');

/** Every `.ts` module under `core/collaboration/`, tests excluded — they are not shipped. */
function collaborationModules(): string[] {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(here, name));
}

/**
 * The modules in `files` that import `core/git-branches.ts`, by any specifier form.
 *
 * `specifiersOf` matches `import type` alongside `import`, and that is wanted here
 * rather than tolerated: `import type { CheckoutResult }` is a collaboration module
 * being written against the checkout contract, which is the boundary being crossed
 * one commit before the value import lands.
 */
function importersOfGitBranches(files: string[]): string[] {
  const offences: string[] = [];
  for (const file of files) {
    const specifiers = specifiersOf(readFileSync(file, 'utf8'));
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      if (resolveRelative(file, specifier) === GIT_BRANCHES) {
        offences.push(`${file.slice(pkgRoot.length + 1)}  imports  ${specifier}`);
      }
    }
  }
  return offences.sort();
}

describe('collaboration cannot change the branch (R-6.9)', () => {
  it('no module under core/collaboration/ imports the checkout function', () => {
    // Joined rather than compared as an array so a failure names the offender.
    expect(importersOfGitBranches(collaborationModules()).join('\n')).toBe('');
  });

  /*
   * The negative control. Without it the assertion above passes just as happily when
   * the scan is broken as when the boundary holds — the failure mode `browser-safety`
   * records having survived a green suite for several commits.
   *
   * `core/vite/routes/git.ts` is the one module that is *supposed* to import
   * `checkoutBranch`: it is the route the user drives it from.
   */
  it('reports an importer rather than always passing', () => {
    const offences = importersOfGitBranches([resolve(pkgRoot, 'core/vite/routes/git.ts')]);
    expect(offences.join('\n')).toMatch(/git-branches/);
  });

  /*
   * And the module being kept out is the one that writes. If `checkoutBranch` ever
   * leaves that file, this fails and someone gets to ask what the guard above is
   * still guarding.
   */
  it('core/git-branches.ts is where the checkout lives', () => {
    expect(readFileSync(GIT_BRANCHES, 'utf8')).toMatch(/export async function checkoutBranch\b/);
  });
});
