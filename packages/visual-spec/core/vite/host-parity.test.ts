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
 * test: `.git` is the repository the git fixture created once, and `.vite` is the
 * dep-optimizer cache the Vite host writes into its own root on a schedule of its
 * own. Neither route touches either, and `.vite` in particular appears whenever the
 * optimizer happens to flush — comparing it would make this suite flaky for a
 * reason that has nothing to do with host parity.
 */
const HARNESS_DIRS = new Set(['.git', '.vite']);

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

    it(`${rel} puts no attestation on the read-only git route`, async () => {
      const text = await code(rel);
      const git = text.indexOf('handleGitRequest(');
      expect(git).toBeGreaterThan(-1);
      // The git route is read-only: it inherits the guard by registration order and
      // has nothing to open up. Attesting there would be cargo-culting the pattern.
      const preceding = text.lastIndexOf('guardRan(req.headers)', git);
      const dispatchOfWrites = text.indexOf('handleFilesRequest(');
      // The only `guardRan` before it, if any, belongs to the write branch above.
      if (preceding > -1) expect(preceding).toBeLessThan(dispatchOfWrites);
    });
  }
});
