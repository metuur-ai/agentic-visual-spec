/**
 * git-branches.test.ts — Unit 5 of `docs/ears/git-context-in-header.md`.
 *
 * Real temporary repositories, for the same reason `core/git-context.test.ts` uses
 * them: every claim in this module is a claim about what `git` actually does, and a
 * fake `GitExecutor` can only ever reproduce what its author already believed. The
 * load-bearing test in this file — a modified file that is byte-identical on both
 * branches — exists precisely because the belief was wrong, and only a real
 * `git checkout` demonstrates that.
 *
 * The two process-failure cases go through the injected seam instead: there is no
 * portable way to uninstall `git` from inside a test.
 */
import { execFile } from 'node:child_process';
import { access, chmod, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultExecGit, type GitExecutor } from './git-context';
import { checkoutBranch, listBranches, readDirtyPaths } from './git-branches';
import { IGNORE_ENTRY } from './collaboration/worktree';

/**
 * Raised for this file only; the suite default stays 5s.
 *
 * These are integration tests over real repositories, so a single case can spend an
 * `init`, several commits, a bare remote, a push and a fetch in subprocesses. That
 * sits close enough to the 5s default that it passes when the file runs alone and
 * times out when the worker pool is busy — a failure that reports as the assertion's
 * and is actually the scheduler's. Measured at 5009ms against a 5000ms limit.
 */
vi.setConfig({ testTimeout: 20_000 });

const exec = promisify(execFile);

/** Run a real git command in `cwd`. Rejects on failure — setup must not fail silently. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** `git init` with the branch, identity and first commit pinned — see git-context.test.ts. */
async function initRepo(dir: string, branch = 'main'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', branch);
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'user.name', 'Visual Spec Test');
  await writeFile(join(dir, 'file.txt'), 'one\n');
  await git(dir, 'add', 'file.txt');
  await git(dir, 'commit', '-q', '-m', 'first');
}

/**
 * `defaultExecGit`, with every argument vector kept. Used where the assertion is
 * about the commands issued rather than about their result — R-5.6 is a claim about
 * what was never invoked, which nothing observable after the fact can establish.
 */
function recording(): { exec: GitExecutor; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (args) => {
      calls.push(args);
      return defaultExecGit(args);
    },
  };
}

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'vs-branches-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/* ================================================================== *
 * 5.1 — listing
 * ================================================================== */
describe('listBranches', () => {
  it('reports every local branch and which one is current (R-5.1, R-5.2)', async () => {
    const repo = join(base, 'several');
    await initRepo(repo);
    await git(repo, 'branch', 'feature/one');
    await git(repo, 'branch', 'release-2');

    const result = await listBranches(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.local).toEqual([
      { name: 'feature/one', current: false },
      { name: 'main', current: true },
      { name: 'release-2', current: false },
    ]);
  });

  it('reports ahead and behind only where an upstream exists (R-5.2)', async () => {
    // Absent is a different claim from zero: "no upstream to compare against" and
    // "level with the upstream" are the two things a bare `0` would conflate.
    const remote = join(base, 'ahead-behind-origin.git');
    await git(base, 'init', '-q', '--bare', remote);
    const repo = join(base, 'ahead-behind');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', remote);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');
    await git(repo, 'branch', 'no-upstream');
    await writeFile(join(repo, 'file.txt'), 'two\n');
    await git(repo, 'commit', '-q', '-am', 'ahead by one');

    const result = await listBranches(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.listing.local.map((b) => [b.name, b]));
    expect(byName.main).toEqual({ name: 'main', current: true, ahead: 1, behind: 0 });
    expect(byName['no-upstream']).toEqual({ name: 'no-upstream', current: false });
    expect('ahead' in byName['no-upstream']!).toBe(false);
    expect('behind' in byName['no-upstream']!).toBe(false);
  });

  it('reports the branches of origin without the remote prefix (R-5.1)', async () => {
    const remote = join(base, 'origin-branches-origin.git');
    await git(base, 'init', '-q', '--bare', remote);
    const repo = join(base, 'origin-branches');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', remote);
    await git(repo, 'push', '-q', 'origin', 'main');
    await git(repo, 'push', '-q', 'origin', 'main:published');
    await git(repo, 'fetch', '-q', 'origin');

    const result = await listBranches(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.remote).toEqual(['main', 'published']);
    // `origin/HEAD` is a symbolic ref to another entry in this very list, not a
    // branch anybody can check out by that name.
    expect(result.listing.remote).not.toContain('HEAD');
  });

  it('reports no current branch on a detached HEAD (R-5.2)', async () => {
    const repo = join(base, 'listing-detached');
    await initRepo(repo);
    await git(repo, 'branch', 'other');
    await git(repo, 'checkout', '-q', '--detach');

    const result = await listBranches(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listing.local.map((b) => b.name)).toEqual(['main', 'other']);
    expect(result.listing.local.every((b) => !b.current)).toBe(true);
  });

  it('reports the failure for a directory that is not a repository (R-5.11)', async () => {
    const plain = join(base, 'listing-not-a-repo');
    await mkdir(plain, { recursive: true });

    await expect(listBranches(plain)).resolves.toEqual({ ok: false, reason: 'git-failed' });
  });

  it('resolves rather than rejects when git cannot be started (R-5.11)', async () => {
    const enoent: GitExecutor = async () => ({ stdout: '', exitCode: null });

    await expect(listBranches('/anywhere', enoent)).resolves.toEqual({
      ok: false,
      reason: 'git-unavailable',
    });
  });
});

/* ================================================================== *
 * 5.1 — R-5.3, the separation itself
 * ================================================================== */
describe('R-5.3 — the branch-writing module is separate and git-context still only reads', () => {
  const contextSource = () => readFile(new URL('./git-context.ts', import.meta.url), 'utf8');

  it('core/git-context.ts invokes no git command that writes (R-1.10)', async () => {
    const text = (await contextSource()).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const verb of ['checkout', 'switch', 'stash', 'commit', 'push', 'fetch', 'reset', 'branch']) {
      expect(text).not.toContain(`'${verb}'`);
    }
  });

  it('core/git-context.ts does not reach into the branch module', async () => {
    // The separation is only worth anything in one direction: the reader must not
    // acquire the writer. The writer importing the reader is the intended shape.
    expect(await contextSource()).not.toContain('git-branches');
  });
});

/* ================================================================== *
 * 5.2 — the dirty check
 * ================================================================== */
describe('readDirtyPaths', () => {
  it('reports a clean tree as no paths at all (R-5.4)', async () => {
    const repo = join(base, 'clean');
    await initRepo(repo);

    await expect(readDirtyPaths(repo)).resolves.toEqual({ ok: true, paths: [] });
  });

  it('reports modified, staged, untracked and renamed paths, repository-relative (R-5.4, R-5.10)', async () => {
    const repo = join(base, 'dirty');
    await initRepo(repo);
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'moved.md'), '# moved\n');
    await writeFile(join(repo, 'docs', 'staged.md'), '# staged\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'second');

    await writeFile(join(repo, 'file.txt'), 'modified\n');
    await writeFile(join(repo, 'docs', 'staged.md'), '# staged, changed\n');
    await git(repo, 'add', join('docs', 'staged.md'));
    await writeFile(join(repo, 'docs', 'untracked.md'), '# untracked\n');
    await git(repo, 'mv', join('docs', 'moved.md'), join('docs', 'renamed.md'));

    const result = await readDirtyPaths(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths).toEqual(
      expect.arrayContaining([
        'file.txt',
        'docs/staged.md',
        'docs/untracked.md',
        'docs/renamed.md',
        'docs/moved.md',
      ]),
    );
    // R-5.10. `repo` is under the OS temp directory, which on macOS git reports in
    // its resolved `/private/...` form — so both spellings are excluded.
    for (const path of result.paths) {
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toContain(base);
    }
  });

  it('reports paths relative to the repository when served from a subdirectory (R-5.4)', async () => {
    const repo = join(base, 'nested-status');
    await initRepo(repo);
    const deep = join(repo, 'docs', 'deep');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'kept.md'), '# kept\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'a served subdirectory');
    await writeFile(join(repo, 'file.txt'), 'modified\n');
    await writeFile(join(deep, 'note.md'), '# note\n');

    const result = await readDirtyPaths(deep);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not `../../file.txt`, and not `note.md` — the served directory is not the
    // frame of reference, the repository is.
    expect(result.paths.sort()).toEqual(['docs/deep/note.md', 'file.txt']);
  });

  it("reports a wholly untracked directory as git collapses it, not file by file (R-5.4)", async () => {
    // `--untracked-files=all` is deliberately not passed. An untracked `node_modules`
    // would put tens of thousands of paths into a refusal whose only job is to say
    // "there is uncommitted work here" — and the collapsed entry says that.
    const repo = join(base, 'collapsed');
    await initRepo(repo);
    await mkdir(join(repo, 'scratch', 'deep'), { recursive: true });
    await writeFile(join(repo, 'scratch', 'deep', 'a.md'), '# a\n');
    await writeFile(join(repo, 'scratch', 'deep', 'b.md'), '# b\n');

    await expect(readDirtyPaths(repo)).resolves.toEqual({ ok: true, paths: ['scratch/'] });
  });

  it('reports a path containing a space without git quoting it (R-5.4)', async () => {
    // `--porcelain` without `-z` wraps such a path in double quotes and escapes it.
    // A refusal that names `"my notes.md"` is naming a file that does not exist.
    const repo = join(base, 'spaced');
    await initRepo(repo);
    await writeFile(join(repo, 'my notes.md'), '# notes\n');

    await expect(readDirtyPaths(repo)).resolves.toEqual({ ok: true, paths: ['my notes.md'] });
  });

  it('reports the failure rather than throwing when git cannot run (R-5.11)', async () => {
    const enoent: GitExecutor = async () => ({ stdout: '', exitCode: null });

    await expect(readDirtyPaths('/anywhere', enoent)).resolves.toEqual({
      ok: false,
      reason: 'git-unavailable',
    });
  });
});

/* ================================================================== *
 * 5.3 — the refusal
 * ================================================================== */
describe('checkoutBranch', () => {
  /**
   * THE REGRESSION TEST. An earlier draft invoked `checkout` and mapped git's
   * refusal. This is the case that draft got wrong: `shared.md` is byte-identical on
   * both branches, so `git checkout` succeeds and carries the uncommitted edit onto
   * the new branch while reporting success. In a repository of documents that is the
   * ordinary case, not the exotic one.
   */
  it('refuses when a modified file is byte-identical on both branches (R-5.5)', async () => {
    const repo = join(base, 'identical-file');
    await initRepo(repo);
    await writeFile(join(repo, 'shared.md'), '# shared\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'shared');
    await git(repo, 'checkout', '-q', '-b', 'feature');
    await writeFile(join(repo, 'only-on-feature.md'), '# feature\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'feature only');
    // `shared.md` is unchanged between `main` and `feature`, so git would allow this.
    await writeFile(join(repo, 'shared.md'), '# shared, edited but not saved\n');

    const { exec: record, calls } = recording();
    const result = await checkoutBranch(repo, 'main', record);

    expect(result).toEqual({ ok: false, reason: 'dirty', paths: ['shared.md'] });
    // The half that would still pass if the refusal came from git: HEAD did not move.
    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(await readFile(join(repo, 'shared.md'), 'utf8')).toBe('# shared, edited but not saved\n');
    expect(calls.some((args) => args.includes('checkout'))).toBe(false);
  });

  it('refuses on an untracked file, and neither stashes, discards nor forces (R-5.5, R-5.6)', async () => {
    const repo = join(base, 'untracked-refusal');
    await initRepo(repo);
    await git(repo, 'branch', 'other');
    await writeFile(join(repo, 'draft.md'), '# draft\n');

    const { exec: record, calls } = recording();
    const result = await checkoutBranch(repo, 'other', record);

    expect(result).toEqual({ ok: false, reason: 'dirty', paths: ['draft.md'] });
    const flat = calls.map((args) => args.join(' ')).join('\n');
    expect(flat).not.toMatch(/\bstash\b|--force\b|--hard\b|\bclean\b|\bcheckout\b/);
  });

  const REJECTED = ['-', '--upload-pack=/usr/bin/evil', 'origin/main', 'does-not-exist', ''];

  for (const name of REJECTED) {
    it(`rejects ${name || '(empty)'} before any checkout (R-5.7)`, async () => {
      const repo = join(base, `validation-${REJECTED.indexOf(name)}`);
      await initRepo(repo);

      const { exec: record, calls } = recording();
      const result = await checkoutBranch(repo, name, record);

      expect(result).toEqual({ ok: false, reason: 'unknown-branch' });
      expect(calls.some((args) => args.includes('checkout'))).toBe(false);
      expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    });
  }

  it('changes to an existing local branch from a clean tree and returns the fresh context (R-5.9)', async () => {
    const repo = join(base, 'clean-switch');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    await git(repo, 'branch', 'develop');

    const result = await checkoutBranch(repo, 'develop');

    expect(result).toEqual({
      ok: true,
      context: {
        state: 'remote',
        branch: 'develop',
        detached: false,
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        url: 'https://github.com/acme/widgets.git',
      },
    });
    // R-5.9 again, against the repository rather than against the response: the
    // context is read after the change, so the two cannot disagree.
    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
  });

  it('creates a tracking branch for a branch that exists only on origin (R-5.7)', async () => {
    const remote = join(base, 'tracking-origin.git');
    await git(base, 'init', '-q', '--bare', remote);
    const seed = join(base, 'tracking-seed');
    await initRepo(seed);
    await git(seed, 'remote', 'add', 'origin', remote);
    await git(seed, 'push', '-q', 'origin', 'main');
    await git(seed, 'push', '-q', 'origin', 'main:published');

    const repo = join(base, 'tracking');
    await git(base, 'clone', '-q', remote, repo);
    await git(repo, 'config', 'user.email', 'test@example.invalid');
    await git(repo, 'config', 'user.name', 'Visual Spec Test');

    const result = await checkoutBranch(repo, 'published');

    expect(result).toMatchObject({ ok: true, context: { branch: 'published', detached: false } });
    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('published');
    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'published@{upstream}')).toBe('origin/published');
  });

  it('ensures the collaboration ignore entry before reporting success (R-5.8)', async () => {
    // `.gitignore` is tracked, so a branch predating the entry un-ignores
    // `.visual-spec/` and every mounted worktree becomes untracked noise.
    const repo = join(base, 'ignore-entry');
    await initRepo(repo);
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'gitignore without the entry');
    await git(repo, 'checkout', '-q', '-b', 'older');
    await git(repo, 'checkout', '-q', 'main');
    await writeFile(join(repo, '.gitignore'), `node_modules/\n${IGNORE_ENTRY}\n`);
    await git(repo, 'commit', '-q', '-am', 'add the entry on main');
    await mkdir(join(repo, '.visual-spec', 'worktrees'), { recursive: true });
    await writeFile(join(repo, '.visual-spec', 'worktrees', 'note'), 'x\n');

    const result = await checkoutBranch(repo, 'older');

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toContain(IGNORE_ENTRY);
    expect(await git(repo, 'status', '--porcelain')).not.toContain('.visual-spec');
  });

  it('reports a branch that changed but could not be ignored, without throwing and without a path (R-5.8, R-5.10)', async () => {
    // `ensureIgnored` rethrows any read error that is not ENOENT and can fail on the
    // write for reasons that have nothing to do with git — a read-only checkout, a
    // read-only volume. Node puts the absolute path into that error, this module's
    // caller catches nothing on purpose, and the host answers 500 with `err.message`,
    // so an uncaught throw here would put the served directory on the wire.
    const repo = join(base, 'ignore-unwritable');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'gitignore without the entry');
    // Identical on both branches, so `checkout` never rewrites the read-only file and
    // the only write refused is the one this test is about.
    await git(repo, 'branch', 'older');
    await chmod(join(repo, '.gitignore'), 0o444);
    // A process that writes through mode bits (root) cannot produce the failure, so
    // the precondition is asserted rather than assumed.
    let readOnlyHolds = true;
    try {
      await access(join(repo, '.gitignore'), constants.W_OK);
      readOnlyHolds = false;
    } catch {
      readOnlyHolds = true;
    }
    expect(readOnlyHolds).toBe(true);

    const result = await checkoutBranch(repo, 'older');

    // The repository moved, so this is not reported as a checkout that failed: the
    // caller gets the context it moved to, and the one thing that did not happen.
    expect(result).toEqual({
      ok: false,
      reason: 'ignore-failed',
      context: {
        state: 'remote',
        branch: 'older',
        detached: false,
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        url: 'https://github.com/acme/widgets.git',
      },
    });
    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('older');
    // Nothing of the filesystem's or git's error text survives into the value.
    expect(JSON.stringify(result)).not.toContain(repo);
    expect(JSON.stringify(result)).not.toMatch(/EACCES|permission denied/i);
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).not.toContain(IGNORE_ENTRY);
    await chmod(join(repo, '.gitignore'), 0o644);
  });

  it('reports the failure rather than throwing when git cannot run (R-5.11)', async () => {
    const enoent: GitExecutor = async () => ({ stdout: '', exitCode: null });

    await expect(checkoutBranch('/anywhere', 'main', enoent)).resolves.toEqual({
      ok: false,
      reason: 'git-unavailable',
    });
  });
});
