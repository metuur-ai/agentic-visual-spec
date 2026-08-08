/**
 * Handler tests for `GET /__vs/git`.
 *
 * These drive the handler through `readGitContext`'s injectable `exec` seam
 * rather than through real temporary repositories: `core/git-context.test.ts`
 * already covers real repos — plain, subdirectory, linked worktree, detached
 * HEAD — and duplicating that here would test git, not the route.
 */
import { describe, expect, it } from 'vitest';
import type { GitExecutor, GitResult } from '../../git-context';
import { handleGitRequest } from './git';

/** What a fake repository answers for the three commands `readGitContext` runs. */
type FakeRepo = { head: string; sha?: string; origin?: string };

const ok = (stdout: string): GitResult => ({ stdout, exitCode: 0 });
const fail = (): GitResult => ({ stdout: '', exitCode: 128 });

/**
 * A `git` stand-in keyed by the directory in `git -C <dir> …`. Anything not in
 * the map is "not a repository" — a non-zero exit, exactly like the real thing.
 */
function fakeExec(repos: Record<string, FakeRepo>): GitExecutor {
  return async (args) => {
    const dir = args[1] ?? '';
    const repo = repos[dir];
    if (!repo) return fail();
    const cmd = args.slice(2).join(' ');
    if (cmd === 'rev-parse --abbrev-ref HEAD') return ok(`${repo.head}\n`);
    if (cmd === 'rev-parse --short HEAD') return repo.sha ? ok(`${repo.sha}\n`) : fail();
    if (cmd === 'remote get-url origin') return repo.origin ? ok(`${repo.origin}\n`) : fail();
    return fail();
  };
}

const get = (root: string | (() => string), exec: GitExecutor) => handleGitRequest(root, 'GET', '', exec);

describe('handleGitRequest', () => {
  it('serves state none when the directory is not a repository (R-2.1)', async () => {
    const res = await get('/srv/plain', fakeExec({}));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ state: 'none' });
  });

  it('serves state local with no url when there is no origin', async () => {
    const res = await get('/srv/repo', fakeExec({ '/srv/repo': { head: 'main' } }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ state: 'local', branch: 'main', detached: false });
  });

  it('serves state local carrying the raw url when it will not parse', async () => {
    const exec = fakeExec({ '/srv/repo': { head: 'main', origin: 'ssh://host:2222/owner/repo.git' } });
    const res = await get('/srv/repo', exec);
    expect(res.json).toEqual({
      state: 'local',
      branch: 'main',
      detached: false,
      url: 'ssh://host:2222/owner/repo.git',
    });
  });

  it('serves state remote with host, owner and repo for a recognised origin', async () => {
    const exec = fakeExec({ '/srv/repo': { head: 'feature/x', origin: 'git@github.com:acme/widgets.git' } });
    const res = await get('/srv/repo', exec);
    expect(res.json).toEqual({
      state: 'remote',
      branch: 'feature/x',
      detached: false,
      url: 'git@github.com:acme/widgets.git',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('serves a detached HEAD as the short sha', async () => {
    const exec = fakeExec({ '/srv/repo': { head: 'HEAD', sha: 'a1b2c3d' } });
    expect(await get('/srv/repo', exec).then((r) => r.json)).toEqual({
      state: 'local',
      branch: 'a1b2c3d',
      detached: true,
    });
  });

  // R-2.4. If the handler cached anything, the second request would repeat the
  // first. The branch changes between two consecutive calls with no delay —
  // which is also why an mtime-keyed cache was the wrong instrument.
  it('reads per request and does not serve from a cache (R-2.4)', async () => {
    let head = 'main';
    const exec: GitExecutor = async (args) => {
      const cmd = args.slice(2).join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return ok(`${head}\n`);
      return fail();
    };

    const first = await get('/srv/repo', exec);
    head = 'release/2.0';
    const second = await get('/srv/repo', exec);

    expect(first.json).toMatchObject({ branch: 'main' });
    expect(second.json).toMatchObject({ branch: 'release/2.0' });
  });

  // R-2.2. The root the handler asks about must be the current one, not the one
  // it was wired with. This is the requirement a closure silently breaks.
  it('reports the new directory after the served root changes (R-2.2)', async () => {
    let root = '/srv/first';
    const exec = fakeExec({
      '/srv/first': { head: 'main', origin: 'https://github.com/acme/first.git' },
      '/srv/second': { head: 'develop', origin: 'https://github.com/acme/second.git' },
    });

    const before = await get(() => root, exec);
    root = '/srv/second';
    const after = await get(() => root, exec);

    expect(before.json).toMatchObject({ repo: 'first', branch: 'main' });
    expect(after.json).toMatchObject({ repo: 'second', branch: 'develop' });
  });

  it('accepts the root as a plain per-call value too (R-2.2)', async () => {
    const exec = fakeExec({
      '/srv/first': { head: 'main' },
      '/srv/second': { head: 'develop' },
    });
    expect(await get('/srv/first', exec).then((r) => r.json)).toMatchObject({ branch: 'main' });
    expect(await get('/srv/second', exec).then((r) => r.json)).toMatchObject({ branch: 'develop' });
  });

  it('404s a non-GET method and an unknown subpath with a JSON body', async () => {
    const exec = fakeExec({ '/srv/repo': { head: 'main' } });

    const post = await handleGitRequest('/srv/repo', 'POST', '', exec);
    expect(post.status).toBe(404);
    expect(post.json).toEqual({ error: 'no route: POST /__vs/git' });

    const sub = await handleGitRequest('/srv/repo', 'GET', '/branches', exec);
    expect(sub.status).toBe(404);
    expect(sub.json).toEqual({ error: 'no route: GET /__vs/git/branches' });
  });

  // R-1.11. `git -C` searches upward, so the repository may sit above the served
  // directory; neither path may appear in what crosses the process boundary.
  it('emits no absolute filesystem path for a repository served from a nested directory', async () => {
    const dir = '/Users/someone/work/acme/docs/specs';
    const exec = fakeExec({ [dir]: { head: 'main', origin: 'https://github.com/acme/widgets.git' } });

    const body = JSON.stringify((await get(dir, exec)).json);
    expect(body).not.toContain('/Users/someone');
    expect(body).not.toContain('/docs/specs');
    expect(body).not.toMatch(/"[^"]*\/Users\//);
    expect(JSON.parse(body)).toMatchObject({ state: 'remote', owner: 'acme', repo: 'widgets' });
  });

  // The handler is a pure function of its arguments: same arguments, same answer,
  // in either order. A module-level cache or a captured root would show up here.
  it('holds no module-level state between requests for different roots', async () => {
    const exec = fakeExec({
      '/srv/a': { head: 'main', origin: 'https://github.com/acme/a' },
      '/srv/b': { head: 'main' },
    });
    const a1 = await get('/srv/a', exec);
    const b = await get('/srv/b', exec);
    const a2 = await get('/srv/a', exec);
    expect(a2.json).toEqual(a1.json);
    expect(b.json).toEqual({ state: 'local', branch: 'main', detached: false });
  });
});
