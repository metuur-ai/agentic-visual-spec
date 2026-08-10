/**
 * review-leaves-served-dir-alone.test.ts — R-W5.3 and R-W5.4: a review borrows the served
 * directory and gives it back exactly as it found it.
 *
 * WHY THIS IS NOT COVERED BY `review-issues-no-git-write.test.ts`. That file asserts over
 * argv — no `commit`, no `push`, no branch-shaped refspec — and says so precisely because
 * an outcome check is the weaker of the two claims. This file makes the *other* claim, and
 * it is weaker in the opposite direction and therefore not redundant: argv cannot see a
 * file written outside git at all. `ensureIgnored` writes `.gitignore`, `holdDraft` writes
 * under `.visual-spec/`, and the worktree materialises a whole tree on the disk the user is
 * serving. None of that is a git command, so none of it appears in an argv audit, and every
 * one of it lands in the directory whose contents R-W5.3 protects. The two files together
 * are the requirement; either alone is half of it.
 *
 * WHY REAL GIT, AND WHAT "FOREIGN REPOSITORY" MEANS HERE. `git` is not injected. The whole
 * point is that a real `worktree add` really materialises a tree inside `served`, a real
 * `fetch` really writes into `served/.git`, and a real `worktree remove` really takes it
 * away again — an injected executor would assert this test's beliefs about git rather than
 * git's behaviour, which is the mistake `core/git-context.test.ts` records having made once
 * already. Nothing reaches the network: `origin` is a second repository on the same disk
 * carrying a real `refs/pull/7/head`, which is the ref `mountPullRequest` fetches.
 *
 * That local `origin` is also what makes this the *foreign*-repository case rather than a
 * convenient shortcut. `fetchSource` parses the origin URL and, failing to (a filesystem
 * path is not `host/owner/repo`), stays on `origin` — so the configured repository
 * `acme/specs` and whatever `origin` is a clone of are, as far as every rule in
 * `review-source-resolve.ts` can tell, different repositories, and the review still takes
 * the checkout (R-W1.2). A parseable foreign origin would have sent the fetch to
 * `https://github.com/acme/specs.git`, i.e. the network, which no test in this package may
 * touch.
 *
 * WHAT "UNMODIFIED" IS MEASURED AS. Four independent facts, because "unchanged" collapses
 * three different failures into one word:
 *   - the bytes of every file in the served directory (a content walk, not a listing —
 *     a file replaced by a same-sized different file passes a listing);
 *   - the current branch, and the full set of branches, because "left on a detached HEAD"
 *     and "left on a new branch" are both R-W5.3 broken and neither changes any file;
 *   - the index and the working tree as git sees them (`status`, `diff`, `diff --cached`),
 *     which is where UNSAVED work lives — the case the story singles out, and the one the
 *     whole worktree design was chosen over `git checkout` to protect;
 *   - the stash, because the tidiest possible way to "not disturb" uncommitted edits is to
 *     stash them, and that is the requirement broken with the evidence hidden.
 *
 * The walk excludes `.git/` and `.visual-spec/`, and the exclusion is itself asserted
 * rather than assumed: a separate expectation requires every path the review created to be
 * under one of those two. `.visual-spec/` is this package's own sidecar — gitignored, and
 * where held comments deliberately outlive the review that produced them — so counting it
 * as "the user's directory changed" would forbid the feature rather than test it.
 *
 * WHILE, AND THEN WHEN. R-W5.3 is a WHILE and R-W5.4 is a WHEN, so the state is captured
 * three times: before the review, while it is open with files being read out of it, and
 * after it is closed. A review that trashed the directory and restored it on close would
 * pass a before/after comparison and is exactly the failure the middle capture catches.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollaborationPreflight } from '../../collaboration/credentials';
import type { GitHubAdapter } from '../../collaboration/github-adapter';
import { createJobHubRegistry } from '../../collaboration/job-hub';
import { listMountedWorktrees } from '../../collaboration/worktree';
import type { ResolvedVisualSpecConfig } from '../../config';
import { type CollabAuthorizer, type CollabRouteResult, createCollabRoutes } from './collab';

const run = promisify(execFile);

/** Run a real git command in `cwd`. Rejects on failure — setup must not fail silently. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout.trim();
}

const REPO = { owner: 'acme', repo: 'specs', baseBranch: 'main' } as const;
const ENABLED: ResolvedVisualSpecConfig = { surfacesDir: 'surfaces', collaboration: { ...REPO }, git: { allowCheckout: false } };
const ALLOW_ALL: CollabAuthorizer = () => ({ ok: true });

const OK_PREFLIGHT: CollaborationPreflight = {
  available: true,
  source: 'gh-auth-state',
  login: 'octocat',
  scopes: ['repo'],
  repo: { ...REPO },
};

/** The branch the reviewer is on, and must still be on. Not `main`, so a reset to it shows. */
const WORKING_BRANCH = 'feature/wip';

/** Text that exists only in the working copy. Seeing it change is R-W5.3 broken. */
const UNSAVED = '# notes\n\nhalf a sentence I was in the middle of\n';
const STAGED = '# readme\n\nstaged, not committed\n';
const UNTRACKED = 'scratch, not even added\n';

/* ------------------------------------------------------------------ *
 * Measuring "unmodified"
 * ------------------------------------------------------------------ */

/** Directories that are not the user's content: git's own, and this package's sidecar. */
const NOT_USER_CONTENT = new Set(['.git', '.visual-spec']);

/**
 * Every file under `dir`, mapped to a digest of its bytes; directories map to a marker.
 *
 * Content rather than names: a review that replaced a file with a different file of the
 * same name and size would pass a listing comparison, and "the working copy is unmodified"
 * is a claim about bytes.
 */
function contentSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      if (NOT_USER_CONTENT.has(name)) continue;
      const child = join(abs, name);
      const rel = relative(dir, child);
      if (statSync(child).isDirectory()) {
        out[rel] = '<dir>';
        visit(child);
      } else {
        out[rel] = createHash('sha256').update(readFileSync(child)).digest('hex');
      }
    }
  };
  visit(dir);
  return out;
}

/** Every path under `dir`, including the two excluded above — for the "and nowhere else" check. */
function everyPath(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      out.push(relative(dir, child));
      // `.git` holds git's own bookkeeping — logs, index mtimes, fetched objects — all of
      // which a fetch legitimately churns. It is covered by the git-state capture below
      // instead, which asks git what it *means* rather than which files it rewrote.
      if (name !== '.git' && statSync(child).isDirectory()) visit(child);
    }
  };
  visit(dir);
  return out.sort();
}

/**
 * What git believes about the directory: the branch, the branches, the index, the working
 * tree, and the stash. Every field is a separate way R-W5.3 can be broken without any of
 * the others noticing.
 */
async function gitState(dir: string) {
  return {
    branch: await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head: await git(dir, 'rev-parse', 'HEAD'),
    branches: await git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    status: await git(dir, 'status', '--porcelain'),
    unstaged: await git(dir, 'diff'),
    staged: await git(dir, 'diff', '--cached'),
    stash: await git(dir, 'stash', 'list'),
  };
}

/* ------------------------------------------------------------------ *
 * The host, stubbed — only the host
 * ------------------------------------------------------------------ */

/**
 * The GitHub side of a review. `headSha` is the commit really sitting at
 * `refs/pull/7/head` in the upstream repository, so `mountPullRequest`'s head check passes
 * against a real fetch rather than against a number this file invented.
 */
function adapter(headSha: string): GitHubAdapter {
  return {
    async listPullRequests() {
      return [];
    },
    async getPullRequest(_repo: unknown, pullNumber: number) {
      return {
        number: pullNumber,
        headSha,
        baseBranch: 'main',
        headBranch: 'patch-1',
        state: 'open',
        htmlUrl: 'https://github.com/acme/specs/pull/7',
        body: 'a description',
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
      };
    },
    async compareCommits() {
      return { mergeBaseSha: 'b'.repeat(40), aheadBy: 1, behindBy: 0, files: ['docs/spec.md'] };
    },
    async listReviewComments() {
      return [];
    },
    async listThreadResolution() {
      return [];
    },
    async listFiles() {
      return [{ name: 'spec.md', path: 'docs/spec.md', type: 'file', sha: 'c'.repeat(40), size: 3 }];
    },
    async getFile(_repo: unknown, path: string) {
      return { path, content: '# from the host\n', sha: 'c'.repeat(40) };
    },
  } as unknown as GitHubAdapter;
}

function router(served: string, headSha: string) {
  return createCollabRoutes({
    jobs: createJobHubRegistry(),
    config: () => ENABLED,
    documents: () => {
      throw new Error('a review must not read the document store');
    },
    preflight: async () => OK_PREFLIGHT,
    authorize: ALLOW_ALL,
    baseDir: () => served,
    repoAdapter: () => adapter(headSha),
    // `git` is deliberately NOT injected: this file is about what real git does to a real
    // directory. Everything else is stubbed so nothing reaches the network.
  });
}

const call = (
  r: ReturnType<typeof router>,
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  query: Record<string, string> = {},
): Promise<CollabRouteResult> => r.handle({ method, pathname, query, body });

/* ------------------------------------------------------------------ *
 * Fixtures — two real repositories on one disk
 * ------------------------------------------------------------------ */

/**
 * The repository `origin` points at, carrying a real `refs/pull/7/head`.
 *
 * That ref is GitHub's, not git's — `git init` never creates one — so it is written by
 * hand. It is the only piece of GitHub-ness the checkout path needs from a remote, which
 * is precisely why a local repository can stand in for one without weakening the test.
 */
async function makeUpstream(dir: string): Promise<string> {
  await mkdir(join(dir, 'docs'), { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main', '.');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'user.name', 'Visual Spec Test');
  await writeFile(join(dir, 'docs/spec.md'), '# the spec, as the pull request leaves it\n');
  await writeFile(join(dir, 'README.md'), 'upstream readme\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'the pull request head');
  const head = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'update-ref', 'refs/pull/7/head', head);
  return head;
}

/**
 * The directory the user is serving: a real working tree, on a branch that is not `main`,
 * with a modification held back from the index, a modification staged in it, and an
 * untracked file — the three shapes of "unsaved" a reviewer actually has open.
 *
 * `.gitignore` already ignores `.visual-spec/`, so `ensureIgnored` finds nothing to do and
 * the review's footprint on tracked content is nil rather than one line. The line it would
 * otherwise add is asserted separately below, so this is a simplification of the fixture,
 * not of the claim.
 */
async function makeServed(dir: string, origin: string | null): Promise<void> {
  await mkdir(join(dir, 'docs'), { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main', '.');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'user.name', 'Visual Spec Test');
  await writeFile(join(dir, '.gitignore'), '.visual-spec/\n');
  await writeFile(join(dir, 'README.md'), '# readme\n');
  await writeFile(join(dir, 'notes.md'), '# notes\n');
  await writeFile(join(dir, 'docs/local.md'), 'a local document\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'the project as committed');
  await git(dir, 'checkout', '-q', '-b', WORKING_BRANCH);

  if (origin !== null) await git(dir, 'remote', 'add', 'origin', origin);

  // The three kinds of work in flight.
  await writeFile(join(dir, 'notes.md'), UNSAVED);
  await writeFile(join(dir, 'README.md'), STAGED);
  await git(dir, 'add', 'README.md');
  await writeFile(join(dir, 'scratch.txt'), UNTRACKED);
}

/**
 * A whole review: open it, read what changed, walk its tree, open one of its files, read
 * the conversation, hold a comment, then close it.
 *
 * The tree and raw reads are the load-bearing ones. They are what proves this is a review
 * of the *pull request* and not of the served directory — the file they return exists only
 * upstream — so "the served directory is unchanged" cannot be true merely because nothing
 * happened.
 */
async function fullReview(r: ReturnType<typeof router>): Promise<CollabRouteResult[]> {
  const out: CollabRouteResult[] = [];
  out.push(await call(r, 'POST', '/pulls/7/mount'));
  out.push(await call(r, 'GET', '/pulls/7/files'));
  out.push(await call(r, 'GET', '/pulls/7/description'));
  out.push(await call(r, 'GET', '/pulls/7/tree', {}, { path: '' }));
  out.push(await call(r, 'GET', '/pulls/7/tree', {}, { path: 'docs' }));
  out.push(await call(r, 'GET', '/pulls/7/raw', {}, { path: 'docs/spec.md' }));
  out.push(await call(r, 'GET', '/pulls/7/comments'));
  out.push(await call(r, 'POST', '/pulls/7/drafts', { path: 'docs/spec.md', comment: 'this contradicts §2', headSha: 'x', line: 1 }));
  return out;
}

/* ================================================================== *
 * R-W5.3 / R-W5.4 — the checkout supplies the review
 * ================================================================== */
describe('R-W5.3 / R-W5.4 — a checkout-supplied review leaves the served directory alone', () => {
  let base: string;
  let served: string;
  let upstream: string;
  let headSha: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-served-untouched-'));
    upstream = join(base, 'upstream');
    served = join(base, 'project');
    await mkdir(upstream);
    await mkdir(served);
    headSha = await makeUpstream(upstream);
    await makeServed(served, upstream);
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('reads the pull request out of a real checkout, and gives the directory back untouched', async () => {
    const contentBefore = contentSnapshot(served);
    const gitBefore = await gitState(served);
    const pathsBefore = everyPath(served);

    const r = router(served, headSha);
    const results = await fullReview(r);

    /*
     * The review is real, and it is the checkout's. Asserted before anything else, because
     * every "unchanged" assertion below is vacuously true of a review that refused.
     */
    expect(results[0]).toMatchObject({ status: 200, json: { ok: true, source: 'checkout', headSha } });
    const mounted = (results[0]!.json as { worktree: { path: string } }).worktree;
    expect(mounted.path).toContain('.visual-spec/worktrees/pr-7');

    // The bytes came from the pull request's tree, not from the served directory — the
    // file says so, and `docs/local.md` (which exists only in the served directory) is not
    // in the listing.
    expect(results[5]).toMatchObject({
      status: 200,
      json: { path: 'docs/spec.md', text: '# the spec, as the pull request leaves it\n' },
    });
    const docs = (results[4]!.json as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(docs).toEqual(['docs/spec.md']);

    /* ---- WHILE the review is open (R-W5.3) ---- */
    expect(contentSnapshot(served)).toEqual(contentBefore);
    expect(await gitState(served)).toEqual(gitBefore);
    // Said again in the terms the requirement uses, so a failure names the thing that broke
    // rather than reporting a diff of two large objects.
    expect(await git(served, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(WORKING_BRANCH);
    expect(readFileSync(join(served, 'notes.md'), 'utf8')).toBe(UNSAVED);
    expect(readFileSync(join(served, 'scratch.txt'), 'utf8')).toBe(UNTRACKED);

    // Everything the review DID create is under the two directories the content walk
    // excludes — which is what earns that exclusion.
    const created = everyPath(served).filter((p) => !pathsBefore.includes(p));
    expect(created.length).toBeGreaterThan(0);
    for (const path of created) {
      expect(path.startsWith('.git') || path.startsWith('.visual-spec'), path).toBe(true);
    }

    /* ---- WHEN the review is closed (R-W5.4) ---- */
    const closed = await call(r, 'DELETE', '/pulls/7/mount');
    r.dispose();
    expect(closed).toMatchObject({ status: 200, json: { ok: true, removed: true } });

    // The interface has nothing else to return to: no checkout is mounted, and the
    // directory the reviewer is looking at is the served one, byte for byte as it was.
    expect(await listMountedWorktrees(served)).toEqual([]);
    expect(contentSnapshot(served)).toEqual(contentBefore);
    expect(await gitState(served)).toEqual(gitBefore);
  }, 60_000);

  it('adds the ignore line, and only the ignore line, when the served directory has none', async () => {
    /*
     * The one write into tracked content a review is allowed. `ensureIgnored` runs before
     * the worktree is created, deliberately: a checkout inside the working tree that git
     * can see is thousands of untracked files in `git status`, which is itself a way of
     * disturbing the directory. So the exception exists to serve the requirement rather
     * than to escape it — and it is pinned here to exactly one appended line, on one file,
     * so it cannot quietly grow into a second write.
     */
    const other = join(base, 'no-ignore');
    await mkdir(other);
    await makeServed(other, upstream);
    await rm(join(other, '.gitignore'));
    await git(other, 'rm', '-q', '--cached', '.gitignore');
    await git(other, 'commit', '-q', '-m', 'no ignore file');

    const contentBefore = contentSnapshot(other);
    const r = router(other, headSha);
    expect(await call(r, 'POST', '/pulls/7/mount')).toMatchObject({ status: 200, json: { source: 'checkout' } });
    await call(r, 'DELETE', '/pulls/7/mount');
    r.dispose();

    const contentAfter = contentSnapshot(other);
    const changed = Object.keys(contentAfter).filter((p) => contentAfter[p] !== contentBefore[p]);
    expect(changed).toEqual(['.gitignore']);
    expect(readFileSync(join(other, '.gitignore'), 'utf8')).toBe('.visual-spec/\n');
    // And the unsaved work is still unsaved work, which is the point of the whole file.
    expect(readFileSync(join(other, 'notes.md'), 'utf8')).toBe(UNSAVED);
    expect(await git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(WORKING_BRANCH);
  }, 60_000);
});

/* ================================================================== *
 * R-W5.3 / R-W5.4 — the host supplies the review
 * ================================================================== */
describe('R-W5.3 / R-W5.4 — a host-supplied review leaves it alone too', () => {
  let base: string;
  let served: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'vs-served-untouched-host-'));
    served = join(base, 'project');
    await mkdir(served);
    // No origin — which is R-W1.3's second case, and the reason this review has no working
    // copy of its own anywhere. The directory is still a real git working tree with real
    // uncommitted work in it, because "it was never a repository" would make the claim
    // easier than the one the requirement makes.
    await makeServed(served, null);
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('never materialises a tree on the served disk, and leaves the branch and the unsaved work alone', async () => {
    const contentBefore = contentSnapshot(served);
    const gitBefore = await gitState(served);

    const r = router(served, 'a'.repeat(40));
    const results = await fullReview(r);

    // The host really did supply it (R-W1.3), so the assertions below are about a review
    // that happened rather than one that was refused for want of a remote.
    expect(results[0]).toMatchObject({ status: 200, json: { ok: true, source: 'host' } });
    expect(results[0]!.json).not.toHaveProperty('worktree');
    // And it really read files — through the host, at the pinned commit.
    expect(results[5]).toMatchObject({ status: 200, json: { path: 'docs/spec.md', text: '# from the host\n' } });

    expect(contentSnapshot(served)).toEqual(contentBefore);
    expect(await gitState(served)).toEqual(gitBefore);
    // Stronger than the checkout arm: with nothing to check out, no worktree may exist at
    // any point of the review, not merely by the end of it.
    expect(await listMountedWorktrees(served)).toEqual([]);
    expect(everyPath(served)).not.toContain(join('.visual-spec', 'worktrees'));

    const closed = await call(r, 'DELETE', '/pulls/7/mount');
    r.dispose();
    expect(closed).toMatchObject({ status: 200 });
    expect(contentSnapshot(served)).toEqual(contentBefore);
    expect(await gitState(served)).toEqual(gitBefore);
  }, 60_000);
});
