/**
 * host-parity.test.ts — stories 1.4 / 4.4 / 4.5 of the file-authoring plan and
 * 2.1 / 2.3 of the git-context plan. R-4.1, R-4.3, R-4.4, R-2.3, R-2.5, R-2.6.
 *
 * `bundle-guard.test.ts` asserts the two hosts *import* the shared handlers and
 * declare no copy of their own. That is the cheap guard and it catches the obvious
 * regression, but it reads source: it cannot see a host that slices the prefix one
 * character differently, forgets to read the body, or hands the handler a store
 * rooted somewhere else. Those produce a working import and a different answer.
 *
 * So this file is the live half. Both hosts are started for real against the SAME
 * temporary directory, the same request is put on the wire to each, and the status,
 * the response body and the resulting bytes on disk are compared. The fixture is
 * reset between the two runs, so each host meets an identical starting directory
 * rather than the other host's leftovers — otherwise "identical on-disk result"
 * would be measuring a collision.
 *
 * `node:http` rather than `fetch`, for the same reason `cross-origin.test.ts` uses
 * it: `Host` is a forbidden header name, and the non-loopback rejection cannot be
 * put on the wire any other way.
 */
import { type Server, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { type ViteDevServer, createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisualSpecServer } from '../../src/server';
import { visualSpecMarkdown } from './md-plugin';

const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
/** Source with comments removed — a claim about code must not be met by prose. */
const code = async (rel: string) =>
  (await readFile(join(pkgRoot, rel), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

const run = promisify(execFile);

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: { host: `127.0.0.1:${port}`, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

let fixture: string;
let standalone: Server;
let standalonePort: number;
let vite: ViteDevServer;
let vitePort: number;

/** The sidecar carries a comment on `a.md` so rename's retargeting shows up in the bytes. */
const SIDECAR = JSON.stringify(
  {
    version: 1,
    comments: [
      { id: 'c1', status: 'open', comment: 'tighten this', target: { path: 'a.md', kind: 'file' } },
      { id: 'c2', status: 'open', comment: 'unrelated', target: { path: 'keep.md', kind: 'file' } },
    ],
  },
  null,
  2,
);

/**
 * Put the fixture back to its starting state. The directory itself survives (both
 * servers hold stores rooted at it) and so does `.git`, which the git fixture below
 * created once and neither route writes to.
 */
/**
 * Directories in the fixture that belong to the harness, not to the routes under
 * test: `.git` is the repository the git fixture created once, and no route touches
 * it. `.vite` used to be listed here too — the dep-optimizer cache the Vite host
 * wrote into its own root, which is this fixture — but the host now points
 * `cacheDir` outside the directory it serves (see md-plugin.ts and
 * cache-dir.test.ts), so there is nothing left to exclude. Keeping the exclusion
 * would hide a regression back into the served workspace.
 */
const HARNESS_DIRS = new Set(['.git']);

async function reset(): Promise<void> {
  for (const entry of await readdir(fixture)) {
    if (HARNESS_DIRS.has(entry)) continue;
    await rm(join(fixture, entry), { recursive: true, force: true });
  }
  await writeFile(join(fixture, 'a.md'), '# a\n\noriginal body\n');
  await writeFile(join(fixture, 'keep.md'), '# keep\n');
  await writeFile(join(fixture, 'visual-spec-comments.json'), SIDECAR);
}

/** Every file under the fixture (bar the harness dirs) as path → contents. */
async function snapshot(dir = fixture, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (prefix === '' && HARNESS_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await snapshot(join(dir, entry.name), rel));
    else out[rel] = await readFile(join(dir, entry.name), 'utf8');
  }
  return out;
}

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'vs-parity-'));
  // A real repository, so `GET /__vs/git` has a branch and a remote to report
  // rather than exercising only the "not a repo" answer. If `git` is unavailable
  // the reader answers `{ state: 'none' }` on both hosts, and parity — the claim
  // under test — still holds, so the failure is tolerated rather than skipped.
  try {
    await run('git', ['init', '-b', 'parity-branch'], { cwd: fixture });
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: fixture });
  } catch {
    // no git on this machine — see above
  }
  await reset();

  standalone = createVisualSpecServer({ contentDir: fixture, uiDir: join(fixture, '__ui'), port: 0 }).server;
  await new Promise<void>((ok) => standalone.listen(0, '127.0.0.1', ok));
  standalonePort = (standalone.address() as AddressInfo).port;

  vite = await createViteServer({
    configFile: false,
    root: fixture,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: visualSpecMarkdown({ contentDir: fixture }),
  });
  await vite.listen();
  vitePort = (vite.httpServer?.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((ok) => standalone.close(() => ok()));
  await vite?.close();
  await rm(fixture, { recursive: true, force: true });
});

const hosts = () => [
  { name: 'standalone server', port: standalonePort },
  { name: 'Vite plugin host', port: vitePort },
];

/**
 * Run one request against a host from a freshly reset fixture and report everything
 * an identical request has to reproduce: the status, the parsed body, and the disk.
 */
async function observe(port: number, method: string, path: string, body?: string) {
  await reset();
  const r = await raw(port, method, path, {}, body);
  return {
    status: r.status,
    json: r.body ? (JSON.parse(r.body) as unknown) : null,
    disk: await snapshot(),
  };
}

/** The same request against both hosts, each from the same starting directory. */
async function bothHosts(method: string, path: string, body?: string) {
  const fromStandalone = await observe(standalonePort, method, path, body);
  const fromVite = await observe(vitePort, method, path, body);
  return { fromStandalone, fromVite };
}

/* ================================================================== *
 * R-4.1 — identical create/rename requests, identical answers and disk
 * ================================================================== */
describe('R-4.1 — the write routes behave identically on both hosts', () => {
  const CASES: Array<{ what: string; path: string; body: unknown }> = [
    { what: 'create appends .md to an extensionless path and makes the parents', path: '/__vs/tree/create', body: { path: 'notes/2026/kickoff' } },
    { what: 'create refuses a non-.md extension', path: '/__vs/tree/create', body: { path: 'notes/kickoff.txt' } },
    { what: 'create refuses a missing path', path: '/__vs/tree/create', body: {} },
    { what: 'create refuses a traversal', path: '/__vs/tree/create', body: { path: '../escape.md' } },
    { what: 'create refuses a collision', path: '/__vs/tree/create', body: { path: 'a.md' } },
    { what: 'rename moves the file and retargets its comments', path: '/__vs/tree/rename', body: { from: 'a.md', to: 'renamed.md' } },
    { what: 'rename refuses a missing source', path: '/__vs/tree/rename', body: { from: 'nope.md', to: 'x.md' } },
    { what: 'rename refuses an occupied destination', path: '/__vs/tree/rename', body: { from: 'a.md', to: 'keep.md' } },
  ];

  for (const c of CASES) {
    it(`${c.what} — same status, body and bytes on both hosts`, async () => {
      const { fromStandalone, fromVite } = await bothHosts('POST', c.path, JSON.stringify(c.body));
      expect(fromVite.status).toBe(fromStandalone.status);
      expect(fromVite.json).toEqual(fromStandalone.json);
      expect(fromVite.disk).toEqual(fromStandalone.disk);
    });
  }

  // The parity assertions above would also pass if *both* hosts were broken in the
  // same way — two 404s are identical too. These pin the answers themselves.
  it('create actually creates, with the seed and the parents', async () => {
    const r = await observe(standalonePort, 'POST', '/__vs/tree/create', JSON.stringify({ path: 'notes/2026/kickoff' }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: 'notes/2026/kickoff.md', root: resolve(fixture) });
    expect(r.disk['notes/2026/kickoff.md']).toBe('# kickoff\n\n');
  });

  it('rename actually moves, and carries the review across', async () => {
    const r = await observe(vitePort, 'POST', '/__vs/tree/rename', JSON.stringify({ from: 'a.md', to: 'renamed.md' }));
    expect(r.status).toBe(200);
    expect(r.disk['renamed.md']).toBe('# a\n\noriginal body\n');
    expect(r.disk['a.md']).toBeUndefined();
    const doc = JSON.parse(r.disk['visual-spec-comments.json']) as { comments: Array<{ id: string; target: { path: string } }> };
    expect(doc.comments.find((c) => c.id === 'c1')?.target.path).toBe('renamed.md');
    expect(doc.comments.find((c) => c.id === 'c2')?.target.path).toBe('keep.md');
  });

  it('a refusal costs nothing on disk, on either host', async () => {
    for (const { port } of hosts()) {
      const before = await observe(port, 'GET', '/__vs/tree');
      const refused = await observe(port, 'POST', '/__vs/tree/create', JSON.stringify({ path: 'notes/kickoff.txt' }));
      expect(refused.status).toBe(400);
      expect(refused.disk).toEqual(before.disk);
    }
  });

  it('the read routes on the same prefix are untouched by the branch', async () => {
    await reset();
    for (const { port } of hosts()) {
      const tree = await raw(port, 'GET', '/__vs/tree');
      expect(tree.status).toBe(200);
      expect(tree.body).toContain('a.md');
      const file = await raw(port, 'GET', '/__vs/tree/file?path=a.md');
      expect(file.status).toBe(200);
      expect(file.body).toContain('original body');
      const unknown = await raw(port, 'GET', '/__vs/tree/nope');
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body).error).toBe('no route: GET /__vs/tree/nope');
    }
  });
});

/* ================================================================== *
 * R-2.1 / R-2.3 — GET /__vs/git, one module, both hosts
 * ================================================================== */
describe('R-2.1 / R-2.3 — the git route answers identically on both hosts', () => {
  it('both hosts report the same context for the same directory', async () => {
    const { fromStandalone, fromVite } = await bothHosts('GET', '/__vs/git');
    expect(fromStandalone.status).toBe(200);
    expect(fromVite.status).toBe(200);
    expect(fromVite.json).toEqual(fromStandalone.json);
  });

  it('the reported context describes the fixture repository', async () => {
    const r = await raw(standalonePort, 'GET', '/__vs/git');
    const ctx = JSON.parse(r.body) as { state: string; branch?: string; owner?: string; repo?: string };
    // Tolerant of a machine with no git (see the fixture note), strict otherwise.
    if (ctx.state !== 'none') {
      expect(ctx.branch).toBe('parity-branch');
      expect(ctx.owner).toBe('acme');
      expect(ctx.repo).toBe('widgets');
    }
    // R-1.11: whatever the state, no filesystem path crosses the boundary.
    expect(r.body).not.toContain(fixture);
  });

  it('an unknown subpath under the git mount is a 404 JSON on both hosts', async () => {
    for (const { port } of hosts()) {
      const r = await raw(port, 'GET', '/__vs/git/status');
      expect(r.status).toBe(404);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(JSON.parse(r.body).error).toContain('no route');
    }
  });
});

/* ================================================================== *
 * R-6.3 — with no `git` block configured the branch routes do not exist
 * ================================================================== *
 * The hosts above are built without one, which is the default every user starts
 * from. The answer must be the unclaimed-path 404 of R-2.6 and not a 403: a client
 * that can tell "disabled" from "this server is older than you" is a client that has
 * been told there is a working tree behind the flag.
 */
describe('R-6.3 — the branch routes are absent unless configuration enables them', () => {
  for (const { name } of hosts()) {
    it(`${name}: GET /__vs/git/branches is 404 JSON and POST /__vs/git/checkout with it`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const listing = await raw(port, 'GET', '/__vs/git/branches', { accept: 'text/html' });
      expect(listing.status).toBe(404);
      expect(listing.headers['content-type']).toMatch(/application\/json/);
      expect(listing.body).not.toContain('<html');
      expect(JSON.parse(listing.body).error).toBe('no route: GET /__vs/git/branches');

      const checkout = await raw(port, 'POST', '/__vs/git/checkout', {}, JSON.stringify({ branch: 'parity-branch' }));
      expect(checkout.status).toBe(404);
      expect(JSON.parse(checkout.body).error).toBe('no route: POST /__vs/git/checkout');
    });

    it(`${name}: the reader is not gated — GET /__vs/git still answers`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/git');
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toHaveProperty('state');
    });
  }
});

/* ================================================================== *
 * R-2.6 — a host without the route answers 404 JSON, not the SPA shell
 * ================================================================== */
describe('R-2.6 — an unimplemented /__vs route is a reportable 404, not the app shell', () => {
  /*
   * The literal scenario — a client newer than its server — cannot be built from a
   * test, because there is only one build of each host and the route is in it. What
   * *can* be shown is that the code path such a server would take is the one story
   * 4.1 put in place: the `/__vs` catch-all, which answers for every path no route
   * claimed, without regard to which path it was. So an adjacent unimplemented
   * `/__vs` path stands in for `/__vs/git` on the old build — same handler, same
   * answer — and the wired route is asserted to be 200 right beside it, which is the
   * half that would break if someone "fixed" the 404 by removing the catch-all.
   */
  for (const { name } of hosts()) {
    it(`${name}: an unwired sibling of /__vs/git is 404 JSON and not the shell`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/git-context', { accept: 'text/html' });
      expect(r.status).toBe(404);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(r.body).not.toContain('<html');
      expect(JSON.parse(r.body).error).toContain('no route');
    });

    it(`${name}: the wired /__vs/git is 200 JSON`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/git');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(JSON.parse(r.body)).toHaveProperty('state');
    });
  }
});

/* ================================================================== *
 * R-4.3 / R-2.5 — every new route sits behind the cross-origin guard
 * ================================================================== *
 * `request-guard.ts` rejects `same-site` as well as `cross-site`, so both are put on
 * the wire: a subdomain of a site the user is logged into is a different origin with
 * the same ambient authority, and testing only `cross-site` would leave the half of
 * the check that a sibling-origin page actually meets unproven.
 */
describe('R-4.3 / R-2.5 — the new routes are refused cross-origin, with no disk access', () => {
  const REJECTED: Array<{ label: string; headers: (port: number) => Record<string, string> }> = [
    { label: 'Sec-Fetch-Site: cross-site', headers: (p) => ({ host: `127.0.0.1:${p}`, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }) },
    { label: 'Sec-Fetch-Site: same-site', headers: (p) => ({ host: `127.0.0.1:${p}`, origin: 'https://evil.localhost', 'sec-fetch-site': 'same-site' }) },
    { label: 'a non-loopback Host', headers: () => ({ host: 'evil.example', 'sec-fetch-site': 'same-origin' }) },
  ];

  for (const { name } of hosts()) {
    for (const { label, headers } of REJECTED) {
      it(`${name}: POST /__vs/tree/create with ${label} is refused and writes nothing`, async () => {
        const { port } = hosts().find((h) => h.name === name)!;
        await reset();
        const before = await snapshot();
        const r = await raw(port, 'POST', '/__vs/tree/create', headers(port), JSON.stringify({ path: 'notes/pwned.md' }));
        expect(r.status).toBe(403);
        // Not the handler's own refusal — the request never got that far.
        expect(r.body).not.toContain('create:');
        expect(await snapshot()).toEqual(before);
      });

      it(`${name}: POST /__vs/tree/rename with ${label} is refused and moves nothing`, async () => {
        const { port } = hosts().find((h) => h.name === name)!;
        await reset();
        const before = await snapshot();
        const r = await raw(port, 'POST', '/__vs/tree/rename', headers(port), JSON.stringify({ from: 'a.md', to: 'pwned.md' }));
        expect(r.status).toBe(403);
        expect(r.body).not.toContain('rename:');
        expect(await snapshot()).toEqual(before);
      });

      it(`${name}: GET /__vs/git with ${label} is refused`, async () => {
        const { port } = hosts().find((h) => h.name === name)!;
        const r = await raw(port, 'GET', '/__vs/git', headers(port));
        expect(r.status).toBe(403);
        expect(r.body).not.toContain('state');
      });
    }
  }
});

/* ================================================================== *
 * R-4.4 — the write dispatch proves the guard ran, it does not assume it
 * ================================================================== */
describe('R-4.4 — the write routes refuse unless the guard provably ran', () => {
  /*
   * Position in the source says the guard is *above* the dispatch. That is true right
   * up until someone reorders the file, and it is invisible at runtime. So these
   * assert the dispatch *asks* — exactly what `cross-origin.test.ts` asserts for the
   * collaboration dispatch — so that deleting the guard turns file creation off
   * rather than turning it open.
   */
  for (const rel of ['src/server.ts', 'core/vite/md-plugin.ts']) {
    it(`${rel} asks guardRan before handing a request to handleFilesRequest`, async () => {
      const text = await code(rel);
      const check = text.indexOf('checkRequest(req.headers)');
      const dispatch = text.indexOf('handleFilesRequest(');
      expect(check).toBeGreaterThan(-1);
      expect(dispatch).toBeGreaterThan(-1);
      // The nearest `guardRan(req.headers)` above the dispatch, and there is one.
      const ask = text.lastIndexOf('guardRan(req.headers)', dispatch);
      expect(ask).toBeGreaterThan(check);
      expect(ask).toBeLessThan(dispatch);
      // Nothing between the two but the refusal it produces.
      expect(text.slice(ask, dispatch)).toContain('GUARD_NOT_RUN');
    });

    it(`${rel} does not attest the guard anywhere but on its success path`, async () => {
      const text = await code(rel);
      expect(text.split('attestGuardRan(').length - 1).toBe(1);
      expect(text.indexOf('attestGuardRan(req.headers)')).toBeGreaterThan(text.indexOf('checkRequest(req.headers)'));
    });

    it(`${rel} attests the guard before dispatching a git write`, async () => {
      const text = await code(rel);
      const git = text.indexOf('handleGitRequest(');
      expect(git).toBeGreaterThan(-1);
      // This assertion used to require the opposite, on the grounds that the git
      // route was read-only. That was true through Units 1–4 and stopped being true
      // when `POST /__vs/git/checkout` (R-5.5) landed — a route that changes the
      // user's working tree. The stale test would have kept the omission green, so it
      // is inverted rather than deleted: the record of why matters more than the line.
      const dispatchOfWrites = text.indexOf('handleFilesRequest(');
      expect(dispatchOfWrites).toBeGreaterThan(-1);
      // The attestation guarding the git dispatch is the last one before it, and it
      // must belong to the git block rather than to the file-write branch above.
      const preceding = text.lastIndexOf('guardRan(req.headers)', git);
      expect(preceding).toBeGreaterThan(dispatchOfWrites);
      // And it must be reached only for a write — a GET must not be made to attest.
      expect(text.slice(preceding - 220, preceding)).toMatch(/!==\s*'GET'/);
    });
  }
});

/* ================================================================== *
 * 5.4 — GET /__vs/git/branches and POST /__vs/git/checkout, both hosts
 * ================================================================== *
 * A second pair of hosts, because the flag is a startup value and the pair above is
 * deliberately built without it (R-6.3). They serve their own repository — two
 * branches, a remote, and a working tree this suite controls — so a `checkout` that
 * really runs cannot disturb the fixture the rest of the file measures on disk.
 */
describe('5.4 — the branch routes answer identically on both hosts', () => {
  let repo: string;
  let hasGit = true;
  let branchStandalone: Server;
  let branchStandalonePort: number;
  let branchVite: ViteDevServer;
  let branchVitePort: number;

  /** Put the repository back on `main` with nothing uncommitted. */
  async function onMainAndClean(): Promise<void> {
    await run('git', ['checkout', '-q', '--force', 'main'], { cwd: repo });
    await run('git', ['clean', '-qfd'], { cwd: repo });
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vs-branch-parity-'));
    try {
      await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
      await run('git', ['config', 'user.name', 'Visual Spec Test'], { cwd: repo });
      await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: repo });
      await writeFile(join(repo, 'a.md'), '# a\n');
      await run('git', ['add', '-A'], { cwd: repo });
      await run('git', ['commit', '-qm', 'first'], { cwd: repo });
      await run('git', ['branch', 'topic'], { cwd: repo });
    } catch {
      // No git on this machine. The assertions below are conditional on this flag
      // rather than skipped, matching the tolerance the fixture above already has.
      hasGit = false;
    }

    const config = { git: { allowCheckout: true } };
    branchStandalone = createVisualSpecServer({ contentDir: repo, uiDir: join(repo, '__ui'), port: 0, config }).server;
    await new Promise<void>((ok) => branchStandalone.listen(0, '127.0.0.1', ok));
    branchStandalonePort = (branchStandalone.address() as AddressInfo).port;

    branchVite = await createViteServer({
      configFile: false,
      root: repo,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: visualSpecMarkdown({ contentDir: repo, config }),
    });
    await branchVite.listen();
    branchVitePort = (branchVite.httpServer?.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((ok) => branchStandalone.close(() => ok()));
    await branchVite?.close();
    await rm(repo, { recursive: true, force: true });
  });

  const branchHosts = () => [
    { name: 'standalone server', port: branchStandalonePort },
    { name: 'Vite plugin host', port: branchVitePort },
  ];

  it('both hosts list the same branches (R-5.1, R-5.2, R-2.3)', async () => {
    if (!hasGit) return;
    await onMainAndClean();
    const bodies: unknown[] = [];
    for (const { port } of branchHosts()) {
      const r = await raw(port, 'GET', '/__vs/git/branches');
      expect(r.status).toBe(200);
      bodies.push(JSON.parse(r.body));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({
      local: [
        { name: 'main', current: true },
        { name: 'topic', current: false },
      ],
      remote: [],
    });
  });

  it('both hosts refuse the same dirty working tree, with the same paths (R-5.5)', async () => {
    if (!hasGit) return;
    const answers: Array<{ status: number; json: unknown }> = [];
    for (const { port } of branchHosts()) {
      await onMainAndClean();
      await writeFile(join(repo, 'unsaved.md'), '# unsaved\n');
      const r = await raw(port, 'POST', '/__vs/git/checkout', {}, JSON.stringify({ branch: 'topic' }));
      answers.push({ status: r.status, json: JSON.parse(r.body) });
      // R-5.5 in the only form that matters: HEAD did not move.
      const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(stdout.trim()).toBe('main');
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]).toEqual({ status: 409, json: { error: 'dirty', paths: ['unsaved.md'] } });
  });

  it('both hosts change the branch from a clean tree and report the fresh context (R-5.9)', async () => {
    if (!hasGit) return;
    const answers: Array<{ status: number; json: unknown }> = [];
    for (const { port } of branchHosts()) {
      await onMainAndClean();
      const r = await raw(port, 'POST', '/__vs/git/checkout', {}, JSON.stringify({ branch: 'topic' }));
      answers.push({ status: r.status, json: JSON.parse(r.body) });
      const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(stdout.trim()).toBe('topic');
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]).toEqual({
      status: 200,
      json: {
        context: {
          state: 'remote',
          branch: 'topic',
          detached: false,
          host: 'github.com',
          owner: 'acme',
          repo: 'widgets',
          url: 'git@github.com:acme/widgets.git',
        },
      },
    });
    // R-5.8 — the change wrote nothing into the working tree at all. The ignore entry is
    // ensured at mount, into `.git/info/exclude`, which a branch change cannot un-ignore,
    // so neither host has any reason to touch `.gitignore` here — and neither does.
    await expect(readFile(join(repo, '.gitignore'), 'utf8')).rejects.toThrow();
    await onMainAndClean();
  });

  it('both hosts reject a name the repository does not have, and emit no path (R-5.7, R-5.10)', async () => {
    if (!hasGit) return;
    for (const { port } of branchHosts()) {
      await onMainAndClean();
      for (const branch of ['-', '--upload-pack=/usr/bin/evil', 'does-not-exist']) {
        const r = await raw(port, 'POST', '/__vs/git/checkout', {}, JSON.stringify({ branch }));
        expect(r.status).toBe(400);
        expect(JSON.parse(r.body)).toEqual({ error: 'unknown-branch' });
        expect(r.body).not.toContain(repo);
      }
      const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(stdout.trim()).toBe('main');
    }
  });
});

/* ================================================================== *
 * R-W5.7 — reviewing without a clone is the same on both hosts
 * ================================================================== */
/**
 * Story 5.4, the live half. `bundle-guard.test.ts` reads both hosts' source and asserts
 * each dispatches `/__vs/collab/*` into `createCollabRoutes` and builds no review source of
 * its own; that catches a pasted-in copy, and nothing else. It cannot see a host that
 * slices the `/__vs/collab` prefix one character differently, forgets to read the POST
 * body, or never registers the middleware at all — each of which imports cleanly and
 * answers differently.
 *
 * So both servers are started for real, against one directory, and driven through the same
 * review requests. Every answer must match: status and body, and the served directory
 * afterwards.
 *
 * WHY THESE REQUESTS AND NOT A REVIEW OF A REAL PULL REQUEST. Everything past the gate
 * needs a GitHub credential, and a test that reaches for one answers differently depending
 * on whose machine it runs on — which is the opposite of a parity claim. What is left is
 * everything decided *before* the credential: the repository-scoped route form itself, the
 * refusals R-W3.1 and R-W3.7 specify, and the availability verdict every route in the
 * family passes through. Those are the parts a host can plausibly get wrong on its own.
 * The credentialed half is driven against the router directly, with an injected adapter, in
 * `routes/collab.repo-scoped.test.ts` and `routes/collab.pulls.test.ts` — one router, so
 * one behaviour, which is what `routes-host-agnostic.test.ts` asserts structurally.
 *
 * Collaboration is left unconfigured on BOTH hosts on purpose. The Vite host infers a
 * repository from the served directory's `origin` and the standalone host does not, so a
 * fixture with a remote would be comparing two different configurations and calling the
 * difference a host-specific implementation. `VS_NO_COLLAB` is the switch that exists for
 * exactly this, and it makes the pair comparable — which R-W5.1 then also covers: with no
 * collaboration configured, both hosts answer as they did before this feature.
 */
describe('R-W5.7 — the review routes answer identically on both hosts', () => {
  let reviewDir: string;
  let reviewStandalone: Server;
  let reviewStandalonePort: number;
  let reviewVite: ViteDevServer;
  let reviewVitePort: number;

  beforeAll(async () => {
    reviewDir = await mkdtemp(join(tmpdir(), 'vs-review-parity-'));
    await writeFile(join(reviewDir, 'README.md'), '# served\n');

    reviewStandalone = createVisualSpecServer({ contentDir: reviewDir, uiDir: join(reviewDir, '__ui'), port: 0 }).server;
    await new Promise<void>((ok) => reviewStandalone.listen(0, '127.0.0.1', ok));
    reviewStandalonePort = (reviewStandalone.address() as AddressInfo).port;

    // Set only around the Vite host's construction, because that is the only host that
    // reads it, and restored immediately so no later suite inherits it.
    const previous = process.env.VS_NO_COLLAB;
    process.env.VS_NO_COLLAB = '1';
    try {
      reviewVite = await createViteServer({
        configFile: false,
        root: reviewDir,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
        plugins: visualSpecMarkdown({ contentDir: reviewDir }),
      });
      await reviewVite.listen();
    } finally {
      if (previous === undefined) delete process.env.VS_NO_COLLAB;
      else process.env.VS_NO_COLLAB = previous;
    }
    reviewVitePort = (reviewVite.httpServer?.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((ok) => reviewStandalone.close(() => ok()));
    await reviewVite?.close();
    await rm(reviewDir, { recursive: true, force: true });
  });

  const reviewHosts = () => [
    { name: 'standalone server', port: reviewStandalonePort },
    { name: 'Vite plugin host', port: reviewVitePort },
  ];

  /**
   * The same review request put on the wire to each host, from the same directory, with
   * the directory read back afterwards. A review may not write to the served directory
   * (R-W2.9 / R-W5.3), so the disk is part of the answer rather than a separate claim.
   */
  async function bothReviewHosts(method: string, path: string) {
    const answers = [];
    for (const { name, port } of reviewHosts()) {
      const before = await snapshot(reviewDir);
      const r = await raw(port, method, `/__vs/collab${path}`);
      answers.push({
        name,
        status: r.status,
        json: r.body ? (JSON.parse(r.body) as unknown) : null,
        disk: await snapshot(reviewDir),
        before,
      });
    }
    return answers;
  }

  /*
   * Every route a review travels through, on the form story 3.1 introduced and the legacy
   * one it left in place. The list is the point: R-W5.7 is about the whole behaviour, and a
   * host that dispatched four of these and dropped the fifth would pass any one of them.
   */
  const REVIEW_REQUESTS: Array<{ what: string; method: string; path: string }> = [
    { what: 'listing a repository’s pull requests', method: 'GET', path: '/repos/acme/widgets/pulls' },
    { what: 'opening a review', method: 'POST', path: '/repos/acme/widgets/pulls/7/mount' },
    { what: 'the changed paths', method: 'GET', path: '/repos/acme/widgets/pulls/7/files' },
    { what: 'one directory of the tree', method: 'GET', path: '/repos/acme/widgets/pulls/7/tree?path=' },
    { what: 'one file of the review', method: 'GET', path: '/repos/acme/widgets/pulls/7/raw?path=README.md' },
    { what: 'the pull request description', method: 'GET', path: '/repos/acme/widgets/pulls/7/description' },
    { what: 'the held review comments', method: 'GET', path: '/repos/acme/widgets/pulls/7/drafts' },
    { what: 'the legacy form of the listing', method: 'GET', path: '/pulls' },
    { what: 'a path naming half a repository', method: 'GET', path: '/repos/acme/pulls' },
    { what: 'a repository identifier in encoded traversal spelling', method: 'GET', path: '/repos/acme/%2e%2e/pulls' },
    { what: 'a repository name with a character a repository name cannot have', method: 'GET', path: '/repos/acme/wid~gets/pulls' },
    { what: 'a pull number that is not one', method: 'GET', path: '/repos/acme/widgets/pulls/abc/tree' },
  ];

  for (const request of REVIEW_REQUESTS) {
    it(`${request.what} — same status and body on both hosts`, async () => {
      const [fromStandalone, fromVite] = await bothReviewHosts(request.method, request.path);
      expect(fromVite!.status).toBe(fromStandalone!.status);
      expect(fromVite!.json).toEqual(fromStandalone!.json);
      // A review writes nothing to the directory it is served from, on either host.
      expect(fromStandalone!.disk).toEqual(fromStandalone!.before);
      expect(fromVite!.disk).toEqual(fromVite!.before);
    });
  }

  /*
   * The parity assertions above would pass just as happily if both hosts answered 404 to
   * everything — two identical wrong answers are identical. These pin the answers.
   */
  it('answers the repository-scoped review family on both hosts, refusing only for want of a credential', async () => {
    for (const { name, port } of reviewHosts()) {
      const r = await raw(port, 'GET', '/__vs/collab/repos/acme/widgets/pulls');
      // 503 and not 404: the route EXISTS on both hosts and was reached; what it lacks is
      // a configured repository, and it says so in the words the UI already renders.
      expect(r.status, name).toBe(503);
      expect(JSON.parse(r.body), name).toMatchObject({ available: false, reason: 'not-configured' });
    }
  });

  it('refuses a path naming no repository, and a malformed one, in the two different ways (R-W3.1, R-W3.7)', async () => {
    for (const { name, port } of reviewHosts()) {
      // A path that names no repository is a route that does not exist.
      const missing = await raw(port, 'GET', '/__vs/collab/repos/acme/pulls');
      expect(missing.status, name).toBe(404);
      // A path that names something in the repository position that is not a repository is
      // a request that was understood and is malformed — 400, carrying the segment.
      const malformed = await raw(port, 'GET', '/__vs/collab/repos/acme/wid~gets/pulls');
      expect(malformed.status, name).toBe(400);
      expect(JSON.parse(malformed.body).error, name).toBe('invalid repository: acme/wid~gets');
    }
  });

  /*
   * WHAT THE WIRE DOES TO `%2e%2e` BEFORE THE ROUTER EVER SEES IT, on both hosts alike.
   *
   * `repoSegment` decodes then refuses `..` (R-W3.7), and that is the router's own guard —
   * asserted where it lives, in `routes/collab.repo-scoped.test.ts`, by calling `handle`
   * directly. Over HTTP it is never reached: both hosts read `new URL(req.url, …).pathname`,
   * and WHATWG URL parsing decodes `%2e` and then removes double-dot segments, so
   * `/repos/acme/%2e%2e/pulls` arrives as `/repos/pulls` — a path that names no repository,
   * which is a 404.
   *
   * Recorded rather than left as a surprising line in the table above, because the two
   * layers refuse the same input for two different reasons and somebody comparing them will
   * otherwise conclude one of them is broken. Both hosts agree, which is the R-W5.7 claim;
   * neither normalises it into a repository, which is the R-W3.7 one.
   */
  it('never lets an encoded traversal reach a repository, and both hosts lose it at the same place', async () => {
    for (const { name, port } of reviewHosts()) {
      const r = await raw(port, 'GET', '/__vs/collab/repos/acme/%2e%2e/pulls');
      expect(r.status, name).toBe(404);
      expect(r.body, name).not.toContain('..');
    }
  });
});
