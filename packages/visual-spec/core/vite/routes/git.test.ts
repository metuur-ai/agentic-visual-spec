/**
 * Handler tests for `GET /__vs/git`, `GET /__vs/git/branches` and
 * `POST /__vs/git/checkout`.
 *
 * These drive the handler through `readGitContext`'s injectable `exec` seam
 * rather than through real temporary repositories: `core/git-context.test.ts`
 * and `core/git-branches.test.ts` already cover real repos — plain, subdirectory,
 * linked worktree, detached HEAD, and the byte-identical-file refusal — and
 * duplicating that here would test git, not the route.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitExecutor, GitResult } from '../../git-context';
import { IGNORE_ENTRY } from '../../collaboration/worktree';
import { resolveConfig } from '../../config';
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

const get = (root: string | (() => string), exec: GitExecutor) =>
  handleGitRequest(root, 'GET', '', undefined, { exec });

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

    const post = await handleGitRequest('/srv/repo', 'POST', '', undefined, { exec });
    expect(post.status).toBe(404);
    expect(post.json).toEqual({ error: 'no route: POST /__vs/git' });

    const sub = await handleGitRequest('/srv/repo', 'GET', '/status', undefined, { exec });
    expect(sub.status).toBe(404);
    expect(sub.json).toEqual({ error: 'no route: GET /__vs/git/status' });
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

/* ================================================================== *
 * 5.4 / 5.5 — the branch routes and the configuration gate
 * ================================================================== */

/** A fake repository rich enough for the listing, the status and the change. */
type FakeTree = { head: string; local: string[]; remote?: string[]; dirty?: string[]; origin?: string };

/**
 * A `git` stand-in for one directory that also answers `for-each-ref`, `status` and
 * `checkout`, mutating `tree.head` when a checkout is allowed to run. Every argument
 * vector is recorded, because "checkout was never invoked" is the claim R-5.5 makes
 * and nothing observable afterwards can establish it.
 */
function fakeGit(dir: string, tree: FakeTree) {
  const calls: string[][] = [];
  const exec: GitExecutor = async (args) => {
    calls.push(args);
    if (args[1] !== dir) return fail();
    const cmd = args.slice(2).join(' ');
    if (cmd.startsWith('for-each-ref') && args.at(-1) === 'refs/heads/') {
      return ok(tree.local.map((name) => `${name}\t${name === tree.head ? '*' : ' '}\t\t\n`).join(''));
    }
    if (cmd.startsWith('for-each-ref')) return ok((tree.remote ?? []).map((n) => `origin/${n}\n`).join(''));
    if (cmd === 'status --porcelain -z') return ok((tree.dirty ?? []).map((p) => ` M ${p}\0`).join(''));
    if (args[2] === 'checkout') {
      tree.head = args[3] === '-b' ? (args[4] ?? '') : (args[3] ?? '');
      if (!tree.local.includes(tree.head)) tree.local.push(tree.head);
      return ok('');
    }
    if (cmd === 'rev-parse --abbrev-ref HEAD') return ok(`${tree.head}\n`);
    if (cmd === 'remote get-url origin') return tree.origin ? ok(`${tree.origin}\n`) : fail();
    return fail();
  };
  return { exec, calls };
}

const ENABLED = { allowCheckout: true };

describe('GET /__vs/git/branches', () => {
  it('serves the local branches and the branches of origin (R-5.1, R-5.2)', async () => {
    const { exec } = fakeGit('/srv/repo', { head: 'main', local: ['main', 'topic'], remote: ['main', 'published'] });

    const res = await handleGitRequest('/srv/repo', 'GET', '/branches', undefined, { exec, ...ENABLED });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      local: [
        { name: 'main', current: true },
        { name: 'topic', current: false },
      ],
      remote: ['main', 'published'],
    });
  });

  it('reports a git failure rather than throwing (R-5.11)', async () => {
    const enoent: GitExecutor = async () => ({ stdout: '', exitCode: null });

    const res = await handleGitRequest('/srv/repo', 'GET', '/branches', undefined, { exec: enoent, ...ENABLED });

    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'git-unavailable' });
  });

  it('asks about the root current at request time, not the one it was wired with (R-2.2)', async () => {
    let root = '/srv/first';
    const first = fakeGit('/srv/first', { head: 'main', local: ['main'] });
    const second = fakeGit('/srv/second', { head: 'develop', local: ['develop'] });
    const exec: GitExecutor = (args) => (args[1] === '/srv/first' ? first.exec(args) : second.exec(args));

    const before = await handleGitRequest(() => root, 'GET', '/branches', undefined, { exec, ...ENABLED });
    root = '/srv/second';
    const after = await handleGitRequest(() => root, 'GET', '/branches', undefined, { exec, ...ENABLED });

    expect(before.json).toMatchObject({ local: [{ name: 'main', current: true }] });
    expect(after.json).toMatchObject({ local: [{ name: 'develop', current: true }] });
  });
});

describe('POST /__vs/git/checkout', () => {
  it('refuses a request with no branch, before anything is read (R-5.7)', async () => {
    const { exec, calls } = fakeGit('/srv/repo', { head: 'main', local: ['main', 'topic'] });

    const res = await handleGitRequest('/srv/repo', 'POST', '/checkout', {}, { exec, ...ENABLED });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'missing branch' });
    expect(calls).toEqual([]);
  });

  it('refuses a name that is not a branch git reported, without invoking checkout (R-5.7)', async () => {
    for (const branch of ['-', '--upload-pack=/usr/bin/evil', 'nope']) {
      const { exec, calls } = fakeGit('/srv/repo', { head: 'main', local: ['main', 'topic'] });

      const res = await handleGitRequest('/srv/repo', 'POST', '/checkout', { branch }, { exec, ...ENABLED });

      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'unknown-branch' });
      expect(calls.some((args) => args.includes('checkout'))).toBe(false);
    }
  });

  it('refuses a dirty working tree and reports the paths (R-5.5, R-6.6)', async () => {
    const { exec, calls } = fakeGit('/srv/repo', {
      head: 'main',
      local: ['main', 'topic'],
      dirty: ['docs/spec.md', 'notes/draft.md'],
    });

    const res = await handleGitRequest('/srv/repo', 'POST', '/checkout', { branch: 'topic' }, { exec, ...ENABLED });

    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'dirty', paths: ['docs/spec.md', 'notes/draft.md'] });
    expect(calls.some((args) => args.includes('checkout'))).toBe(false);
    // R-5.6 — the refusal offers the server no escape hatch either.
    expect(calls.map((a) => a.join(' ')).join('\n')).not.toMatch(/stash|--force|--hard/);
  });

  it('returns the context read after the change, not the one it was asked for (R-5.9)', async () => {
    // A real directory, because a successful change re-asserts the ignore entry
    // (R-5.8) and that writes a `.gitignore` for real.
    const dir = await mkdtemp(join(tmpdir(), 'vs-git-route-'));
    const { exec } = fakeGit(dir, {
      head: 'main',
      local: ['main', 'topic'],
      origin: 'https://github.com/acme/widgets.git',
    });

    const res = await handleGitRequest(dir, 'POST', '/checkout', { branch: 'topic' }, { exec, ...ENABLED });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      context: {
        state: 'remote',
        branch: 'topic',
        detached: false,
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        url: 'https://github.com/acme/widgets.git',
      },
    });
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain(IGNORE_ENTRY);
    await rm(dir, { recursive: true, force: true });
  });
});

/* ================================================================== *
 * R-6.3 — absent unless configured, and absent means absent
 * ================================================================== */
describe('R-6.3 — the branch routes are not exposed unless configuration enables them', () => {
  const tree = (): FakeTree => ({ head: 'main', local: ['main', 'topic'], remote: ['main'] });

  it('answers the unknown-route 404 for both, with no configuration at all', async () => {
    const { exec, calls } = fakeGit('/srv/repo', tree());

    const branches = await handleGitRequest('/srv/repo', 'GET', '/branches', undefined, { exec });
    const checkout = await handleGitRequest('/srv/repo', 'POST', '/checkout', { branch: 'topic' }, { exec });

    expect(branches.status).toBe(404);
    expect(checkout.status).toBe(404);
    // Byte-identical to the answer for a path no route ever claimed. A client that
    // could tell "disabled" from "older server" apart is a client that knows there
    // is a working tree behind the flag worth guessing at.
    expect(branches.json).toEqual({ error: 'no route: GET /__vs/git/branches' });
    expect(checkout.json).toEqual({ error: 'no route: POST /__vs/git/checkout' });
    const unclaimed = await handleGitRequest('/srv/repo', 'GET', '/nonsense', undefined, { exec });
    expect(unclaimed.json).toEqual({ error: 'no route: GET /__vs/git/nonsense' });
    // 404, not 403: nothing ran, so nothing was refused.
    expect(calls).toEqual([]);
  });

  it('is off for a configuration that omits the block, and for one that says false', () => {
    expect(resolveConfig({}).git).toEqual({ allowCheckout: false });
    expect(resolveConfig({ git: {} }).git).toEqual({ allowCheckout: false });
    expect(resolveConfig({ git: { allowCheckout: false } }).git).toEqual({ allowCheckout: false });
    expect(resolveConfig({ git: { allowCheckout: true } }).git).toEqual({ allowCheckout: true });
  });

  it('leaves GET /__vs/git answering whether the flag is on or off', async () => {
    const { exec } = fakeGit('/srv/repo', tree());

    for (const options of [{ exec }, { exec, ...ENABLED }]) {
      const res = await handleGitRequest('/srv/repo', 'GET', '', undefined, options);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ state: 'local', branch: 'main' });
    }
  });
});
