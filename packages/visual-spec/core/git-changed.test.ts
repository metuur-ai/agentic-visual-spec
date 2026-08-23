/**
 * git-changed.test.ts — R-8.36, against real repositories.
 *
 * The claim under test is one nothing but a real `git` can settle: `status --porcelain`
 * reports paths relative to the REPOSITORY ROOT even when invoked with `-C` inside a
 * subdirectory. A fake executor would only reproduce whoever wrote it believing that,
 * and believing the opposite is exactly how the pull request picker would end up
 * offering `docs/rules.md` for a file whose served path is `rules.md`.
 *
 * The process-failure case goes through the injected seam: there is no portable way to
 * uninstall `git` from inside a test.
 *
 * WHY THE REPOSITORIES ARE NOT IN `tmpdir()`. `core/collaboration/review-source-api.test.ts`
 * proves R-W2.9 — "a review writes no file anywhere" — by listing `cwd`, `tmpdir()` and
 * the home directory before and after a run and requiring the two listings to match. A
 * suite running in parallel that creates a directory in `tmpdir()` fails that test from
 * the outside, for something it never did. So these repositories live under this
 * package's `node_modules`, which is watched at no level.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitExecutor } from './git-context';
import { readChangedPaths } from './git-changed';

vi.setConfig({ testTimeout: 20_000 });

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** Unwatched scratch space — see the header. */
const SCRATCH = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.vs-git-changed-tests');

let root = '';

beforeAll(async () => {
  await mkdir(SCRATCH, { recursive: true });
  root = await mkdtemp(join(SCRATCH, 'repo-'));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Visual Spec Test');
  await mkdir(join(root, 'packages', 'docs'), { recursive: true });
  await mkdir(join(root, 'packages', 'api'), { recursive: true });
  await writeFile(join(root, 'packages', 'docs', 'rules.md'), '# Rules\n');
  await writeFile(join(root, 'packages', 'api', 'app.ts'), 'export {};\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'first');

  // The working tree the reads below observe: one edit per package, plus an untracked
  // file — which is work in progress just as much as a modification is.
  await writeFile(join(root, 'packages', 'docs', 'rules.md'), '# Rules\n\nedited\n');
  await writeFile(join(root, 'packages', 'api', 'app.ts'), 'export const x = 1;\n');
  await writeFile(join(root, 'packages', 'docs', 'new note.md'), 'untracked\n');
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

describe('readChangedPaths', () => {
  it('serves repository-root-relative paths when the served directory is the root', async () => {
    const res = await readChangedPaths(root);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.paths].sort()).toEqual([
      'packages/api/app.ts',
      'packages/docs/new note.md',
      'packages/docs/rules.md',
    ]);
  });

  it('rebases onto the served subdirectory and drops what is outside it', async () => {
    const res = await readChangedPaths(join(root, 'packages', 'docs'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // `packages/api/app.ts` is not under the served directory, so it is not offered:
    // the file route would refuse it and the tree cannot show it.
    expect([...res.paths].sort()).toEqual(['new note.md', 'rules.md']);
  });

  it('reports the failure rather than throwing where git cannot be run', async () => {
    const enoent: GitExecutor = async () => ({ stdout: '', exitCode: null });

    expect(await readChangedPaths(root, enoent)).toEqual({ ok: false, reason: 'git-unavailable' });
  });

  /*
   * "Not a repository" reaches this module as a non-zero exit and nothing else — stderr
   * is never read (R-5.10) — so it is indistinguishable from any other git failure and
   * is driven through the seam rather than from a real directory. A real one would have
   * to sit outside every repository to be one, which no directory this suite can create
   * inside the checkout is.
   */
  it('reports a non-zero exit as a git failure', async () => {
    const refuses: GitExecutor = async () => ({ stdout: '', exitCode: 128 });

    expect(await readChangedPaths(root, refuses)).toEqual({ ok: false, reason: 'git-failed' });
  });

  /*
   * The second read can fail on its own: `status` succeeds, `rev-parse --show-prefix`
   * does not. Reporting paths anyway would serve repository-root-relative paths as if
   * they were served-directory-relative — the exact confusion this module exists to
   * prevent — so the whole answer fails.
   */
  it('fails rather than serving unrebased paths when the prefix cannot be read', async () => {
    const halfway: GitExecutor = async (args) =>
      args.slice(2).join(' ') === 'status --porcelain -z' ? { stdout: ' M rules.md\0', exitCode: 0 } : { stdout: '', exitCode: 128 };

    expect(await readChangedPaths(root, halfway)).toEqual({ ok: false, reason: 'git-failed' });
  });
});
