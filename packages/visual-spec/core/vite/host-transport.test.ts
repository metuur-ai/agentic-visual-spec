/**
 * host-transport.test.ts — tasks 4.1 and 4.2. R-4.5 / R-4.2.
 *
 * Both stories are about what the *hosts* do around a handler, so neither can be
 * proved by calling a handler. Both servers are started for real and spoken to
 * over a socket, the way cross-origin.test.ts does.
 *
 * R-4.5 has two halves that fail independently: an unimplemented `/__vs/` path
 * must answer 404 JSON, *and* an unknown path outside `/__vs/` must still reach
 * the SPA shell. Asserting only the first would pass on a server that had stopped
 * serving the app at all.
 *
 * R-4.2 cannot yet be observed through a route that reads the body — none exists
 * until 1.2 lands. It is observed through the two things reading the body changes
 * regardless of any route: malformed JSON is rejected by the parser rather than
 * ignored, and the request stream is drained, so the keep-alive connection it
 * arrived on stays usable for the next request.
 */
import { Agent, type Server, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ViteDevServer, createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisualSpecServer } from '../../src/server';
import { visualSpecMarkdown } from './md-plugin';

const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const src = (rel: string) => readFile(join(pkgRoot, rel), 'utf8');

const SHELL_MARKER = '<!--visual-spec-shell-->';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  agent?: Agent,
): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        // Without an explicit agent each request gets its own connection, so one
        // test's socket state cannot decide another's. The keep-alive assertion
        // below passes an agent precisely because reuse is what it measures.
        agent: agent ?? false,
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

let contentDir: string;
let uiDir: string;
let standalone: Server;
let standalonePort: number;
let vite: ViteDevServer;
let vitePort: number;

beforeAll(async () => {
  contentDir = await mkdtemp(join(tmpdir(), 'vs-transport-'));
  await writeFile(join(contentDir, 'a.md'), '# a\n');
  // Both hosts need a real shell on disk, or "did not serve the SPA" would be
  // true for the boring reason that there is no SPA to serve.
  await writeFile(join(contentDir, 'index.html'), `${SHELL_MARKER}<html><body>vite shell</body></html>\n`);
  uiDir = join(contentDir, 'ui');
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, 'index.html'), `${SHELL_MARKER}<html><body>standalone shell</body></html>\n`);

  standalone = createVisualSpecServer({ contentDir, uiDir, port: 0 }).server;
  await new Promise<void>((ok) => standalone.listen(0, '127.0.0.1', ok));
  standalonePort = (standalone.address() as AddressInfo).port;

  vite = await createViteServer({
    configFile: false,
    root: contentDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: visualSpecMarkdown({ contentDir }),
  });
  await vite.listen();
  vitePort = (vite.httpServer?.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((ok) => standalone.close(() => ok()));
  await vite?.close();
});

const hosts = () => [
  { name: 'standalone server', port: standalonePort },
  { name: 'Vite plugin host', port: vitePort },
];

/* ================================================================== *
 * R-4.5 — an unhandled /__vs path is a 404 JSON, not the SPA shell
 * ================================================================== */
describe('R-4.5 — unmatched /__vs paths answer 404 JSON on both hosts', () => {
  for (const { name } of hosts()) {
    it(`${name}: GET /__vs/does-not-exist is 404 with a JSON body`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/does-not-exist', { accept: 'text/html' });
      expect(r.status).toBe(404);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(r.body).not.toContain(SHELL_MARKER);
      expect(JSON.parse(r.body).error).toContain('no route');
    });

    it(`${name}: a nested unknown /__vs path is 404 too, for every method`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      // DELETE carries no body here: the Vite host mishandles a DELETE with one on
      // *every* route, including the ones that predate this test, so sending one
      // would measure that instead of the 404.
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
        const r = await raw(port, method, '/__vs/tomorrows/route/deep', {}, method === 'POST' || method === 'PATCH' ? '{}' : undefined);
        expect(`${method}:${r.status}`).toBe(`${method}:404`);
        expect(r.headers['content-type']).toMatch(/application\/json/);
      }
    });

    it(`${name}: an unknown path outside /__vs still falls back to the SPA shell`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/some/deep/app/route', { accept: 'text/html' });
      expect(r.status).toBe(200);
      expect(r.body).toContain(SHELL_MARKER);
    });

    it(`${name}: the routes that do exist are untouched`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const dir = await raw(port, 'GET', '/__vs/dir');
      expect(dir.status).toBe(200);
      const tree = await raw(port, 'GET', '/__vs/tree');
      expect(tree.status).toBe(200);
      expect(JSON.stringify(JSON.parse(tree.body))).toContain('a.md');
    });
  }
});

/* ================================================================== *
 * R-4.2 — the standalone host parses a JSON body on /__vs/tree
 * ================================================================== */
describe('R-4.2 — the standalone host reads a JSON body for non-GET /__vs/tree', () => {
  it('a POST with malformed JSON is rejected by the parser, not ignored', async () => {
    const r = await raw(standalonePort, 'POST', '/__vs/tree/create', {}, '{ not json');
    // A host that never touched the body could not know the body was malformed.
    expect(r.status).toBe(500);
    expect(r.body).toMatch(/JSON/i);
  });

  it('the Vite host answers the same malformed body the same way (R-4.1)', async () => {
    const r = await raw(vitePort, 'POST', '/__vs/tree/create', {}, '{ not json');
    expect(r.status).toBe(500);
    expect(r.body).toMatch(/JSON/i);
  });

  it('a POST with a valid body drains the stream, so the keep-alive socket survives', async () => {
    // One socket, reused: if the first request's body were left unread, this
    // second request would never get an answer and the test would time out.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const posted = await raw(standalonePort, 'POST', '/__vs/tree/create', {}, JSON.stringify({ path: 'notes/x.md' }), agent);
    expect(posted.status).toBe(404); // no create route yet — 1.2 adds it
    const after = await raw(standalonePort, 'GET', '/__vs/tree', {}, undefined, agent);
    expect(after.status).toBe(200);
    agent.destroy();
  }, 10_000);

  it('GET is unaffected on both hosts', async () => {
    for (const { port } of hosts()) {
      const tree = await raw(port, 'GET', '/__vs/tree');
      expect(tree.status).toBe(200);
      const file = await raw(port, 'GET', '/__vs/tree/file?path=a.md');
      expect(file.status).toBe(200);
      expect(file.body).toContain('# a');
      const missing = await raw(port, 'GET', '/__vs/tree/file');
      expect(missing.status).toBe(400);
      expect(JSON.parse(missing.body).error).toBe('missing path');
    }
  });

  // The wire cannot yet show the body reaching the handler — no non-GET route on
  // this prefix exists until 1.2. What it can show is that both hosts pass one,
  // which is the drift 4.2 exists to close.
  it('both hosts hand handleTree a body argument', async () => {
    const standaloneSrc = await src('src/server.ts');
    const viteSrc = await src('core/vite/md-plugin.ts');
    expect(standaloneSrc).toContain('handleTree(tree, method, sub, query, body)');
    expect(viteSrc).toContain("handleTree(tree, req.method ?? 'GET', pathname, query, body)");
    for (const text of [standaloneSrc, viteSrc]) {
      expect(text).toMatch(/async function handleTree\([^)]*_body\?: Record<string, unknown>\)/);
    }
  });
});
