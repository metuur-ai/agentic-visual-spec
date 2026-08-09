/**
 * worktree.test.ts — Unit 1 of the PR review spike.
 *
 * The mounting cases run against **real** repositories, for the same reason
 * `git-context.test.ts` does. `refs/pull/<n>/head` is not magic on GitHub's side — it
 * is an ordinary ref in the upstream repository — so a local repo that carries that ref
 * and is cloned over the filesystem exercises the true fetch refspec, the true
 * `worktree add --detach`, and the true `worktree list --porcelain` output. A faked
 * executor here would be a test of the fixture's spelling of git's output, which is
 * exactly the class of bug the real repo catches: the porcelain parser below was
 * written against invented output first and got the `HEAD` line wrong.
 *
 * The refusal cases (no repo, no origin, fetch fails) go through the injected
 * `GitExecutor`, because provoking them for real means unplugging the network.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitExecutor } from '../git-context';
import {
  ensureIgnored,
  fetchSource,
  listMountedWorktrees,
  mountPullRequest,
  unmountPullRequest,
  worktreeRelPath,
} from './worktree';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** A `GitExecutor` that answers a fixed exit code to every call, recording the args. */
function stubExec(answer: (args: string[]) => { stdout?: string; exitCode: number | null }): {
  exec: GitExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  const execFn: GitExecutor = async (args) => {
    calls.push(args);
    const { stdout = '', exitCode } = answer(args);
    return { stdout, exitCode };
  };
  return { exec: execFn, calls };
}

describe('worktree', () => {
  let root: string;
  let upstream: string;
  let base: string;
  let prHead: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vs-worktree-'));
    upstream = join(root, 'upstream');
    base = join(root, 'base');

    // The upstream repository, with a PR's head parked at `refs/pull/1/head` exactly
    // as GitHub serves it. The PR adds a file that `main` does not have, so the
    // mounted tree can be distinguished from the served directory by content alone.
    await mkdir(upstream, { recursive: true });
    await git(upstream, 'init', '-q', '-b', 'main');
    await git(upstream, 'config', 'user.email', 'test@example.invalid');
    await git(upstream, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(upstream, 'README.md'), '# base\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'base');
    await git(upstream, 'checkout', '-q', '-b', 'feature');
    await writeFile(join(upstream, 'spec.md'), '# from the pull request\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'pr commit');
    prHead = await git(upstream, 'rev-parse', 'HEAD');
    await git(upstream, 'update-ref', 'refs/pull/1/head', prHead);
    await git(upstream, 'checkout', '-q', 'main');

    await exec('git', ['clone', '-q', upstream, base], { cwd: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('ensureIgnored', () => {
    it('creates .gitignore when there is none', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vs-ignore-'));
      await ensureIgnored(dir);
      expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('.visual-spec/\n');
      await rm(dir, { recursive: true, force: true });
    });

    it('appends without eating the last existing line when the file lacks a trailing newline', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vs-ignore-'));
      await writeFile(join(dir, '.gitignore'), 'node_modules', 'utf8');
      await ensureIgnored(dir);
      expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.visual-spec/\n');
      await rm(dir, { recursive: true, force: true });
    });

    it('is idempotent, and recognises the entry written without a trailing slash', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vs-ignore-'));
      await writeFile(join(dir, '.gitignore'), '.visual-spec\n', 'utf8');
      await ensureIgnored(dir);
      await ensureIgnored(dir);
      expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('.visual-spec\n');
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('mountPullRequest', () => {
    it('materialises the PR tree, detached, and ignores it before creating it', async () => {
      const result = await mountPullRequest(base, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.worktree.headSha).toBe(prHead);
      expect(result.worktree.path.endsWith(worktreeRelPath(1))).toBe(true);
      // The invariant that matters, and the one a literal path assertion missed:
      // `mount` and `list` must spell the same worktree the same way, or a caller
      // asking "is this PR already mounted?" by path gets the wrong answer. On macOS
      // `/tmp` resolves to `/private/tmp` and the two disagreed.
      expect(result.worktree.path).toBe((await listMountedWorktrees(base))[0]?.path);

      // The file that only exists on the PR — proof the checkout is the PR's tree.
      expect(await readFile(join(result.worktree.path, 'spec.md'), 'utf8')).toBe(
        '# from the pull request\n',
      );
      // ...and the served directory was not switched to it.
      expect(await readFile(join(base, 'README.md'), 'utf8')).toBe('# base\n');
      await expect(readFile(join(base, 'spec.md'), 'utf8')).rejects.toThrow();

      // Detached: nothing can be committed onto a branch by accident.
      expect(await git(result.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');

      // The whole point of ensureIgnored — the mount adds nothing to `git status`.
      expect(await git(base, 'status', '--porcelain')).toBe('?? .gitignore');
    });

    it('moves an existing mount to the new head instead of recreating it', async () => {
      // A second commit on the PR, force-updating the ref the way a push would.
      await git(upstream, 'checkout', '-q', 'feature');
      await writeFile(join(upstream, 'spec.md'), '# revised\n', 'utf8');
      await git(upstream, 'commit', '-qam', 'pr revision');
      const revised = await git(upstream, 'rev-parse', 'HEAD');
      await git(upstream, 'update-ref', 'refs/pull/1/head', revised);
      await git(upstream, 'checkout', '-q', 'main');

      const before = (await listMountedWorktrees(base))[0]?.path;
      const result = await mountPullRequest(base, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.worktree.headSha).toBe(revised);
      // Same path — an editor tab opened on the first mount is still valid.
      expect(result.worktree.path).toBe(before);
      expect(await readFile(join(before, 'spec.md'), 'utf8')).toBe('# revised\n');
    });

    it.each([
      ['not-a-repo', (args: string[]) => args.includes('--git-dir')],
      ['no-origin', (args: string[]) => args.includes('get-url')],
      ['fetch-failed', (args: string[]) => args.includes('fetch')],
    ] as const)('reports %s rather than a generic failure', async (reason, fails) => {
      const { exec: stub } = stubExec((args) => ({ exitCode: fails(args) ? 1 : 0 }));
      const result = await mountPullRequest(base, 1, stub);
      expect(result).toEqual({ ok: false, reason });
    });

    it('reports head-mismatch, with both commits, rather than serving the wrong tree', async () => {
      const result = await mountPullRequest(base, 1, undefined, {
        expectedHeadSha: '0'.repeat(40),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('head-mismatch');
      // The evidence, not just the verdict: the two shas are what tells the reader the
      // checkout resolved somewhere else.
      expect(result.detail).toContain('0000000');
      expect(result.detail).toContain((await listMountedWorktrees(base))[0]!.headSha.slice(0, 7));
    });

    it('accepts the mount when the head is the one the caller expected', async () => {
      const at = (await listMountedWorktrees(base))[0]!.headSha;
      const result = await mountPullRequest(base, 1, undefined, { expectedHeadSha: at });
      expect(result.ok).toBe(true);
    });

    it('fetches the configured repository, not `origin`, when the two are different', async () => {
      const { exec: stub, calls } = stubExec((args) => ({
        stdout: args.includes('get-url') ? 'https://github.com/someone/served\n' : '',
        exitCode: 0,
      }));
      await mountPullRequest(base, 1, stub, { repo: { owner: 'metuur-ai', repo: 'other' } });
      const fetched = calls.find((args) => args.includes('fetch'));
      expect(fetched).toContain('https://github.com/metuur-ai/other.git');
      expect(fetched).not.toContain('origin');
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses pullNumber %s before touching git', async (n) => {
      const { exec: stub, calls } = stubExec(() => ({ exitCode: 0 }));
      await expect(mountPullRequest(base, n, stub)).rejects.toThrow('invalid pullNumber');
      // The guard exists to keep `../..` out of a path, so it must fire before the
      // fetch, not after a worktree has already been created somewhere unexpected.
      expect(calls.some((args) => args.includes('worktree'))).toBe(false);
    });
  });

  describe('fetchSource', () => {
    it('stays on `origin` when no repository is named', () => {
      expect(fetchSource('https://github.com/a/b.git')).toBe('origin');
    });

    it.each([
      ['https://github.com/a/b.git', { owner: 'a', repo: 'b' }],
      ['git@github.com:a/b.git', { owner: 'a', repo: 'b' }],
      // GitHub is case-insensitive about both halves, and `origin` is often spelled
      // differently from the configured value by nothing but a capital letter.
      ['https://github.com/A/B', { owner: 'a', repo: 'b' }],
    ] as const)('stays on `origin` when %s already is the configured repository', (url, repo) => {
      expect(fetchSource(url, repo)).toBe('origin');
    });

    it('addresses the configured repository on origin’s host when they differ', () => {
      expect(fetchSource('https://ghe.example.com/a/b.git', { owner: 'c', repo: 'd' })).toBe(
        'https://ghe.example.com/c/d.git',
      );
    });

    it('stays on `origin` when origin does not parse, rather than guessing', () => {
      // A local path, an `ssh://` URL, a port-bearing form: it cannot be shown to be the
      // wrong repository, so it is left alone and the head check does the catching.
      expect(fetchSource('/tmp/some/clone', { owner: 'c', repo: 'd' })).toBe('origin');
    });
  });

  describe('listMountedWorktrees', () => {
    it('reports the mounted PR and not the main worktree', async () => {
      const listed = await listMountedWorktrees(base);
      expect(listed.map((w) => w.pullNumber)).toEqual([1]);
      expect(listed[0]?.path.endsWith(worktreeRelPath(1))).toBe(true);
      expect(listed[0]?.headSha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('skips worktrees this module did not create', async () => {
      const foreign = join(root, 'unrelated');
      await git(base, 'worktree', 'add', '--detach', '-f', foreign, 'HEAD');
      expect((await listMountedWorktrees(base)).map((w) => w.pullNumber)).toEqual([1]);
      await git(base, 'worktree', 'remove', '--force', foreign);
    });
  });

  describe('unmountPullRequest', () => {
    it('removes the checkout and the private ref', async () => {
      expect(await unmountPullRequest(base, 1)).toBe(true);
      expect(await listMountedWorktrees(base)).toEqual([]);
      await expect(git(base, 'rev-parse', '--verify', 'refs/visual-spec/pr/1')).rejects.toThrow();
    });

    it('resolves false when nothing was mounted, rather than throwing', async () => {
      expect(await unmountPullRequest(base, 99)).toBe(false);
    });
  });
});
