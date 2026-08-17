/**
 * checkout-on-real-git.test.ts — R-W6.8: the suites that drive the checkout source drive
 * it against real git repositories, and are kept that way.
 *
 * WHY A GUARD AND NOT JUST THE PRACTICE. It already IS the practice — every suite named
 * below builds temporary repositories with `git init` today, and each says in its own
 * header why. The reason to assert it anyway is that story 1.2 moved the checkout
 * behaviour behind an interface, and an interface is exactly what makes a fixture look
 * reasonable: once reads go through `ReviewSource`, a hand-built `.git` and an injected
 * `GitExecutor` become the obvious way to make a slow suite fast, and the suite keeps
 * passing while it stops testing git. This package has already paid for that once — the
 * hand-written `.git` parser `core/git-context.ts` replaced was replaced *because* a
 * fixture encoded the same misunderstandings the parser did, so the fixture agreed with
 * the bug. `mountPullRequest`'s own comment records a second instance: `worktree list`
 * reports `/private/var/...` for a `/var/...` path on macOS, which was "caught against a
 * real repository under `/tmp`; a fixture would never have shown it."
 *
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT. Three things per suite: it spawns the
 * real `git` binary, it really creates repositories with it, and it fabricates no `.git`
 * of its own. What is NOT asserted is "uses no injected executor at all" — that would fail
 * `worktree.test.ts`, correctly and unhelpfully. Provoking `fetch-failed` for real means
 * unplugging the network, so the failure arms of that suite stub the executor on purpose
 * while its success arms run against real repositories. The requirement is that the
 * checkout is *driven against real git*, not that no double exists anywhere in the file.
 *
 * THE REGISTRY IS GUARDED TOO. A list of filenames rots the moment somebody adds a suite
 * and does not think of this one, so it is not trusted: every `*.test.ts` in the package
 * that imports a checkout module is required to appear in the registry. A new suite is
 * then a failure here with its own path in the message, which is a decision someone has to
 * make rather than one they can miss.
 *
 * This is a source-reading test, in the shape `core/bundle-guard.test.ts` established for
 * exactly this class of claim: cheap, static, and failing at the moment the practice
 * changes rather than at the moment the practice costs something.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The suites that drive the checkout against a repository, and therefore owe R-W6.8 a real
 * one. Named rather than discovered, so the list reads as the claim it is; kept honest by
 * the staleness check at the bottom.
 */
const CHECKOUT_SUITES = [
  // The mount itself: fetch, `worktree add --detach`, the ref namespace, the removal.
  'core/collaboration/worktree.test.ts',
  // The `ReviewSource` reading out of a mounted checkout — story 1.2's extraction.
  'core/collaboration/review-source-worktree.test.ts',
  // The decision that puts a review on the checkout at all (R-W6.2 / R-W6.3).
  'core/collaboration/review-source-resolve.test.ts',
  // Both sources answering alike, with the checkout side backed by a real worktree.
  'core/collaboration/review-source-parity.test.ts',
  // A full review through the routes, asserting the served repository is undisturbed.
  'core/vite/routes/review-leaves-served-dir-alone.test.ts',
];

/**
 * The functions whose behaviour IS git's. A test importing one of these is driving a
 * checkout, whatever it calls itself, and so belongs in the registry above.
 *
 * Symbols rather than module names, and that distinction is load-bearing: three suites
 * import `IGNORE_ENTRY` and `WORKTREE_DIR` from `./collaboration/worktree` to agree with
 * this package about a string. Importing a constant from a module is not driving it, and a
 * module-level rule would drag every one of them in here to be told it must spawn git.
 */
const CHECKOUT_ENTRYPOINTS = [
  'mountPullRequest',
  'unmountPullRequest',
  'listMountedWorktrees',
  'createWorktreeReviewSource',
  'resolveReviewSource',
];

/** Directories with nothing of ours in them. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'template', 'assets']);

/** Every `*.test.ts` in the package, as a package-relative posix path. */
function testFiles(): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const child = join(abs, name);
      if (statSync(child).isDirectory()) visit(child);
      else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) {
        out.push(relative(pkgRoot, child).split('\\').join('/'));
      }
    }
  };
  visit(pkgRoot);
  return out.sort();
}

/**
 * Source with comments stripped.
 *
 * Every predicate below is a claim about code. Prose that merely mentions `git init` — and
 * these files are full of prose that does, because each explains at length why it uses a
 * real repository — must not be able to satisfy one.
 */
function code(rel: string): string {
  return readFileSync(join(pkgRoot, rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

/* ------------------------------------------------------------------ *
 * The three predicates
 * ------------------------------------------------------------------ */

/** Does this source run the real `git` binary, rather than only a `GitExecutor` double? */
function spawnsRealGit(text: string): boolean {
  const spawns = /from 'node:child_process'/.test(text);
  // The binary by name, as the first argument to whichever spawn wrapper is in use.
  const namesGit = /\b(execFile|execFileSync|spawn|spawnSync|exec|run)\w*\(\s*'git'/.test(text);
  return spawns && namesGit;
}

/**
 * Does it really create a repository?
 *
 * `git init` is the one command that cannot be faked into existence by a helper: a suite
 * that spawns git only to read something is not building the subject, it is inspecting
 * somebody else's. Matched as an `'init'` argument rather than as the string "git init",
 * because every call site in this package goes through an argument array.
 */
function initialisesRepositories(text: string): boolean {
  return /['"]init['"]\s*,/.test(text) || /,\s*['"]init['"]/.test(text);
}

/**
 * Every place the source fabricates part of a `.git` itself, or `[]`.
 *
 * This is the regression R-W6.8 exists to prevent, and it has a recognisable shape: a
 * filesystem WRITE whose path names `.git`. Reads are untouched — `stat(join(abs, '.git'))`
 * is how a submodule is detected and how a linked worktree is told from a clone, and both
 * suites legitimately do it. Returned as a list rather than a boolean so a failure names
 * the offending line instead of the file.
 */
const FS_WRITES = 'mkdir|mkdtemp|writeFile|appendFile|copyFile|cp|rename|symlink|link|open';
function fabricatedGitDirs(text: string): string[] {
  const re = new RegExp(`\\b(?:${FS_WRITES})(?:Sync)?\\s*\\([^)]*['"\`][^'"\`]*\\.git\\b`, 'g');
  return text.match(re) ?? [];
}

/* ================================================================== *
 * R-W6.8 — every checkout suite drives real git
 * ================================================================== */
describe('R-W6.8 — the checkout suites run against real git repositories', () => {
  it.each(CHECKOUT_SUITES)('%s spawns the real git binary', (rel) => {
    expect(spawnsRealGit(code(rel))).toBe(true);
  });

  it.each(CHECKOUT_SUITES)('%s creates its repositories with git init', (rel) => {
    expect(initialisesRepositories(code(rel))).toBe(true);
  });

  it.each(CHECKOUT_SUITES)('%s hand-builds no .git of its own', (rel) => {
    expect(fabricatedGitDirs(code(rel))).toEqual([]);
  });

  /*
   * The negative controls. Every predicate above passes vacuously on the wrong input —
   * `spawnsRealGit` on a file that mentions git in a comment, `fabricatedGitDirs` on one
   * that never writes anything — so each is shown here to answer differently for the
   * regression it is meant to catch. Without these, a typo in a regex would turn this
   * whole file into three green checks that assert nothing, which is the exact failure
   * mode a guard is worst at reporting.
   */
  it('reports a suite that replaced real repositories with a hand-built .git', () => {
    const swapped = `
      import { mkdir, writeFile } from 'node:fs/promises';
      const dir = await mkdtemp('/tmp/x');
      await mkdir(join(dir, '.git/refs/heads'), { recursive: true });
      await writeFile(join(dir, '.git/HEAD'), 'ref: refs/heads/main\\n');
      const exec: GitExecutor = async () => ({ stdout: 'abc\\n', exitCode: 0 });
    `;
    expect(spawnsRealGit(swapped)).toBe(false);
    expect(initialisesRepositories(swapped)).toBe(false);
    expect(fabricatedGitDirs(swapped).length).toBeGreaterThan(0);
  });

  it('does not mistake reading a .git for fabricating one', () => {
    // What the two suites actually do, and must keep being allowed to do: `.git` is a
    // directory in a clone and a file in a linked worktree, and telling them apart is a
    // read.
    const reading = `
      await stat(resolve(abs, '.git'));
      if (dirent.name === '.git') continue;
    `;
    expect(fabricatedGitDirs(reading)).toEqual([]);
  });

  it('accepts a suite that stubs the executor for its failure arms only', () => {
    // `worktree.test.ts`'s shape: real repositories for the success paths, a stub for the
    // failures that would otherwise need the network unplugged. The predicates must not
    // punish it, or the guard's only fix is to delete the failure coverage.
    const mixed = `
      import { execFile } from 'node:child_process';
      const exec = promisify(execFile);
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      const stub: GitExecutor = async () => ({ stdout: '', exitCode: 1 });
    `;
    expect(spawnsRealGit(mixed)).toBe(true);
    expect(initialisesRepositories(mixed)).toBe(true);
    expect(fabricatedGitDirs(mixed)).toEqual([]);
  });
});

/* ================================================================== *
 * The registry cannot go stale
 * ================================================================== */
describe('R-W6.8 — every suite that drives a checkout module is registered', () => {
  /**
   * The named bindings this source imports, from every `import { … } from '…'` in it.
   *
   * `import type { … }` is included rather than filtered: a suite that imports only the
   * type of a checkout function is not driving it, but it also cannot then be importing
   * the function, so it never matches an entrypoint name and the distinction costs
   * nothing to leave in.
   */
  function importedBindings(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+'[^']+'/g)) {
      for (const part of m[1]!.split(',')) {
        // `a as b` binds `b` locally but names `a` at the source, which is the one that
        // identifies the function.
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
        if (name) out.push(name);
      }
    }
    return out;
  }

  it('names no suite that does not exist', () => {
    // The other direction of staleness: a renamed or deleted suite silently reduces the
    // guard to whatever is left, and `it.each` over a missing file would fail with a
    // filesystem error rather than with the reason.
    const all = new Set(testFiles());
    expect(CHECKOUT_SUITES.filter((rel) => !all.has(rel))).toEqual([]);
  });

  it('recognises every registered suite as one that drives a checkout', () => {
    /*
     * The detector's own negative control. A binding scanner that matched nothing would
     * report an empty list of unregistered suites below and look like a pass — so it is
     * first required to *find* the five suites everyone agrees are checkout suites.
     */
    for (const rel of CHECKOUT_SUITES) {
      const bindings = importedBindings(code(rel));
      expect(bindings.filter((n) => CHECKOUT_ENTRYPOINTS.includes(n)), rel).not.toEqual([]);
    }
  });

  it('leaves no checkout suite out of the registry', () => {
    const registered = new Set(CHECKOUT_SUITES);
    const unregistered: string[] = [];
    for (const rel of testFiles()) {
      if (registered.has(rel)) continue;
      const bindings = importedBindings(code(rel));
      if (bindings.some((name) => CHECKOUT_ENTRYPOINTS.includes(name))) unregistered.push(rel);
    }
    /*
     * A file landing here is not necessarily wrong — it may drive the module entirely
     * through an injected executor, which is a legitimate thing to test. It is being asked
     * to say so by joining the registry (and then satisfying the three predicates) or by
     * being argued out of it in a review. What it may not do is decide silently.
     */
    expect(unregistered.join('\n')).toBe('');
  });
});
