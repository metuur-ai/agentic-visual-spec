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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitExecutor } from '../git-context';
import type { RepoRef } from './github-adapter';
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

/**
 * The repository every single-repository case below mounts. Named rather than inlined so
 * the pair of tests that mount TWO repositories reads as the exception it is.
 */
const REPO: RepoRef = { owner: 'acme', repo: 'specs' };

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

  /**
   * The entry goes to `.git/info/exclude`, which is per-clone and outside the working
   * tree. Every case below asserts the destination and not just the content, because the
   * destination is the whole decision: `.gitignore` would ignore the directory just as
   * well and would be tracked content, a diff the reviewer did not ask for, and — the
   * reason the checkout path used to need a second call — versioned, so a branch change
   * could take it away.
   */
  describe('ensureIgnored', () => {
    /** A repository with a working tree, so the exclude file has somewhere to live. */
    async function repo(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'vs-ignore-'));
      await git(dir, 'init', '-q', '-b', 'main');
      return dir;
    }

    const excludeOf = (dir: string) => join(dir, '.git', 'info', 'exclude');

    it('writes the entry to .git/info/exclude and leaves tracked content untouched', async () => {
      const dir = await repo();
      await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
      await git(dir, 'add', '.gitignore');

      await ensureIgnored(dir);

      expect(await readFile(excludeOf(dir), 'utf8')).toContain('.visual-spec/\n');
      // The point of the destination: nothing the user owns moved.
      expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
      expect(await git(dir, 'status', '--porcelain')).toBe('A  .gitignore');
      await rm(dir, { recursive: true, force: true });
    });

    it('appends without eating the last existing line when the file lacks a trailing newline', async () => {
      const dir = await repo();
      await writeFile(excludeOf(dir), '# comment', 'utf8');
      await ensureIgnored(dir);
      expect(await readFile(excludeOf(dir), 'utf8')).toBe('# comment\n.visual-spec/\n');
      await rm(dir, { recursive: true, force: true });
    });

    it('is idempotent, and recognises the entry written without a trailing slash', async () => {
      const dir = await repo();
      await writeFile(excludeOf(dir), '.visual-spec\n', 'utf8');
      await ensureIgnored(dir);
      await ensureIgnored(dir);
      expect(await readFile(excludeOf(dir), 'utf8')).toBe('.visual-spec\n');
      await rm(dir, { recursive: true, force: true });
    });

    it('ignores the directory from a subdirectory of the repository, not beside it', async () => {
      // `baseDir` is whatever directory is being served, which need not be the root.
      const dir = await repo();
      const nested = join(dir, 'docs');
      await mkdir(nested, { recursive: true });

      await ensureIgnored(nested);

      expect(await readFile(excludeOf(dir), 'utf8')).toContain('.visual-spec/\n');
      // Not a second exclude file beside the served directory — there is no such thing.
      await expect(readFile(join(nested, '.git', 'info', 'exclude'), 'utf8')).rejects.toThrow();
      await rm(dir, { recursive: true, force: true });
    });

    it('does nothing at all outside a repository', async () => {
      // No git means nothing that could see the directory, which is the outcome asked for.
      const dir = await mkdtemp(join(tmpdir(), 'vs-ignore-'));
      await expect(ensureIgnored(dir)).resolves.toBeUndefined();
      await expect(readFile(join(dir, '.gitignore'), 'utf8')).rejects.toThrow();
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('mountPullRequest', () => {
    it('materialises the PR tree, detached, and ignores it before creating it', async () => {
      const result = await mountPullRequest(base, REPO, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.worktree.headSha).toBe(prHead);
      expect(result.worktree.path.endsWith(worktreeRelPath(REPO, 1))).toBe(true);
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
      // Empty, not `?? .gitignore`: the entry lives in `.git/info/exclude` now, so the
      // mount leaves no trace in the served directory's tracked content either (R-W5.3).
      expect(await git(base, 'status', '--porcelain')).toBe('');
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
      const result = await mountPullRequest(base, REPO, 1);
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
      const result = await mountPullRequest(base, REPO, 1, stub);
      expect(result).toEqual({ ok: false, reason });
    });

    it('reports head-mismatch, with both commits, rather than serving the wrong tree', async () => {
      const result = await mountPullRequest(base, REPO, 1, undefined, {
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
      const result = await mountPullRequest(base, REPO, 1, undefined, { expectedHeadSha: at });
      expect(result.ok).toBe(true);
    });

    it('fetches the configured repository, not `origin`, when the two are different', async () => {
      const { exec: stub, calls } = stubExec((args) => ({
        stdout: args.includes('get-url') ? 'https://github.com/someone/served\n' : '',
        exitCode: 0,
      }));
      await mountPullRequest(base, { owner: 'metuur-ai', repo: 'other' }, 1, stub);
      const fetched = calls.find((args) => args.includes('fetch'));
      expect(fetched).toContain('https://github.com/metuur-ai/other.git');
      expect(fetched).not.toContain('origin');
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses pullNumber %s before touching git', async (n) => {
      const { exec: stub, calls } = stubExec(() => ({ exitCode: 0 }));
      await expect(mountPullRequest(base, REPO, n, stub)).rejects.toThrow('invalid pullNumber');
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
      expect(listed[0]?.path.endsWith(worktreeRelPath(REPO, 1))).toBe(true);
      expect(listed[0]?.headSha).toMatch(/^[0-9a-f]{40}$/);
    });

    // R-W3.5 — the listing parses the mount path back, so the repository has to survive
    // the round trip or a mount stops being reportable at all. Asserted on the object the
    // route hands the browser, not on the path, because that is what the surface reads.
    it('says which repository each mount belongs to (R-W3.5)', async () => {
      expect((await listMountedWorktrees(base))[0]?.repo).toEqual(REPO);
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
      expect(await unmountPullRequest(base, REPO, 1)).toBe(true);
      expect(await listMountedWorktrees(base)).toEqual([]);
      await expect(git(base, 'rev-parse', '--verify', 'refs/visual-spec/pr/1')).rejects.toThrow();
    });

    it('resolves false when nothing was mounted, rather than throwing', async () => {
      expect(await unmountPullRequest(base, REPO, 99)).toBe(false);
    });
  });
});

/* ================================================================== *
 * R-W3.5 — a checkout is a repository AND a number
 * ================================================================== */

describe('worktreeRelPath', () => {
  it('carries the repository, so pull request 42 names one checkout per repository (R-W3.5)', () => {
    expect(worktreeRelPath({ owner: 'acme', repo: 'one' }, 42)).toBe('.visual-spec/worktrees/acme/one/pr-42');
    expect(worktreeRelPath({ owner: 'acme', repo: 'two' }, 42)).toBe('.visual-spec/worktrees/acme/two/pr-42');
  });

  // The same guard, and the same threat model, as `assertPullNumber`: no shell is ever
  // involved, and the danger is `..`, `-` and the empty string reaching `join()` and
  // escaping `.visual-spec/worktrees/`. `.` and `..` are the two that pass a character
  // check and still mean something to a path resolver, so they are named individually.
  it.each([
    ['owner', { owner: '..', repo: 'specs' }],
    ['owner', { owner: '.', repo: 'specs' }],
    ['owner', { owner: '', repo: 'specs' }],
    ['owner', { owner: 'a/../..', repo: 'specs' }],
    ['repo', { owner: 'acme', repo: '..' }],
    ['repo', { owner: 'acme', repo: '' }],
    ['repo', { owner: 'acme', repo: 'spec s' }],
  ] as const)('refuses a %s that is not one: %o', (what, repo) => {
    expect(() => worktreeRelPath(repo, 1)).toThrow(`invalid ${what}`);
  });
});

/**
 * Two repositories, each with their own pull request 42, against real git.
 *
 * The served directory's `origin` is repointed between the two mounts rather than the
 * repository name being trusted to redirect the fetch: `fetchSource` leaves a filesystem
 * `origin` alone (it cannot be parsed into owner/repo), so this is how a local upstream
 * pair can stand in for two GitHub repositories without inventing a URL parser's answer.
 * The point of the fixture is that the two #42s are DIFFERENT COMMITS with different
 * bytes, so a collision shows up as content rather than as a path assertion.
 */
describe('R-W3.5 — two repositories’ pull request #42 mount side by side', () => {
  let root: string;
  let served: string;

  async function upstreamWith(name: string): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@example.invalid');
    await git(dir, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(dir, 'spec.md'), `# ${name}\n`, 'utf8');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', name);
    await git(dir, 'update-ref', 'refs/pull/42/head', await git(dir, 'rev-parse', 'HEAD'));
    return dir;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vs-worktree-two-'));
    const one = await upstreamWith('one');
    const two = await upstreamWith('two');
    served = join(root, 'served');
    await exec('git', ['clone', '-q', one, served], { cwd: root });

    await mountPullRequest(served, { owner: 'acme', repo: 'one' }, 42);
    // The second repository, reached the way a reviewer serving one clone reaches another
    // repository: same number, different upstream.
    await git(served, 'remote', 'set-url', 'origin', two);
    await mountPullRequest(served, { owner: 'acme', repo: 'two' }, 42);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('mounts both, and each holds its own repository’s tree', async () => {
    const first = join(served, worktreeRelPath({ owner: 'acme', repo: 'one' }, 42));
    const second = join(served, worktreeRelPath({ owner: 'acme', repo: 'two' }, 42));
    expect(first).not.toBe(second);
    // The decisive half. Before this change both mounts contended for
    // `.visual-spec/worktrees/pr-42`, so the second could not be made at all — and the
    // first repository's bytes are still there afterwards, which is what "neither
    // disturbs the other" means when the disturbance would be a shared directory.
    expect(await readFile(join(first, 'spec.md'), 'utf8')).toBe('# one\n');
    expect(await readFile(join(second, 'spec.md'), 'utf8')).toBe('# two\n');
  });

  it('reports both to the listing, each under its own repository', async () => {
    const listed = await listMountedWorktrees(served);
    expect(listed.map((w) => ({ ...w.repo, pullNumber: w.pullNumber }))).toEqual([
      { owner: 'acme', repo: 'one', pullNumber: 42 },
      { owner: 'acme', repo: 'two', pullNumber: 42 },
    ]);
    // Two mounts, two commits: the listing is not reporting one checkout twice.
    expect(new Set(listed.map((w) => w.headSha)).size).toBe(2);
  });

  it('removes one without touching the other', async () => {
    expect(await unmountPullRequest(served, { owner: 'acme', repo: 'one' }, 42)).toBe(true);
    const listed = await listMountedWorktrees(served);
    expect(listed.map((w) => w.repo.repo)).toEqual(['two']);
    expect(await readFile(join(listed[0]!.path, 'spec.md'), 'utf8')).toBe('# two\n');
  });
});

/**
 * The pre-scoping mount. See `legacyWorktreeRelPath` in `worktree.ts` for the argument;
 * this asserts the outcome — it is removed with git's own command, not renamed, and not
 * left registered where nothing could ever report it.
 */
describe('R-W3.5 — a checkout mounted before the repository was in the path is retired', () => {
  let root: string;
  let served: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vs-worktree-legacy-'));
    const upstream = join(root, 'upstream');
    await mkdir(upstream, { recursive: true });
    await git(upstream, 'init', '-q', '-b', 'main');
    await git(upstream, 'config', 'user.email', 'test@example.invalid');
    await git(upstream, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(upstream, 'spec.md'), '# pull request\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'pr');
    await git(upstream, 'update-ref', 'refs/pull/1/head', await git(upstream, 'rev-parse', 'HEAD'));
    served = join(root, 'served');
    await exec('git', ['clone', '-q', upstream, served], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A real linked worktree at the old path — registered with git, exactly as one was. */
  async function mountTheOldWay(): Promise<string> {
    const rel = '.visual-spec/worktrees/pr-1';
    await git(served, 'worktree', 'add', '--detach', '-f', rel, 'HEAD');
    return join(served, rel);
  }

  it('unregisters it when the same pull request is mounted, rather than stranding it', async () => {
    const legacy = await mountTheOldWay();
    expect(await git(served, 'worktree', 'list', '--porcelain')).toContain('worktrees/pr-1');

    const result = await mountPullRequest(served, REPO, 1);
    expect(result.ok).toBe(true);

    // Gone from git's registry — which is the whole point. Left behind it would hold
    // objects alive and show in `git worktree list` while being invisible to a listing
    // that now requires a repository in the path, so nothing could remove it.
    expect(await git(served, 'worktree', 'list', '--porcelain')).not.toContain('/worktrees/pr-1');
    await expect(readFile(join(legacy, 'spec.md'), 'utf8')).rejects.toThrow();
    // ...and the checkout the reviewer asked for is there, under the repository.
    expect(
      await readFile(join(served, worktreeRelPath(REPO, 1), 'spec.md'), 'utf8'),
    ).toBe('# pull request\n');
  });

  it('leaves another pull request’s pre-scoping mount alone', async () => {
    await git(served, 'worktree', 'add', '--detach', '-f', '.visual-spec/worktrees/pr-2', 'HEAD');
    // Retiring is keyed to the number being mounted: #2 is not the directory a mount of
    // #1 is about, and guessing at it would be removing a checkout nobody asked about.
    expect((await mountPullRequest(served, REPO, 1)).ok).toBe(true);
    expect(await git(served, 'worktree', 'list', '--porcelain')).toContain('worktrees/pr-2');
  });
});
