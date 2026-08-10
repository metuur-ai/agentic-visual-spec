/**
 * review-source-parity.test.ts — R-W6.1, the two sources answering alike.
 *
 * WHAT IS BEING ASSERTED, AND WHY IT CANNOT BE ASSERTED TWICE. The whole design rests on
 * `createWorktreeReviewSource` and `createApiReviewSource` being substitutable: the
 * reviewing surface picks one before the first read and then never learns which it got.
 * If they disagree about a directory's entries, an entry's kind, the order of a listing,
 * or a file's bytes, the surface silently means two different things depending on where
 * the reviewer happened to be sitting — and neither source's own suite can see that,
 * because each one is only ever compared to itself.
 *
 * So this file has ONE test body, run twice by `describe.each` over the two constructors.
 * That is the requirement, not an economy: two bodies that happen to assert the same
 * things can be brought back into agreement by editing one of them, which is precisely
 * the failure this file exists to make impossible.
 *
 * THE FIXTURE IS ONE PULL REQUEST, AND IT IS DERIVED, NOT DUPLICATED. There is a real
 * repository built with `git init`, a real `git worktree add --detach` at the pull
 * request's head, and a real submodule inside the checkout — the shape
 * `mountPullRequest` leaves behind, and the reason `core/git-context.test.ts` stopped
 * hand-writing `.git` fixtures in the first place. The host source needs a
 * `GitHubAdapter`, and that adapter's answers are *walked out of the same checkout*
 * (`deriveHostTree` below) rather than typed out beside it. A hand-written second fixture
 * would assert that the fixture author copied correctly; a derived one asserts that the
 * two implementations agree.
 *
 * The derivation applies the host's own vocabulary, not the interface's: a symlink is
 * reported to the adapter as `symlink`, a directory holding its own `.git` as
 * `submodule`, and the listing is handed back in a deliberately wrong order — GitHub's
 * order is GitHub's business — so that the sort under test is the source's and not the
 * fixture's.
 *
 * THE TWO DIVERGENCES THIS SUITE FOUND, AND WHERE THEY WENT. When this file was first
 * written it named two differences as known and out of scope. Both turned out to be real
 * defects rather than acceptable variation, and story 2.8 closed them; they are asserted
 * in the shared body now, as R-W6.9 and R-W6.10.
 *
 *   - reading a symlink. The checkout source called `fs.readFile`, which follows the
 *     link — so a link committed into a fork's pull request and aimed outside the tree
 *     rendered whatever it pointed at. Neither source follows an escaping link now
 *     (R-W2.10); both answer its own target path (R-W2.11a).
 *   - a directory that is not there. The checkout source could always tell "missing" from
 *     "empty"; the host source folded a 404 into `[]` and rendered an empty node, which a
 *     reviewer reads as a directory the pull request emptied. `not-readable` won, and the
 *     host source adopted it (R-W2.12).
 *
 * THE FIXTURE MODELS BOTH HALVES OF A SYMLINK, AND HAS TO (R-W2.11b). `deriveHostTree`
 * once answered *every* link with the symlink-object shape — `target` set, no content —
 * and wrote down that GitHub additionally resolves a link to a plain file it holds, as a
 * simplification that did not matter. It mattered. A fixture that models every link as
 * unresolvable cannot see a source that treats every link as unresolvable, which is what
 * the checkout source had become: safe, and not what the host does. So the derivation now
 * splits where GitHub splits — an in-repo link is derived as the target file's content and
 * blob sha, an escaping link as the symlink object — and the shared body below asserts
 * both halves. `docs/link.md` is the resolvable case; `docs/escape.md`, aimed at a real
 * file outside the repository, is the one that must never be followed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile as fsReadFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchComparison, DirectoryEntry, FileContent, GitHubAdapter, RepoRef } from './github-adapter';
import type { ReviewSource } from './review-source';
import { createApiReviewSource } from './review-source-api';
import { createWorktreeReviewSource } from './review-source-worktree';

const run = promisify(execFile);

/** Run a real git command in `cwd`. Rejects on failure — setup must not fail silently. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

const REPO: RepoRef = { owner: 'acme', repo: 'widgets' };
const BASE_BRANCH = 'main';

/**
 * Git's own sha for a blob, computed the way git computes it, so the fixture never has to
 * state one. It matters for exactly one of the host source's branches — empty content
 * under the empty-blob sha is a genuinely empty file, empty content under any other sha
 * is a file the contents API declined to inline — and a hard-coded sha would be the
 * fixture asserting itself again.
 */
function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, 'utf8'), body]))
    .digest('hex');
}

/** Whether `abs` is the root of a repository of its own — i.e. a submodule. */
async function isSeparateRepo(abs: string): Promise<boolean> {
  try {
    await stat(join(abs, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the link at `linkAbs` really lands, but only if that is a plain file inside `root`
 * — otherwise `null`, meaning the host would not resolve it.
 *
 * This is the fixture standing in for GitHub's own decision, not a copy of the checkout
 * source's rule: the endpoint resolves a link to a file it holds and answers the symlink
 * object for anything else. `realpath` on both sides because `mkdtemp` hands out
 * `/var/folders/…` on macOS, which really is `/private/var/folders/…`.
 */
async function resolvedInsideFile(root: string, linkAbs: string): Promise<string | null> {
  try {
    const [real, base] = await Promise.all([realpath(linkAbs), realpath(root)]);
    if (real !== base && !real.startsWith(base + sep)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** What the host would answer for this tree, in the host's own vocabulary. */
type HostTree = {
  /** Repo-relative directory path → the entries GitHub's contents endpoint lists. */
  dirs: Map<string, DirectoryEntry[]>;
  /** Repo-relative file path → what the contents endpoint inlines for it. */
  files: Map<string, FileContent>;
};

/**
 * Walk the real checkout and write down what GitHub would say about it.
 *
 * This is the single fixture: everything the fake adapter answers comes from the same
 * bytes on the same disk that the checkout source reads directly. `.git` and
 * `.visual-spec` are skipped because they are not in the repository's tree at all, which
 * is why the checkout source hides them too — not a rule being restated, an absence being
 * reproduced.
 */
async function deriveHostTree(root: string): Promise<HostTree> {
  const dirs = new Map<string, DirectoryEntry[]>();
  const files = new Map<string, FileContent>();

  const walk = async (rel: string): Promise<void> => {
    const abs = rel === '' ? root : join(root, rel);
    const entries: DirectoryEntry[] = [];
    for (const dirent of await readdir(abs, { withFileTypes: true })) {
      if (dirent.name === '.git' || dirent.name === '.visual-spec') continue;
      const path = rel === '' ? dirent.name : `${rel}/${dirent.name}`;

      if (dirent.isSymbolicLink()) {
        /*
         * A LINK IS DERIVED IN WHICHEVER OF THE HOST'S TWO SHAPES IT REALLY EARNS
         * (R-W2.11b). The listing type is `symlink` either way — that comes off the git
         * tree mode and the endpoint never resolves it there — but the *contents* answer
         * depends on where the link lands, and a fixture that picked one shape for every
         * link would hide exactly the divergence this suite exists to catch.
         *
         * `target` is always read with `readlink` rather than through the link, so the
         * fixture cannot launder bytes it is not entitled to.
         */
        const linkAbs = join(abs, dirent.name);
        const target = await readlink(linkAbs);
        entries.push({ name: dirent.name, path, sha: gitBlobSha(target), type: 'symlink' });

        const resolved = await resolvedInsideFile(root, linkAbs);
        if (resolved === null) {
          // UNRESOLVABLE, because the target leaves the repository. GitHub answers the
          // symlink object: `target` set, no content, and the blob sha git really stores
          // for the link — the hash of the target path, not of anything at the other end
          // of it. Nothing at the other end is read here, deliberately.
          files.set(path, { path, sha: gitBlobSha(target), content: '', target });
        } else {
          // RESOLVED, because the target is a plain file this repository holds. GitHub
          // answers it as an ordinary file: the target's content, the target's blob sha,
          // and no `target` field at all — there is nothing in the response a caller could
          // use to tell it from reading the target directly. `path` stays the link's own,
          // which is the path that was asked for.
          const content = await fsReadFile(resolved, 'utf8');
          files.set(path, { path, sha: gitBlobSha(content), content });
        }
        continue;
      }
      if (dirent.isDirectory()) {
        const submodule = await isSeparateRepo(join(abs, dirent.name));
        entries.push({ name: dirent.name, path, sha: 'tree-sha', type: submodule ? 'submodule' : 'dir' });
        // A submodule's contents are another repository's, and `listFiles` folds the
        // object the endpoint answers for one into `[]`. That object is also what
        // `getFile` returns for the path — a commit sha and no content — which is how
        // the host source tells a submodule apart from a directory that is not there.
        if (submodule) {
          dirs.set(path, []);
          files.set(path, { path, sha: 'submodule-commit-sha', content: '' });
        } else await walk(path);
        continue;
      }

      const content = await fsReadFile(join(abs, dirent.name), 'utf8');
      files.set(path, { path, sha: gitBlobSha(content), content });
      entries.push({ name: dirent.name, path, sha: gitBlobSha(content), type: 'file' });
    }
    dirs.set(rel, entries);
  };

  await walk('');
  return { dirs, files };
}

/** How each source was called, so the two can be held to the same call shape. */
type Calls = {
  compareCommits: Array<[RepoRef, string, string]>;
  listFiles: Array<[RepoRef, string, string]>;
  getFile: Array<[RepoRef, string, string]>;
};

/**
 * A `GitHubAdapter` that answers out of `tree`, and explodes on everything else.
 *
 * Both sources are handed one of these — the checkout source uses `compareCommits` and
 * nothing more, the host source uses all three — so the changed-path answer is literally
 * the same call on the same object, which is the only way the two can be guaranteed to
 * agree about it rather than observed to.
 *
 * A read at any ref other than the pinned sha throws: if either source ever reached for a
 * branch name, this is where it would be caught (R-W2.4).
 */
function fakeAdapter(tree: HostTree, headSha: string, changed: readonly string[]): { adapter: GitHubAdapter; calls: Calls } {
  const calls: Calls = { compareCommits: [], listFiles: [], getFile: [] };
  const adapter = {
    async compareCommits(repo: RepoRef, base: string, head: string): Promise<BranchComparison> {
      calls.compareCommits.push([repo, base, head]);
      return { mergeBaseSha: 'deadbee', aheadBy: 1, behindBy: 0, files: [...changed] };
    },
    async listFiles(repo: RepoRef, path: string, ref: string): Promise<DirectoryEntry[]> {
      calls.listFiles.push([repo, path, ref]);
      if (ref !== headSha) throw new Error(`listFiles at ${ref}, which is not the pinned commit`);
      // Reversed on purpose. The host hands its listing over in an order of its own
      // choosing, so the order the source produces has to be the source's doing.
      return [...(tree.dirs.get(path) ?? [])].reverse();
    },
    async getFile(repo: RepoRef, path: string, ref: string): Promise<FileContent | null> {
      calls.getFile.push([repo, path, ref]);
      if (ref !== headSha) throw new Error(`getFile at ${ref}, which is not the pinned commit`);
      return tree.files.get(path) ?? null;
    },
  } as unknown as GitHubAdapter;
  return { adapter, calls };
}

/** The one pull request both sources answer for. */
let base: string;
let repoDir: string;
let checkout: string;
let headSha: string;
let changed: string[];
let hostTree: HostTree;
/** The file outside the pull request that a hostile link aims at, and its absolute path. */
let secretPath: string;

/**
 * Content that exists nowhere in the pull request. Any answer containing it came from
 * outside the tree, which is the whole of R-W2.10 stated as a string.
 */
const SECRET = 'PRIVATE KEY MATERIAL, OUTSIDE THE PULL REQUEST';

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'vs-review-parity-'));
  repoDir = join(base, 'repo');
  await mkdir(join(repoDir, 'docs/nested'), { recursive: true });
  await git(base, 'init', '-q', '-b', BASE_BRANCH, 'repo');
  await git(repoDir, 'config', 'user.email', 'test@example.invalid');
  await git(repoDir, 'config', 'user.name', 'Visual Spec Test');

  // The base commit. `Makefile` and `tsconfig.json` are here for the ordering assertion:
  // they bracket `docs` in code-unit order, so a listing that grouped directories apart
  // from files, or that sorted by locale, could not produce the expected sequence.
  await writeFile(join(repoDir, 'Makefile'), 'all:\n\t@echo hi\n');
  await writeFile(join(repoDir, 'README.md'), 'unchanged by the PR\n');
  await writeFile(join(repoDir, 'tsconfig.json'), '{}\n');
  await writeFile(join(repoDir, 'docs/spec.md'), '# the spec\n');
  await writeFile(join(repoDir, 'docs/nested/deep.txt'), 'deep\n');
  // Committed, not created in the checkout: a symlink git tracks is the case that shows
  // up in a pull request's tree.
  await symlink('spec.md', join(repoDir, 'docs/link.md'));

  /*
   * The hostile one (R-W6.9). A real file with recognisable content sits outside the
   * repository entirely, and a link committed *into* the pull request's tree points at
   * it — the shape a fork's branch can take, since a pull request's tree is written by
   * whoever opened it. The target is absolute because that is the simplest thing an
   * attacker writes (`~/.ssh/id_rsa` is absolute) and because a relative one would have
   * to be re-aimed for the worktree's depth, which would make the fixture, not the
   * source, decide whether the escape lands.
   */
  secretPath = join(base, 'secret.txt');
  await writeFile(secretPath, `${SECRET}\n`);
  await symlink(secretPath, join(repoDir, 'docs/escape.md'));

  await git(repoDir, 'add', '-A');
  await git(repoDir, 'commit', '-q', '-m', 'base');

  // The pull request: one file changed, one added.
  await git(repoDir, 'checkout', '-q', '-b', 'pr-7');
  await writeFile(join(repoDir, 'docs/spec.md'), '# the spec, as the PR leaves it\n');
  await writeFile(join(repoDir, 'docs/nested/new.txt'), 'added by the PR\n');
  await git(repoDir, 'add', '-A');
  await git(repoDir, 'commit', '-q', '-m', 'the pull request');
  headSha = await git(repoDir, 'rev-parse', 'HEAD');

  // The changed paths are git's answer to the same question the host is asked, so the
  // fixture does not get to choose them either.
  changed = (await git(repoDir, 'diff', '--name-only', `${BASE_BRANCH}...pr-7`)).split('\n').filter(Boolean);

  // The served directory stays on the base branch, exactly as a reviewer's would.
  await git(repoDir, 'checkout', '-q', BASE_BRANCH);

  checkout = join(repoDir, '.visual-spec/worktrees/pr-7');
  await git(repoDir, 'worktree', 'add', '-q', '--detach', checkout, headSha);

  // A directory inside the checkout that is a repository of its own — a submodule, as far
  // as anything reading the disk can tell.
  await mkdir(join(checkout, 'vendor'), { recursive: true });
  await git(checkout, 'init', '-q', '-b', BASE_BRANCH, 'vendor');
  await writeFile(join(checkout, 'vendor/other.txt'), 'another repository\n');

  hostTree = await deriveHostTree(checkout);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A constructed source together with the record of how it reached the host. */
type Built = { source: ReviewSource; calls: Calls };

const buildCheckout = (): Built => {
  const { adapter, calls } = fakeAdapter(hostTree, headSha, changed);
  return {
    source: createWorktreeReviewSource({
      worktree: { path: checkout, headSha },
      repo: REPO,
      baseBranch: BASE_BRANCH,
      adapter,
    }),
    calls,
  };
};

const buildHost = (): Built => {
  const { adapter, calls } = fakeAdapter(hostTree, headSha, changed);
  return {
    source: createApiReviewSource({ adapter, repo: REPO, headSha, baseRef: BASE_BRANCH }),
    calls,
  };
};

const sources: Array<[string, () => Built]> = [
  ['checkout', buildCheckout],
  ['host', buildHost],
];

/*
 * ONE BODY, TWO SOURCES. Every assertion below is written against `build()`, which is the
 * only thing that differs between the two runs. Nothing in here may branch on which
 * source is live — a `if (label === 'host')` in this file would be the seam leaking, and
 * would mean the requirement had been abandoned rather than met.
 */
describe.each(sources)('the %s source, over the same pull request (R-W6.1)', (_label, build) => {
  it('is pinned to the pull request head commit', () => {
    expect(build().source.headSha).toBe(headSha);
  });

  it('answers the changed paths, asked as base then head (R-W2.1)', async () => {
    const { source, calls } = build();
    expect(await source.changedPaths()).toEqual({ ok: true, value: changed });
    // The same call in the same argument order on both sides: reversed, the same method
    // answers the opposite question.
    expect(calls.compareCommits).toEqual([[REPO, BASE_BRANCH, headSha]]);
  });

  it('lists the repository root, sorted by name in code-unit order with files and directories not grouped (R-W2.3)', async () => {
    const listed = await build().source.listDirectory('');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    /*
     * `Makefile` and `README.md` before `docs` is `localeCompare`'s disagreement made
     * visible — it puts `docs` first on most locales, and the two sources cannot be
     * relied on to be running under the same one. `tsconfig.json` sitting between two
     * directories is the other half: one flat order, nothing hoisted.
     */
    expect(listed.value).toEqual([
      { name: 'Makefile', path: 'Makefile', kind: 'file' },
      { name: 'README.md', path: 'README.md', kind: 'file' },
      { name: 'docs', path: 'docs', kind: 'directory' },
      { name: 'tsconfig.json', path: 'tsconfig.json', kind: 'file' },
      { name: 'vendor', path: 'vendor', kind: 'directory' },
    ]);
  });

  it('lists a nested directory, one level only, with repo-relative paths (R-W2.3)', async () => {
    const { source } = build();

    const docs = await source.listDirectory('docs');
    expect(docs.ok).toBe(true);
    if (!docs.ok) return;
    expect(docs.value).toEqual([
      { name: 'escape.md', path: 'docs/escape.md', kind: 'file' },
      { name: 'link.md', path: 'docs/link.md', kind: 'file' },
      { name: 'nested', path: 'docs/nested', kind: 'directory' },
      { name: 'spec.md', path: 'docs/spec.md', kind: 'file' },
    ]);
    // Not recursive: `nested` appears, its contents do not.
    expect(docs.value.map((e) => e.name)).not.toContain('deep.txt');

    const nested = await source.listDirectory('docs/nested');
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.value).toEqual([
      { name: 'deep.txt', path: 'docs/nested/deep.txt', kind: 'file' },
      { name: 'new.txt', path: 'docs/nested/new.txt', kind: 'file' },
    ]);
  });

  it('maps all four kinds the same way: file, directory, symlink to file, submodule to an empty directory', async () => {
    const { source } = build();

    const root = await source.listDirectory('');
    const docs = await source.listDirectory('docs');
    expect(root.ok && docs.ok).toBe(true);
    if (!root.ok || !docs.ok) return;

    const kind = (entries: readonly { name: string; kind: string }[], name: string) =>
      entries.find((e) => e.name === name)?.kind;

    expect(kind(root.value, 'README.md')).toBe('file');
    expect(kind(root.value, 'docs')).toBe('directory');
    // A symlink is a leaf the tree offers to open, not a branch it offers to expand.
    expect(kind(docs.value, 'link.md')).toBe('file');
    // A submodule is a directory everywhere the reviewer has seen it, and expands to
    // nothing rather than failing — its contents belong to another repository.
    expect(kind(root.value, 'vendor')).toBe('directory');
    expect(await source.listDirectory('vendor')).toEqual({ ok: true, value: [] });
  });

  it('reads a file the pull request changed, at the pinned commit (R-W2.2)', async () => {
    const { source } = build();
    const changedPaths = await source.changedPaths();
    expect(changedPaths.ok && changedPaths.value).toContain('docs/spec.md');

    // The pinned commit, not the branch: `main` still holds the original text.
    expect(await source.readFile('docs/spec.md')).toEqual({
      ok: true,
      value: { path: 'docs/spec.md', text: '# the spec, as the PR leaves it\n' },
    });
  });

  it('reads a file the pull request did not change (R-W2.2)', async () => {
    const { source } = build();
    const changedPaths = await source.changedPaths();
    expect(changedPaths.ok && changedPaths.value).not.toContain('README.md');

    expect(await source.readFile('README.md')).toEqual({
      ok: true,
      value: { path: 'README.md', text: 'unchanged by the PR\n' },
    });
  });

  it('reads a link that leaves the tree as its own target path, never the file it points at (R-W6.9, R-W2.10, R-W2.11a)', async () => {
    const { source } = build();

    // The link that leaves the tree. Its contents are the path it names — one string this
    // process already had — and nothing that was fetched from the other end of it.
    const escape = await source.readFile('docs/escape.md');
    expect(escape.ok).toBe(true);
    if (!escape.ok) return;
    expect(escape.value).toEqual({ path: 'docs/escape.md', text: secretPath });
    expect(escape.value.text).not.toContain(SECRET);

    // And the target really is there, holding what the test says it holds — otherwise the
    // assertion above would pass against a fixture that had simply lost the file.
    expect(await fsReadFile(secretPath, 'utf8')).toContain(SECRET);
  });

  it("reads a link that stays inside the tree as the target's contents (R-W2.11, R-W2.11b)", async () => {
    const { source } = build();

    /*
     * `docs/link.md` → `docs/spec.md`, and what comes back is the spec, at the pinned
     * commit, not the four characters "spec.md". This is what the repository host does,
     * and it is safe for the same reason it is safe there: the target is tree content the
     * reviewer can open at `docs/spec.md` directly, so resolving the link hands over
     * nothing that was not already reachable.
     *
     * Read against `docs/spec.md`'s own answer rather than against a literal, so a fixture
     * that changed the spec's text cannot leave this asserting a stale string.
     */
    const target = await source.readFile('docs/spec.md');
    expect(target).toEqual({ ok: true, value: { path: 'docs/spec.md', text: '# the spec, as the PR leaves it\n' } });

    const link = await source.readFile('docs/link.md');
    expect(link.ok).toBe(true);
    if (!link.ok || !target.ok) return;
    // The link's own path, the target's bytes — the two things the host's resolved
    // response carries.
    expect(link.value).toEqual({ path: 'docs/link.md', text: target.value.text });
    // Not the unresolved answer. Naming it explicitly is the point: this assertion is the
    // one that fails if either source goes back to answering every link with its target
    // path, which is the overshoot R-W2.11b exists to keep out.
    expect(link.value.text).not.toBe('spec.md');
  });

  it('reports a directory that is not in the pull request as unreadable, not as an empty one (R-W6.10, R-W2.12)', async () => {
    const { source } = build();

    // Not a listing a reviewer can act on. "Empty" would be a confident wrong answer —
    // it reads as a directory this pull request deleted the contents of.
    expect(await source.listDirectory('docs/absent')).toMatchObject({ ok: false, reason: 'not-readable' });
    expect(await source.listDirectory('absent')).toMatchObject({ ok: false, reason: 'not-readable' });

    // Still distinct from the directory that is genuinely there with nothing to show:
    // a submodule lists as empty, and must not have been swept up by the above.
    expect(await source.listDirectory('vendor')).toEqual({ ok: true, value: [] });
  });
});

/*
 * The one field the two are required to DISAGREE on. R-W1.5 exists because the reviewer
 * has to be told which source is live — the host source needs the network per file and
 * cannot work offline. A parity suite that only ever asserted sameness would pass against
 * an implementation that had got its own identity wrong, which is why this is here and
 * why it is deliberately outside the shared body.
 */
describe('the two sources report different kinds (R-W1.5)', () => {
  it('is checkout on one side and host on the other, at the same commit', () => {
    const checkoutSource = buildCheckout().source;
    const hostSource = buildHost().source;

    expect(checkoutSource.kind).toBe('checkout');
    expect(hostSource.kind).toBe('host');
    expect(checkoutSource.kind).not.toBe(hostSource.kind);
    // Everything else about their identity is the same one pull request.
    expect(checkoutSource.headSha).toBe(hostSource.headSha);
  });
});
