/**
 * git-context.test.ts — Unit 1 of `docs/ears/git-context-in-header.md`.
 *
 * The repository-shaped cases run against **real** temporary repositories built with
 * `git init` rather than hand-written `.git` fixtures. That is the whole point: the
 * design this module replaced was a hand parser of `.git/HEAD` and `.git/config`, and
 * a hand-written fixture would have encoded the same two misunderstandings the parser
 * did. A linked worktree and an `upstream`-before-`origin` config each get a test
 * below precisely because those are the two cases the parser would have got wrong.
 *
 * The process-failure cases (git absent, git refusing the directory) go through the
 * injected `GitExecutor` instead — there is no portable way to uninstall git or to
 * provoke a "dubious ownership" refusal from inside a test.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GitExecutor, parseRemoteUrl, readGitContext } from './git-context';

const exec = promisify(execFile);

/** Run a real git command in `cwd`. Rejects on failure — setup must not fail silently. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/**
 * `git init` with the branch name pinned and identity set locally. The machine's
 * `init.defaultBranch`, `user.name` and `user.email` are none of this suite's
 * business, and a machine without a global identity would otherwise fail at `commit`.
 */
async function initRepo(dir: string, branch = 'main'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', branch);
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'user.name', 'Visual Spec Test');
  await writeFile(join(dir, 'file.txt'), 'one\n');
  await git(dir, 'add', 'file.txt');
  await git(dir, 'commit', '-q', '-m', 'first');
}

describe('readGitContext over real repositories', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-git-'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('reports the branch and the parsed origin of a plain repository (R-1.1, R-1.4, R-1.7)', async () => {
    const repo = join(base, 'plain');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');

    expect(await readGitContext(repo)).toEqual({
      state: 'remote',
      branch: 'main',
      detached: false,
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      url: 'https://github.com/acme/widgets.git',
    });
  });

  it('reports the same context from a subdirectory (R-1.1)', async () => {
    const repo = join(base, 'nested');
    await initRepo(repo, 'develop');
    await git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/nested.git');
    const sub = join(repo, 'docs', 'deep');
    await mkdir(sub, { recursive: true });

    // `git -C` searches upward, so serving `docs/deep` still finds the repository
    // above it. No part of `sub` appears in the result — R-1.11.
    expect(await readGitContext(sub)).toEqual({
      state: 'remote',
      branch: 'develop',
      detached: false,
      host: 'github.com',
      owner: 'acme',
      repo: 'nested',
      url: 'git@github.com:acme/nested.git',
    });
  });

  it("reports a linked worktree's own branch and the repository's remote (R-1.1)", async () => {
    // The case the hand parser got wrong: a linked worktree's git directory holds
    // `HEAD` but no `config` — the remote lives in the common directory.
    const repo = join(base, 'wt-main');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/wt.git');
    const worktree = join(base, 'wt-feature');
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    expect(await readGitContext(worktree)).toEqual({
      state: 'remote',
      branch: 'feature',
      detached: false,
      host: 'github.com',
      owner: 'acme',
      repo: 'wt',
      url: 'https://github.com/acme/wt.git',
    });
  });

  it('reports the short sha with detached true on a detached HEAD (R-1.5)', async () => {
    const repo = join(base, 'detached');
    await initRepo(repo);
    await git(repo, 'checkout', '-q', '--detach');
    const short = await git(repo, 'rev-parse', '--short', 'HEAD');

    expect(await readGitContext(repo)).toEqual({
      state: 'local',
      branch: short,
      detached: true,
    });
    expect(short).not.toBe('HEAD');
  });

  it('reports state none for a directory that is not a repository (R-1.2)', async () => {
    const plainDir = join(base, 'not-a-repo');
    await mkdir(plainDir, { recursive: true });

    expect(await readGitContext(plainDir)).toEqual({ state: 'none' });
  });

  it('reports local with the branch and no url when there is no origin (R-1.6)', async () => {
    const repo = join(base, 'no-origin');
    await initRepo(repo, 'trunk');

    const context = await readGitContext(repo);
    expect(context).toEqual({ state: 'local', branch: 'trunk', detached: false });
    // Not merely undefined-valued: the absence of a remote and an unparsable remote
    // are different states, and the chip tells them apart by this key.
    expect('url' in context).toBe(false);
  });

  it('reads origin even when upstream is configured first (R-1.9)', async () => {
    // The other case the hand parser got wrong: a naive scan of `.git/config` picks
    // up `[remote "upstream"]` when it precedes `[remote "origin"]`.
    const repo = join(base, 'two-remotes');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'upstream', 'https://github.com/upstream-org/upstream-repo.git');
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/fork-org/fork-repo.git');

    expect(await readGitContext(repo)).toMatchObject({
      state: 'remote',
      owner: 'fork-org',
      repo: 'fork-repo',
    });
  });

  it('carries the raw url on local when origin will not parse (R-1.8)', async () => {
    const repo = join(base, 'odd-remote');
    await initRepo(repo);
    await git(repo, 'remote', 'add', 'origin', 'ssh://host:2222/owner/repo.git');

    expect(await readGitContext(repo)).toEqual({
      state: 'local',
      branch: 'main',
      detached: false,
      url: 'ssh://host:2222/owner/repo.git',
    });
  });
});

describe('readGitContext when git cannot run', () => {
  it('resolves with state none when git is not installed (R-1.2)', async () => {
    // What `spawn` reports when the binary is not on PATH: an `error` event, no exit
    // code. The seam models that as `exitCode: null`.
    const enoent: GitExecutor = async () => ({ stdout: '', exitCode: null });

    await expect(readGitContext('/anywhere', enoent)).resolves.toEqual({ state: 'none' });
  });

  it('resolves with state none when git refuses the directory (R-1.2)', async () => {
    // Since the 2022 CVE fix git refuses a repository whose owner differs from the
    // current user — routine in containers and on mounted volumes. Exit 128, and the
    // message goes to stderr, which this module never reads.
    const dubious: GitExecutor = async () => ({ stdout: '', exitCode: 128 });

    await expect(readGitContext('/mounted/repo', dubious)).resolves.toEqual({ state: 'none' });
  });

  it('resolves with state none when git exits zero with nothing to say (R-1.2)', async () => {
    const empty: GitExecutor = async () => ({ stdout: '\n', exitCode: 0 });

    await expect(readGitContext('/anywhere', empty)).resolves.toEqual({ state: 'none' });
  });

  it('invokes only reading git commands (R-1.10)', async () => {
    const calls: string[][] = [];
    const record: GitExecutor = async (args) => {
      calls.push(args);
      return args.includes('remote')
        ? { stdout: 'https://github.com/acme/widgets\n', exitCode: 0 }
        : { stdout: 'HEAD\n', exitCode: 0 };
    };
    // A detached HEAD, so all three invocations happen.
    await readGitContext('/served', record);

    expect(calls).toEqual([
      ['-C', '/served', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['-C', '/served', 'rev-parse', '--short', 'HEAD'],
      ['-C', '/served', 'remote', 'get-url', 'origin'],
    ]);
    const writing = /^(add|commit|push|fetch|pull|checkout|clone|init|reset|config)$/;
    for (const args of calls) expect(args.some((a) => writing.test(a))).toBe(false);
  });

  it('does not read the short sha when HEAD names a branch (R-1.4)', async () => {
    const calls: string[][] = [];
    const record: GitExecutor = async (args) => {
      calls.push(args);
      return args.includes('remote')
        ? { stdout: '', exitCode: 2 }
        : { stdout: 'feature/x\n', exitCode: 0 };
    };

    expect(await readGitContext('/served', record)).toEqual({
      state: 'local',
      branch: 'feature/x',
      detached: false,
    });
    expect(calls.some((a) => a.includes('--short'))).toBe(false);
  });
});

describe('parseRemoteUrl', () => {
  const accepted: [string, string, string, string][] = [
    // url, host, owner, repo
    ['https://github.com/acme/widgets', 'github.com', 'acme', 'widgets'],
    ['https://github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['https://gitlab.com/group/proj', 'gitlab.com', 'group', 'proj'],
    ['https://gitlab.com/group/proj.git', 'gitlab.com', 'group', 'proj'],
    ['git@github.com:acme/widgets', 'github.com', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'github.com', 'acme', 'widgets'],
    ['git@gitlab.example.org:group/proj.git', 'gitlab.example.org', 'group', 'proj'],
    // a dot in the repository name is not a `.git` suffix
    ['https://github.com/acme/widgets.js', 'github.com', 'acme', 'widgets.js'],
  ];

  for (const [url, host, owner, repo] of accepted) {
    it(`parses ${url} (R-1.7)`, () => {
      expect(parseRemoteUrl(url)).toEqual({ host, owner, repo });
    });
  }

  const rejected = [
    'ssh://host:2222/owner/repo.git',
    'file:///tmp/x',
    'git://github.com/acme/widgets.git',
    'http://github.com/acme/widgets.git', // plain http is not the form the spec names
    'https://github.com/acme', // no repository segment
    'https://gitlab.com/group/sub/proj.git', // nested path is not <owner>/<repo>
    'not a url at all',
    '',
  ];

  for (const url of rejected) {
    it(`declines ${url || '(empty)'} rather than guessing (R-1.8)`, () => {
      expect(parseRemoteUrl(url)).toBeNull();
    });
  }

  it('reports local carrying the raw url for every declined form, never remote with empty fields (R-1.8)', async () => {
    for (const url of rejected.filter(Boolean)) {
      const context = await readGitContext('/served', async (args) =>
        args.includes('remote')
          ? { stdout: `${url}\n`, exitCode: 0 }
          : { stdout: 'main\n', exitCode: 0 },
      );
      expect(context).toEqual({ state: 'local', branch: 'main', detached: false, url });
    }
  });
});
