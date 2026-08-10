/**
 * review-source-api.test.ts — R-W2.1 / R-W2.2 / R-W2.3 / R-W2.6 / R-W2.7 / R-W2.9.
 *
 * Everything here drives a FAKE `GitHubAdapter`. Nothing touches the network and nothing
 * spawns `gh` — the adapter is the seam this source is built on, so replacing it is
 * enough, and it is also how R-W2.6 is checked rather than promised: the fake throws on
 * every method the source is not supposed to call, so reaching for one is a test failure
 * rather than an unnoticed second access path.
 *
 * R-W2.9 gets two assertions, at two different levels — see the last describe.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { walkImportGraph } from '../import-graph';
import { GitHubError, type DirectoryEntry, type FileContent, type GitHubAdapter, type RepoRef } from './github-adapter';
import { createApiReviewSource } from './review-source-api';

const REPO: RepoRef = { owner: 'acme', repo: 'docs' };
const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'main';

/** Git's sha for the zero-length blob — the one the source uses as its "genuinely empty". */
const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

type Calls = {
  compareCommits: Array<[RepoRef, string, string]>;
  listFiles: Array<[RepoRef, string, string]>;
  getFile: Array<[RepoRef, string, string]>;
};

type Fakes = {
  compareCommits?: (repo: RepoRef, base: string, head: string) => Promise<{ files: string[] }>;
  listFiles?: (repo: RepoRef, path: string, ref: string) => Promise<DirectoryEntry[]>;
  getFile?: (repo: RepoRef, path: string, ref: string) => Promise<FileContent | null>;
};

/**
 * An adapter that answers exactly the three methods this source is allowed to use and
 * explodes on the other seventeen. The explosion is the R-W2.6 assertion: a source that
 * quietly grew a second way of reaching GitHub would trip it.
 */
function fakeAdapter(fakes: Fakes): { adapter: GitHubAdapter; calls: Calls } {
  const calls: Calls = { compareCommits: [], listFiles: [], getFile: [] };
  const forbidden = (name: string) => (): never => {
    throw new Error(`the host review source must not call adapter.${name} (R-W2.6)`);
  };
  const adapter = {
    getBranch: forbidden('getBranch'),
    createBranch: forbidden('createBranch'),
    deleteBranch: forbidden('deleteBranch'),
    commitFile: forbidden('commitFile'),
    createPullRequest: forbidden('createPullRequest'),
    getPullRequest: forbidden('getPullRequest'),
    findOpenPullRequestForBranch: forbidden('findOpenPullRequestForBranch'),
    listPullRequests: forbidden('listPullRequests'),
    searchPullRequests: forbidden('searchPullRequests'),
    mergePullRequest: forbidden('mergePullRequest'),
    listIssueComments: forbidden('listIssueComments'),
    createIssueComment: forbidden('createIssueComment'),
    updateIssueComment: forbidden('updateIssueComment'),
    deleteIssueComment: forbidden('deleteIssueComment'),
    listReviewComments: forbidden('listReviewComments'),
    createReviewComment: forbidden('createReviewComment'),
    replyToReviewComment: forbidden('replyToReviewComment'),
    listThreadResolution: forbidden('listThreadResolution'),

    async compareCommits(repo: RepoRef, base: string, head: string) {
      calls.compareCommits.push([repo, base, head]);
      const answer = await (fakes.compareCommits ?? (async () => ({ files: [] })))(repo, base, head);
      return { mergeBaseSha: 'deadbee', aheadBy: 1, behindBy: 0, files: answer.files };
    },
    async listFiles(repo: RepoRef, path: string, ref: string) {
      calls.listFiles.push([repo, path, ref]);
      return (fakes.listFiles ?? (async () => []))(repo, path, ref);
    },
    async getFile(repo: RepoRef, path: string, ref: string) {
      calls.getFile.push([repo, path, ref]);
      return (fakes.getFile ?? (async () => null))(repo, path, ref);
    },
  } as unknown as GitHubAdapter;
  return { adapter, calls };
}

const sourceOver = (fakes: Fakes) => {
  const { adapter, calls } = fakeAdapter(fakes);
  return { source: createApiReviewSource({ adapter, repo: REPO, headSha: HEAD, baseRef: BASE }), calls };
};

const entry = (name: string, path: string, type: string): DirectoryEntry => ({ name, path, sha: 'abc', type });

const throws = (err: unknown) => async (): Promise<never> => {
  throw err;
};

describe('createApiReviewSource: identity', () => {
  it('reports itself as the host source, pinned to the head commit (R-W1.5, R-W2.4)', () => {
    const { source } = sourceOver({});
    expect(source.kind).toBe('host');
    expect(source.headSha).toBe(HEAD);
  });
});

describe('changedPaths (R-W2.1)', () => {
  it('is base…head over compareCommits, and returns its files verbatim', async () => {
    const { source, calls } = sourceOver({
      compareCommits: async () => ({ files: ['docs/spec.md', 'src/app.ts'] }),
    });
    await expect(source.changedPaths()).resolves.toEqual({ ok: true, value: ['docs/spec.md', 'src/app.ts'] });
    // The exact call shape story 6.1 holds both sources to.
    expect(calls.compareCommits).toEqual([[REPO, BASE, HEAD]]);
  });

  it('answers an empty list, not a failure, for a pull request that changed nothing', async () => {
    const { source } = sourceOver({ compareCommits: async () => ({ files: [] }) });
    await expect(source.changedPaths()).resolves.toEqual({ ok: true, value: [] });
  });
});

describe('listDirectory (R-W2.3)', () => {
  it("lists the repository root for '' , at the pinned sha", async () => {
    const { source, calls } = sourceOver({
      listFiles: async () => [entry('README.md', 'README.md', 'file'), entry('src', 'src', 'dir')],
    });
    await expect(source.listDirectory('')).resolves.toEqual({
      ok: true,
      value: [
        { name: 'README.md', path: 'README.md', kind: 'file' },
        { name: 'src', path: 'src', kind: 'directory' },
      ],
    });
    expect(calls.listFiles).toEqual([[REPO, '', HEAD]]);
  });

  it('lists a nested directory, one call per directory and none for unopened ones', async () => {
    const { source, calls } = sourceOver({
      listFiles: async (_r, path) =>
        path === 'src' ? [entry('ui', 'src/ui', 'dir')] : [entry('app.ts', 'src/ui/app.ts', 'file')],
    });
    await source.listDirectory('src');
    await source.listDirectory('src/ui');
    expect(calls.listFiles).toEqual([
      [REPO, 'src', HEAD],
      [REPO, 'src/ui', HEAD],
    ]);
  });

  it.each([
    ['file', 'file'],
    ['dir', 'directory'],
    // A symlink is a leaf the tree offers to open, not a branch it offers to expand.
    ['symlink', 'file'],
    // A submodule reads as a directory everywhere else, and expands to nothing here.
    ['submodule', 'directory'],
  ])('maps GitHub type %s to kind %s', async (type, kind) => {
    const { source } = sourceOver({ listFiles: async () => [entry('thing', 'thing', type)] });
    const result = await source.listDirectory('');
    expect(result.ok && result.value[0]?.kind).toBe(kind);
  });

  it('sorts one flat list by name in code-unit order, not by locale and not by kind', async () => {
    const { source } = sourceOver({
      listFiles: async () => [
        entry('src', 'src', 'dir'),
        entry('docs', 'docs', 'dir'),
        entry('README.md', 'README.md', 'file'),
        entry('Makefile', 'Makefile', 'file'),
      ],
    });
    const result = await source.listDirectory('');
    /*
     * `README.md` before `docs` is the whole point: `localeCompare` puts `docs` first on
     * most locales, and the checkout source cannot be relied on to pick the same locale.
     * Directories are not hoisted above files either — one flat order, so 6.1 can compare
     * the two lists element by element.
     */
    expect(result.ok && result.value.map((e) => e.name)).toEqual(['Makefile', 'README.md', 'docs', 'src']);
  });

  it('yields an empty listing for a submodule rather than a failure', async () => {
    // The contents endpoint answers an object for a submodule, which `listFiles` folds
    // to `[]` — so expanding one is empty, not broken. The object is also what `getFile`
    // answers for the path, which is how this is told apart from a missing directory.
    const { source } = sourceOver({
      listFiles: async () => [],
      getFile: async (_r, path) => ({ path, sha: 'submodule-commit-sha', content: '' }),
    });
    await expect(source.listDirectory('vendor/thing')).resolves.toEqual({ ok: true, value: [] });
  });

  it('reports a directory that is not there as unreadable, not as an empty one (R-W2.12)', async () => {
    // `listFiles` folds the 404 into `[]`; the probe is what recovers the distinction the
    // checkout source never lost. Nothing at the path at all → not a directory to expand.
    const { source, calls } = sourceOver({ listFiles: async () => [], getFile: async () => null });
    const result = await source.listDirectory('docs/absent');
    expect(!result.ok && result.reason).toBe('not-readable');
    expect(!result.ok && result.detail).toContain('docs/absent');
    expect(calls.getFile).toEqual([[REPO, 'docs/absent', HEAD]]);
  });

  it('does not probe for a non-empty listing, nor for the repository root', async () => {
    // The extra call is paid only where it can change the answer: an empty listing at a
    // path that is not the root, which always exists when the commit does.
    const { source, calls } = sourceOver({
      listFiles: async (_r, path) => (path === '' ? [entry('docs', 'docs', 'dir')] : []),
      getFile: async (_r, path) => ({ path, sha: 'blob', content: '' }),
    });
    await source.listDirectory('');
    expect(calls.getFile).toEqual([]);
    await source.listDirectory('docs');
    expect(calls.getFile).toEqual([[REPO, 'docs', HEAD]]);
  });
});

describe('readFile (R-W2.2)', () => {
  it('reads a file the pull request changed', async () => {
    const { source, calls } = sourceOver({
      getFile: async (_r, path) => ({ path, sha: 'blob1', content: '# changed\n' }),
    });
    await expect(source.readFile('docs/spec.md')).resolves.toEqual({
      ok: true,
      value: { path: 'docs/spec.md', text: '# changed\n' },
    });
    expect(calls.getFile).toEqual([[REPO, 'docs/spec.md', HEAD]]);
  });

  it('reads a file the pull request did NOT change, by the same call at the same sha', async () => {
    const { source, calls } = sourceOver({
      compareCommits: async () => ({ files: ['docs/spec.md'] }),
      getFile: async (_r, path) => ({ path, sha: 'blob2', content: 'export const x = 1;\n' }),
    });
    const changed = await source.changedPaths();
    expect(changed.ok && changed.value).not.toContain('src/untouched.ts');
    await expect(source.readFile('src/untouched.ts')).resolves.toEqual({
      ok: true,
      value: { path: 'src/untouched.ts', text: 'export const x = 1;\n' },
    });
    expect(calls.getFile).toEqual([[REPO, 'src/untouched.ts', HEAD]]);
  });

  it('reads a genuinely empty file as empty text, not as a failure', async () => {
    const { source } = sourceOver({
      getFile: async (_r, path) => ({ path, sha: EMPTY_BLOB_SHA, content: '' }),
    });
    await expect(source.readFile('empty.txt')).resolves.toEqual({
      ok: true,
      value: { path: 'empty.txt', text: '' },
    });
  });

  it('reads a symbolic link the host could not resolve as its own target path (R-W2.11a)', async () => {
    // The symlink object, which is what the endpoint answers when the target leaves the
    // repository: `target` set, no content, and a blob sha that is the hash of the target
    // path. Without the branch under test this would fall into the 1 MB case below,
    // because it has the same shape — empty content under a non-empty sha.
    const { source } = sourceOver({
      getFile: async (_r, path) => ({ path, sha: 'linkblobsha', content: '', target: '../../etc/passwd' }),
    });
    await expect(source.readFile('docs/link.md')).resolves.toEqual({
      ok: true,
      value: { path: 'docs/link.md', text: '../../etc/passwd' },
    });
  });

  it("reads a symbolic link the host did resolve as the target's contents (R-W2.11)", async () => {
    /*
     * A link whose target is a plain file the repository holds comes back already
     * resolved — an ordinary file response, content and no `target` — so there is nothing
     * to special-case and the branch above must not fire on it. Asserted here rather than
     * left implied, because "it falls through" is the behaviour R-W2.11 depends on and a
     * future `target`-shaped guard could break it without any other test noticing.
     */
    const { source } = sourceOver({
      getFile: async (_r, path) => ({ path, sha: 'targetblobsha', content: '# the spec\n' }),
    });
    await expect(source.readFile('docs/link.md')).resolves.toEqual({
      ok: true,
      value: { path: 'docs/link.md', text: '# the spec\n' },
    });
  });

  it('refuses a file the contents API would not inline, rather than showing it blank', async () => {
    // >1 MB in the shape GitHub answers 200 for: empty content under a non-empty blob.
    const { source } = sourceOver({
      getFile: async (_r, path) => ({ path, sha: 'bigblobsha', content: '' }),
    });
    const result = await source.readFile('data/huge.json');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('not-readable');
    expect(!result.ok && result.detail).toContain('1 MB');
  });

  it('reports a missing file as not-readable, naming both things it could be', async () => {
    const { source } = sourceOver({ getFile: async () => null });
    const result = await source.readFile('gone.md');
    expect(!result.ok && result.reason).toBe('not-readable');
    expect(!result.ok && result.detail).toContain('gone.md');
  });
});

describe('failure taxonomy (R-W2.7)', () => {
  const ghError = (status: number | undefined, message: string, code?: string) =>
    new GitHubError('getFile', message, status, code);

  it('401 is no-credential — authenticate, do not retry', async () => {
    const { source } = sourceOver({ getFile: throws(ghError(401, 'Bad credentials')) });
    await expect(source.readFile('a.md')).resolves.toEqual({
      ok: false,
      reason: 'no-credential',
      detail: 'Bad credentials',
    });
  });

  it.each([
    [403, 'Must have admin rights to Repository.'],
    [404, 'Not Found'],
  ])('%d is not-readable — the path or the access is wrong', async (status, message) => {
    const { source } = sourceOver({ listFiles: throws(ghError(status, message)) });
    await expect(source.listDirectory('secret')).resolves.toEqual({
      ok: false,
      reason: 'not-readable',
      detail: message,
    });
  });

  it.each([
    ['a 5xx', ghError(502, 'Bad gateway')],
    ['gh not being runnable', ghError(undefined, 'GitHub CLI could not be started: gh not found on PATH', 'executor_unavailable')],
    ['a rate limit', ghError(403, 'API rate limit exceeded for user')],
  ])('%s is unreachable — retrying is the reasonable response', async (_label, err) => {
    const { source } = sourceOver({ compareCommits: throws(err) });
    const result = await source.changedPaths();
    expect(!result.ok && result.reason).toBe('unreachable');
    expect(!result.ok && result.detail).toBe(err.message);
  });

  it('a 404 about the pinned ref is head-moved, not not-readable', async () => {
    const { source } = sourceOver({
      listFiles: throws(ghError(404, `No commit found for the ref ${HEAD}`)),
    });
    const result = await source.listDirectory('src');
    expect(!result.ok && result.reason).toBe('head-moved');
  });

  it('a 422 naming the pinned sha is head-moved too', async () => {
    const { source } = sourceOver({
      compareCommits: throws(ghError(422, `No common ancestor between main and ${HEAD}.`)),
    });
    const result = await source.changedPaths();
    expect(!result.ok && result.reason).toBe('head-moved');
  });

  it('a non-GitHubError still resolves rather than rejecting', async () => {
    const { source } = sourceOver({ getFile: throws(new TypeError('something else entirely')) });
    const result = await source.readFile('a.md');
    expect(!result.ok && result.reason).toBe('unreachable');
    expect(!result.ok && result.detail).toBe('something else entirely');
  });
});

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Anything that could touch a disk, a socket or a process. */
const FORBIDDEN = /^(node:)?(fs|fs\/promises|os|child_process|http|https|net|tls|dns|worker_threads)($|\/)/;

/** Run a whole review: changed paths, two directories opened, two files read. */
async function fullReview(): Promise<void> {
  const { source } = sourceOver({
    compareCommits: async () => ({ files: ['docs/spec.md'] }),
    listFiles: async (_r, path) =>
      path === '' ? [entry('docs', 'docs', 'dir')] : [entry('spec.md', 'docs/spec.md', 'file')],
    getFile: async (_r, path) => ({ path, sha: 'blob', content: 'body\n' }),
  });
  expect((await source.changedPaths()).ok).toBe(true);
  expect((await source.listDirectory('')).ok).toBe(true);
  expect((await source.listDirectory('docs')).ok).toBe(true);
  expect((await source.readFile('docs/spec.md')).ok).toBe(true);
  // Twice, because a cache is the obvious thing to add on the second read and is exactly
  // what R-W2.9 forbids on disk.
  expect((await source.readFile('docs/spec.md')).ok).toBe(true);
}

describe('the host source writes nothing (R-W2.9)', () => {
  /*
   * Level one — statically, and about this file alone rather than its whole graph. It
   * declares no filesystem, process or socket import, and a module that cannot name
   * `node:fs` cannot write with it — a stronger statement than any single spy, because
   * it also holds for the code paths the runtime test below never reaches.
   *
   * The graph BELOW `github-adapter` is deliberately out of scope: it reaches
   * `node:child_process`, because spawning `gh` is exactly the access path R-W2.6
   * requires this source to use and nothing else. Asserting over the transitive graph
   * would be asserting a property of the adapter, which is not this story's to hold.
   */
  it('declares no filesystem, process or socket import of its own', () => {
    const violations: string[] = [];
    walkImportGraph(pkgRoot, 'core/collaboration/review-source-api.ts', ({ chain, specifiers }) => {
      // Depth 1 is the entry module itself; everything deeper is somebody else's graph.
      if (chain.length !== 1) return;
      for (const specifier of specifiers) {
        if (FORBIDDEN.test(specifier)) violations.push([...chain, specifier].join(' → '));
      }
    });
    expect(violations).toEqual([]);
  });

  /*
   * Level two — at run time. `vi.spyOn` cannot wrap an ESM builtin's namespace, so the
   * observation is made from the other side: the three directories a stray write would
   * plausibly land in are listed before and after a full review and must be identical.
   * That covers the specific thing this design promised not to do — no cache file, no
   * temp file, and no directory in the user's home.
   */
  it('performs a whole review without adding a file to cwd, tmp or the home directory', async () => {
    const watched = [process.cwd(), tmpdir(), homedir()];
    const listing = () => watched.map((dir) => fs.readdirSync(dir).sort().join('\n'));
    const before = listing();
    await fullReview();
    expect(listing()).toEqual(before);
  });

  /*
   * Level three — no `fs` module is even loaded on this source's account. Importing the
   * module afresh with the whole `node:fs` surface replaced by throwing stubs would fail
   * outright if anything in its own body reached for one.
   */
  it('constructs and answers with node:fs replaced by a throwing stub', async () => {
    vi.doMock('node:fs', () => {
      throw new Error('review-source-api.ts must not load node:fs (R-W2.9)');
    });
    vi.doMock('node:fs/promises', () => {
      throw new Error('review-source-api.ts must not load node:fs/promises (R-W2.9)');
    });
    try {
      const fresh = await import(`./review-source-api?fs-guard=${Date.now()}`);
      const { adapter } = fakeAdapter({ getFile: async (_r, path) => ({ path, sha: 'b', content: 'x' }) });
      const source = (fresh as typeof import('./review-source-api')).createApiReviewSource({
        adapter,
        repo: REPO,
        headSha: HEAD,
        baseRef: BASE,
      });
      await expect(source.readFile('a.md')).resolves.toEqual({ ok: true, value: { path: 'a.md', text: 'x' } });
    } finally {
      vi.doUnmock('node:fs');
      vi.doUnmock('node:fs/promises');
    }
  });
});
