/**
 * review-source-worktree.test.ts — R-W1.2 / R-W5.2, against real checkouts.
 *
 * WHY REAL GIT AND NOT A FIXTURE. This is already the practice in this package, and it
 * was arrived at the hard way: `core/git-context.test.ts` records that a hand-written
 * `.git` fixture would have encoded the same misunderstandings as the hand parser it
 * replaced, so the suite builds temporary repositories with `git init` instead. The
 * subject here is a *linked worktree* — the exact shape a fixture is least able to
 * imitate, because `<checkout>/.git` is a file pointing into the main repository rather
 * than a directory, and both the head check and the submodule test read that file. A
 * mocked filesystem would have agreed with whatever this module happened to do.
 *
 * The one thing that is stubbed is the host: `changedPaths` is a `compareCommits` call,
 * and the point of asserting it here is the *shape* of the call — the repository, the
 * base branch, the pinned sha, in that order — because the host source makes the
 * identical call and story 6.1 asserts the two answer alike. A real GitHub would test
 * GitHub, not that.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchComparison, GitHubAdapter, RepoRef } from './github-adapter';
import { createWorktreeReviewSource } from './review-source-worktree';

const run = promisify(execFile);

/** Run a real git command in `cwd`. Rejects on failure — setup must not fail silently. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

const REPO: RepoRef = { owner: 'acme', repo: 'widgets' };

/** Content that exists nowhere in the checkout. Seeing it means a read left the tree. */
const SECRET = 'PRIVATE KEY MATERIAL, OUTSIDE THE CHECKOUT';

/** A `compareCommits` that records how it was called and answers a fixed list. */
function recordingAdapter(files: string[]): {
  adapter: Pick<GitHubAdapter, 'compareCommits'>;
  calls: Array<[RepoRef, string, string]>;
} {
  const calls: Array<[RepoRef, string, string]> = [];
  return {
    calls,
    adapter: {
      compareCommits: async (repo, base, head): Promise<BranchComparison> => {
        calls.push([repo, base, head]);
        return { mergeBaseSha: 'abc1234', aheadBy: 1, behindBy: 0, files };
      },
    },
  };
}

describe('the checkout-backed ReviewSource (R-W1.2, R-W5.2)', () => {
  let base: string;
  /** The main repository — what a user is serving. */
  let repoDir: string;
  /** The linked worktree — what a review reads through. */
  let checkout: string;
  let headSha: string;
  /** A second commit, for the head-moved case. */
  let laterSha: string;
  /** A directory outside the repository, and a file in it no read may ever return. */
  let outsideDir: string;
  let secretPath: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-review-src-'));
    repoDir = join(base, 'repo');
    await mkdir(join(repoDir, 'docs/nested'), { recursive: true });
    await git(base, 'init', '-q', '-b', 'main', 'repo');
    await git(repoDir, 'config', 'user.email', 'test@example.invalid');
    await git(repoDir, 'config', 'user.name', 'Visual Spec Test');

    await writeFile(join(repoDir, 'README.md'), 'unchanged by the PR\n');
    await writeFile(join(repoDir, 'docs/spec.md'), '# the spec\n');
    await writeFile(join(repoDir, 'docs/nested/deep.txt'), 'deep\n');
    // Committed rather than created in the checkout: a symlink git tracks is the case
    // that actually shows up in a pull request's tree.
    await symlink('spec.md', join(repoDir, 'docs/link.md'));

    /*
     * The two escapes a pull request's own tree can commit (R-W2.10). Both point at a
     * directory outside the repository holding a file with recognisable content, so any
     * answer carrying that content came from outside the checkout:
     *   - `docs/escape.md`, a link aimed straight at the file;
     *   - `docs/outdir`, a link aimed at the directory, so that an ordinary-looking read
     *     of `docs/outdir/secret.txt` walks out through it without naming a link at all.
     */
    outsideDir = join(base, 'outside');
    await mkdir(outsideDir, { recursive: true });
    secretPath = join(outsideDir, 'secret.txt');
    await writeFile(secretPath, `${SECRET}\n`);
    await symlink(secretPath, join(repoDir, 'docs/escape.md'));
    await symlink(outsideDir, join(repoDir, 'docs/outdir'));

    await git(repoDir, 'add', '-A');
    await git(repoDir, 'commit', '-q', '-m', 'first');
    headSha = await git(repoDir, 'rev-parse', 'HEAD');

    // A real linked worktree, detached, exactly as `mountPullRequest` leaves one.
    checkout = join(repoDir, '.visual-spec/worktrees/pr-7');
    await git(repoDir, 'worktree', 'add', '-q', '--detach', checkout, headSha);

    // A directory inside the checkout that is a repository of its own — a submodule, as
    // far as anything reading the disk can tell.
    await mkdir(join(checkout, 'vendor'), { recursive: true });
    await git(checkout, 'init', '-q', '-b', 'main', 'vendor');
    await writeFile(join(checkout, 'vendor/other.txt'), 'another repository\n');

    await writeFile(join(repoDir, 'docs/spec.md'), '# the spec, revised\n');
    await git(repoDir, 'add', '-A');
    await git(repoDir, 'commit', '-q', '-m', 'second');
    laterSha = await git(repoDir, 'rev-parse', 'HEAD');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const source = (files: string[] = ['docs/spec.md']) =>
    createWorktreeReviewSource({
      worktree: { path: checkout, headSha },
      repo: REPO,
      baseBranch: 'main',
      adapter: recordingAdapter(files).adapter,
    });

  it('reports its kind and stays pinned to the checkout commit (R-W1.5, R-W2.4)', () => {
    const s = source();
    expect(s.kind).toBe('checkout');
    expect(s.headSha).toBe(headSha);
  });

  it('asks the host for the changed paths, base then head (R-W2.1)', async () => {
    const { adapter, calls } = recordingAdapter(['docs/spec.md', 'docs/nested/deep.txt']);
    const s = createWorktreeReviewSource({
      worktree: { path: checkout, headSha },
      repo: REPO,
      baseBranch: 'main',
      adapter,
    });

    expect(await s.changedPaths()).toEqual({ ok: true, value: ['docs/spec.md', 'docs/nested/deep.txt'] });
    // The shape the host source repeats verbatim. Argument order is the whole assertion:
    // reversed, the same method answers the opposite question.
    expect(calls).toEqual([[REPO, 'main', headSha]]);
  });

  it('a host that throws is a list that could not be read, not a rejection', async () => {
    const s = createWorktreeReviewSource({
      worktree: { path: checkout, headSha },
      repo: REPO,
      baseBranch: 'main',
      adapter: {
        compareCommits: async () => {
          throw new Error('HTTP 404');
        },
      },
    });

    expect(await s.changedPaths()).toEqual({ ok: false, reason: 'not-readable', detail: 'HTTP 404' });
  });

  it("lists the repository root for '' and hides git's own directories (R-W2.3)", async () => {
    const listed = await source().listDirectory('');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(listed.value).toEqual([
      { name: 'README.md', path: 'README.md', kind: 'file' },
      { name: 'docs', path: 'docs', kind: 'directory' },
      { name: 'vendor', path: 'vendor', kind: 'directory' },
    ]);
  });

  it('lists a nested directory and spells child paths repo-relative (R-W2.3)', async () => {
    const listed = await source().listDirectory('docs');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(listed.value.map((e) => e.path)).toEqual([
      'docs/escape.md',
      'docs/link.md',
      'docs/nested',
      'docs/outdir',
      'docs/spec.md',
    ]);
    // Not recursive: `nested` appears, its contents do not.
    expect(listed.value.map((e) => e.name)).not.toContain('deep.txt');
  });

  it('reports a symlink as a file, because a reviewer opens it', async () => {
    const listed = await source().listDirectory('docs');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(listed.value.find((e) => e.name === 'link.md')).toEqual({
      name: 'link.md',
      path: 'docs/link.md',
      kind: 'file',
    });
  });

  it('lists a submodule as an empty directory rather than another repository', async () => {
    // It is a directory in its parent's listing (asserted above) and has nothing in it
    // here — the contents belong to a repository this pull request does not describe.
    expect(await source().listDirectory('vendor')).toEqual({ ok: true, value: [] });
  });

  it('reads a file the pull request changed, at the pinned commit (R-W2.2)', async () => {
    // The pinned commit, not the branch: `main` has moved on to "revised".
    expect(await source().readFile('docs/spec.md')).toEqual({
      ok: true,
      value: { path: 'docs/spec.md', text: '# the spec\n' },
    });
  });

  it('reads a file the pull request did not change (R-W2.2)', async () => {
    const changed = await source(['docs/spec.md']).changedPaths();
    expect(changed).toEqual({ ok: true, value: ['docs/spec.md'] });

    expect(await source().readFile('README.md')).toEqual({
      ok: true,
      value: { path: 'README.md', text: 'unchanged by the PR\n' },
    });
  });

  it('reads a symlink that leaves the checkout as its own target path, never following it (R-W2.10, R-W2.11a)', async () => {
    const s = source();

    const escape = await s.readFile('docs/escape.md');
    expect(escape).toEqual({ ok: true, value: { path: 'docs/escape.md', text: secretPath } });
    if (escape.ok) expect(escape.value.text).not.toContain(SECRET);

    // A link at a directory outside the checkout is the same answer for the same reason —
    // unresolvable as a file, so the path it names is all that is said about it.
    expect(await s.readFile('docs/outdir')).toEqual({ ok: true, value: { path: 'docs/outdir', text: outsideDir } });

    // The target exists and holds what it is supposed to — so the assertions above are
    // about the source refusing to fetch it, not about the fixture having lost it.
    expect(await readFile(secretPath, 'utf8')).toContain(SECRET);
  });

  it("reads a symlink that stays inside the checkout as the target's contents (R-W2.11)", async () => {
    // `docs/link.md` → `docs/spec.md`, and the host's contents endpoint resolves exactly
    // this case, so this source has to as well (R-W2.11b). Nothing is given away: the
    // reviewer can open `docs/spec.md` by its own path. The pinned commit's text, not
    // `main`'s "revised".
    expect(await source().readFile('docs/link.md')).toEqual({
      ok: true,
      value: { path: 'docs/link.md', text: '# the spec\n' },
    });
  });

  it('refuses a read that leaves the checkout through a linked directory (R-W2.10)', async () => {
    // `docs/outdir` is a link to a directory outside the repository, so this path names
    // no link itself and passes the string containment rule untouched. Only resolving it
    // catches the escape.
    const read = await source().readFile('docs/outdir/secret.txt');
    expect(read).toMatchObject({ ok: false, reason: 'not-readable' });
    if (!read.ok) expect(read.detail ?? '').not.toContain(SECRET);

    // Listing through it is refused on the same grounds — the entries in there belong to
    // no pull request.
    expect(await source().listDirectory('docs/outdir')).toMatchObject({ ok: false, reason: 'not-readable' });
  });

  it('refuses a path that escapes the checkout', async () => {
    const s = source();
    for (const escape of ['../../../etc/passwd', '/etc/passwd', 'docs/../../..']) {
      const read = await s.readFile(escape);
      expect(read.ok, escape).toBe(false);
      if (!read.ok) expect(read.reason).toBe('not-readable');
    }

    const listed = await s.listDirectory('..');
    expect(listed).toMatchObject({ ok: false, reason: 'not-readable' });
  });

  it('refuses an empty path and a NUL byte', async () => {
    const s = source();
    expect(await s.readFile('')).toMatchObject({ ok: false, reason: 'not-readable' });
    expect(await s.readFile('docs/spec.md\0.png')).toMatchObject({ ok: false, reason: 'not-readable' });
    expect(await s.listDirectory('docs\0')).toMatchObject({ ok: false, reason: 'not-readable' });
  });

  it('a file that is not there is not readable, not a throw', async () => {
    expect(await source().readFile('docs/absent.md')).toMatchObject({ ok: false, reason: 'not-readable' });
    expect(await source().listDirectory('docs/absent')).toMatchObject({ ok: false, reason: 'not-readable' });
  });

  it('refuses to serve bytes once the checkout has left the pinned commit (R-W2.5)', async () => {
    // A second mount of the same pull request moves the existing checkout in place, so
    // this is the ordinary way the head moves under an open review — not a contrivance.
    await git(checkout, 'checkout', '-q', '--detach', laterSha);
    try {
      const s = source();
      const read = await s.readFile('docs/spec.md');
      expect(read).toMatchObject({ ok: false, reason: 'head-moved' });
      if (!read.ok) expect(read.detail).toContain(headSha.slice(0, 7));

      expect(await s.listDirectory('')).toMatchObject({ ok: false, reason: 'head-moved' });
    } finally {
      await git(checkout, 'checkout', '-q', '--detach', headSha);
    }
  });

  it('a checkout that is no longer there is not readable', async () => {
    const s = createWorktreeReviewSource({
      worktree: { path: join(base, 'never-mounted'), headSha },
      repo: REPO,
      baseBranch: 'main',
      adapter: recordingAdapter([]).adapter,
    });

    expect(await s.readFile('docs/spec.md')).toMatchObject({ ok: false, reason: 'not-readable' });
    expect(await s.listDirectory('')).toMatchObject({ ok: false, reason: 'not-readable' });
  });
});
