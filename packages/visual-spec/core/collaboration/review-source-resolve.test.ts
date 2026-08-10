/**
 * review-source-resolve.test.ts — story 1.3's decision, at both of its boundaries
 * (R-W6.2 / R-W6.3).
 *
 * AGAINST REAL REPOSITORIES, for the reason `worktree.test.ts` and `git-context.test.ts`
 * already give: `refs/pull/<n>/head` is an ordinary ref, `origin` is ordinary config, and
 * the whole question this module answers is what git says about a directory. A faked
 * `GitExecutor` here would assert the fixture's spelling of git's output and would not
 * have caught the case that matters most — a served directory whose `origin` names a
 * *different* repository, which is real git config resolved by real `fetchSource`.
 *
 * THE CASE THAT MATTERS MOST. The first draft of the resolution rule used the checkout
 * only when `origin` matched the pull request's repository, which would have moved a
 * working case onto the host. So the primary test here serves a repository whose `origin`
 * is `https://github.com/someone/served.git` and reviews a pull request of `acme/specs`,
 * and asserts the checkout is still chosen. `fetchSource` derives the explicit URL
 * `https://github.com/acme/specs.git`, and the served repository carries an `insteadOf`
 * rewrite pointing that URL at a local upstream — which is git's own mechanism, so the
 * fetch that runs is the real one, with the real derived URL, and no network is touched.
 *
 * NOTHING HERE REACHES GITHUB: the adapter is a double with the three methods a review
 * source may call.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitHubAdapter } from './github-adapter';
import { resolveReviewSource, type ReviewResolveAdapter } from './review-source-resolve';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/** The repository the pull request belongs to — deliberately not the served one. */
const REPO = { owner: 'acme', repo: 'specs' } as const;
/** The URL `fetchSource` derives for `REPO` when `origin` names something else. */
const DERIVED_URL = 'https://github.com/acme/specs.git';

/**
 * The adapter, narrowed to what a resolution and its two sources may call. `getPullRequest`
 * is the only one a resolution itself makes; the rest exist so the resulting source can be
 * driven far enough to prove which one it is.
 */
function adapterFor(headSha: string, calls: string[] = []): ReviewResolveAdapter {
  return {
    async getPullRequest(_repo: unknown, pullNumber: number) {
      calls.push('getPullRequest');
      return {
        number: pullNumber,
        headSha,
        baseBranch: 'main',
        headBranch: 'feature',
        state: 'open',
        htmlUrl: 'https://github.com/acme/specs/pull/7',
        body: '',
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
      };
    },
    async compareCommits(_repo: unknown, base: string, head: string) {
      calls.push(`compareCommits:${base}...${head}`);
      return { mergeBaseSha: 'b'.repeat(40), aheadBy: 1, behindBy: 0, files: ['spec.md'] };
    },
    async listFiles(_repo: unknown, path: string, ref?: string) {
      calls.push(`listFiles:${path}@${ref ?? ''}`);
      return [{ name: 'spec.md', path: 'spec.md', type: 'file', sha: 'c'.repeat(40), size: 1 }];
    },
    async getFile(_repo: unknown, path: string, ref?: string) {
      calls.push(`getFile:${path}@${ref ?? ''}`);
      return { path, content: '# from the host\n', sha: 'c'.repeat(40) };
    },
  } as unknown as ReviewResolveAdapter & GitHubAdapter;
}

describe('resolveReviewSource', () => {
  let root: string;
  let upstream: string;
  let served: string;
  let plain: string;
  let orphan: string;
  let prHead: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vs-resolve-'));
    upstream = join(root, 'upstream');
    served = join(root, 'served');
    plain = join(root, 'plain');
    orphan = join(root, 'orphan');

    // The upstream repository, carrying the pull request head at the ref GitHub serves.
    await mkdir(upstream, { recursive: true });
    await git(upstream, 'init', '-q', '-b', 'main');
    await git(upstream, 'config', 'user.email', 'test@example.invalid');
    await git(upstream, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(upstream, 'README.md'), '# base\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'base');
    await git(upstream, 'checkout', '-q', '-b', 'feature');
    await writeFile(join(upstream, 'spec.md'), '# from the checkout\n', 'utf8');
    await git(upstream, 'add', '.');
    await git(upstream, 'commit', '-q', '-m', 'pr commit');
    prHead = await git(upstream, 'rev-parse', 'HEAD');
    await git(upstream, 'update-ref', 'refs/pull/7/head', prHead);
    await git(upstream, 'checkout', '-q', 'main');

    /*
     * The served repository. Its `origin` names `someone/served` — a *different*
     * repository from the one under review — which is exactly the configuration the
     * corrected resolution rule exists to keep on the checkout.
     */
    await mkdir(served, { recursive: true });
    await git(served, 'init', '-q', '-b', 'main');
    await git(served, 'config', 'user.email', 'test@example.invalid');
    await git(served, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(served, 'notes.md'), '# served\n', 'utf8');
    await git(served, 'add', '.');
    await git(served, 'commit', '-q', '-m', 'served');
    await git(served, 'remote', 'add', 'origin', 'https://github.com/someone/served.git');
    // git's own URL rewrite, so the URL `fetchSource` derives resolves to the local
    // upstream. The fetch under test is the real one; only where it lands is local.
    await git(served, 'config', `url.${upstream}.insteadOf`, DERIVED_URL);

    // Not a git working tree at all.
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'notes.md'), '# just a folder\n', 'utf8');

    // A working tree with no `origin` — R-1.6's other half of "no origin remote".
    await mkdir(orphan, { recursive: true });
    await git(orphan, 'init', '-q', '-b', 'main');
    await git(orphan, 'config', 'user.email', 'test@example.invalid');
    await git(orphan, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(orphan, 'notes.md'), '# no remote\n', 'utf8');
    await git(orphan, 'add', '.');
    await git(orphan, 'commit', '-q', '-m', 'orphan');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- *
   * R-W6.2 — the boundary a match-only rule would have got wrong
   * ---------------------------------------------------------------- */

  it('takes the checkout when the served tree’s origin names a different repository', async () => {
    const resolved = await resolveReviewSource({
      baseDir: served,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead),
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source.kind).toBe('checkout');
    expect(resolved.worktree?.headSha).toBe(prHead);
    // The bytes come off the disk, at the pull request's commit — a file `main` of the
    // served repository has never had.
    const file = await resolved.source.readFile('spec.md');
    expect(file.ok && file.value.text).toBe('# from the checkout\n');
  });

  it('mounts inside the served directory and nowhere else', async () => {
    const resolved = await resolveReviewSource({
      baseDir: served,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || !resolved.worktree) throw new Error('expected a checkout');
    // `.visual-spec/worktrees/<owner>/<repo>/pr-7` under the served directory — R-13.5,
    // now carrying the repository (R-W3.5). macOS resolves `/tmp` to `/private/tmp`, so
    // the tail is what is asserted, as elsewhere.
    expect(
      resolved.worktree.path.endsWith(join('served', '.visual-spec', 'worktrees', REPO.owner, REPO.repo, 'pr-7')),
    ).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * R-W6.3 — the boundary that used to be a refusal
   * ---------------------------------------------------------------- */

  it('yields a host source, not a refusal, when the served directory is not a git working tree', async () => {
    const calls: string[] = [];
    const resolved = await resolveReviewSource({
      baseDir: plain,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead, calls),
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source.kind).toBe('host');
    // Nothing was checked out, so there is no worktree to report.
    expect(resolved.worktree).toBeUndefined();
    const file = await resolved.source.readFile('spec.md');
    expect(file.ok && file.value.text).toBe('# from the host\n');
    // Every read landed on the pinned commit, never on a branch name (R-W2.4).
    expect(calls).toContain(`getFile:spec.md@${prHead}`);
  });

  it('yields a host source when the served tree has no origin to fetch from', async () => {
    const resolved = await resolveReviewSource({
      baseDir: orphan,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source.kind).toBe('host');
    expect(resolved.worktree).toBeUndefined();
  });

  /* ---------------------------------------------------------------- *
   * The failures that stay terminal (R-W5.2)
   * ---------------------------------------------------------------- */

  it('reports a fetch that failed rather than falling through to the host', async () => {
    // A working tree with an origin that cannot be fetched from. The rule said checkout,
    // the checkout could not be made, and hiding that behind a host-sourced review would
    // leave a reviewer with a broken clone and no way to know.
    const broken = join(root, 'broken');
    await mkdir(broken, { recursive: true });
    await git(broken, 'init', '-q', '-b', 'main');
    await git(broken, 'config', 'user.email', 'test@example.invalid');
    await git(broken, 'config', 'user.name', 'Visual Spec Test');
    await writeFile(join(broken, 'notes.md'), '# broken\n', 'utf8');
    await git(broken, 'add', '.');
    await git(broken, 'commit', '-q', '-m', 'broken');
    await git(broken, 'remote', 'add', 'origin', join(root, 'no-such-repository'));

    const resolved = await resolveReviewSource({
      baseDir: broken,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead),
    });
    expect(resolved).toMatchObject({ ok: false, reason: 'fetch-failed' });
  });

  it('reports a pull request it could not read as a value, never as a throw', async () => {
    const failing = {
      async getPullRequest() {
        throw new Error('gh is not installed');
      },
    } as unknown as ReviewResolveAdapter;
    const resolved = await resolveReviewSource({ baseDir: plain, repo: REPO, pullNumber: 7, adapter: failing });
    expect(resolved).toMatchObject({ ok: false, reason: 'pull-unreadable' });
  });

  /* ---------------------------------------------------------------- *
   * R-W2.5 — the changed paths and the pinned commit move together
   * ---------------------------------------------------------------- */

  it('pins the source and its changed paths to the one head it read', async () => {
    const calls: string[] = [];
    const resolved = await resolveReviewSource({
      baseDir: plain,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead, calls),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // One head, reported once and used everywhere: the source's pin and the pull request
    // fact the surface displays cannot be two different commits, because they are one
    // value produced by one read.
    expect(resolved.pull.headSha).toBe(resolved.source.headSha);
    await resolved.source.changedPaths();
    expect(calls).toContain(`compareCommits:main...${prHead}`);
  });

  it('answers a moved head with a new source, leaving the old one on its own commit', async () => {
    const first = await resolveReviewSource({
      baseDir: plain,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(prHead),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The head moves — a force-push, as far as this module is concerned.
    const moved = 'f'.repeat(40);
    const calls: string[] = [];
    const second = await resolveReviewSource({
      baseDir: plain,
      repo: REPO,
      pullNumber: 7,
      adapter: adapterFor(moved, calls),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // A refresh is a NEW source. The old one is unchanged and still pinned where it was,
    // because there is no operation on a `ReviewSource` that could re-pin it — which is
    // what makes "the changed paths and the pinned commit refresh together" the only
    // possible outcome rather than a discipline call sites have to keep.
    expect(second.source).not.toBe(first.source);
    expect(second.source.headSha).toBe(moved);
    expect(second.pull.headSha).toBe(moved);
    expect(first.source.headSha).toBe(prHead);
    await second.source.changedPaths();
    expect(calls).toContain(`compareCommits:main...${moved}`);
  });
});
