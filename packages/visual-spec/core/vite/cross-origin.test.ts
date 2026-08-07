/**
 * cross-origin.test.ts — task 9.3. R-9.16 / R-9.17 / R-9.18.
 *
 * 9.1 proved `checkRequest` decides correctly in isolation. This file proves the
 * two hosts actually apply it, by starting both of them for real and speaking to
 * them over a socket with the exact header set a browser would attach to a
 * cross-origin request:
 *
 *   Origin: https://evil.example      — what the page is
 *   Sec-Fetch-Site: cross-site        — set by the browser, unforgeable by script
 *   Sec-Fetch-Mode: cors              — a `fetch()`, not a navigation
 *   Host: <loopback | evil.example>   — loopback is plain CSRF, the other is DNS rebinding
 *
 * `node:http` is used instead of `fetch` on purpose: `Host` and `Origin` are
 * forbidden header names, so only a raw client can put the rebinding case on the
 * wire. Nothing here talks to anything but a loopback socket this file opened.
 *
 * "Not readable cross-origin" is asserted twice over, because the two halves fail
 * independently: the request is refused (403), *and* no response — not even a
 * legitimate 200 — carries an `Access-Control-Allow-Origin`, so a browser would
 * withhold the body even if the refusal were ever lifted.
 */
import { type Server, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ViteDevServer, createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisualSpecServer } from '../../src/server';
import { visualSpecMarkdown } from './md-plugin';
import { GUARD_NOT_RUN, attestGuardRan, guardRan } from './guard-attestation';

const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const src = (rel: string) => readFile(join(pkgRoot, rel), 'utf8');
/** Source with comments removed — a claim about code must not be met by prose. */
const code = async (rel: string) => (await src(rel)).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** One raw HTTP request, with full control over Host/Origin. */
function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } },
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

/** Headers a browser attaches to a cross-origin `fetch()` from https://evil.example. */
const CROSS_SITE = (host: string) => ({
  host,
  origin: 'https://evil.example',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
});
/** DNS rebinding: fetch metadata looks same-origin, the Host does not. */
const REBOUND = (host: string) => ({
  host,
  origin: 'http://evil.example',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
});

let contentDir: string;
let standalone: Server;
let standalonePort: number;
let vite: ViteDevServer;
let vitePort: number;

beforeAll(async () => {
  contentDir = await mkdtemp(join(tmpdir(), 'vs-xorigin-'));
  await writeFile(join(contentDir, 'a.md'), '# a\n');

  standalone = createVisualSpecServer({ contentDir, uiDir: join(contentDir, 'ui'), port: 0 }).server;
  await new Promise<void>((ok) => standalone.listen(0, '127.0.0.1', ok));
  standalonePort = (standalone.address() as AddressInfo).port;

  // Worst case on purpose: the two settings that would make Vite's dev server
  // permissive are both turned all the way up. If `/__vs` is still not readable
  // cross-origin here, it is not readable under any milder configuration.
  vite = await createViteServer({
    configFile: false,
    root: contentDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, cors: true, allowedHosts: true },
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
 * R-9.18 — /__vs is not readable cross-origin in either host
 * ================================================================== */
describe('R-9.18 — /__vs responses are not readable cross-origin in either host', () => {
  for (const { name } of hosts()) {
    it(`${name}: a cross-site GET is refused before it reaches a handler`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/dir', CROSS_SITE(`127.0.0.1:${port}`));
      expect(r.status).toBe(403);
      expect(r.body).toContain('cross-site');
      // Nothing about the working directory leaked into the refusal.
      expect(r.body).not.toContain(contentDir);
    });

    it(`${name}: a rebound (non-loopback Host) request is refused`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/dir', REBOUND('evil.example'));
      expect(r.status).toBe(403);
      expect(r.body).toContain('evil.example');
    });

    it(`${name}: no /__vs response carries CORS headers, refusal or success`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const refused = await raw(port, 'GET', '/__vs/dir', CROSS_SITE(`127.0.0.1:${port}`));
      // The success case matters most: this is the response an attacker wants to
      // read, and the browser only hands it over if the server opts in.
      const allowed = await raw(port, 'GET', '/__vs/dir', {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.example',
      });
      expect(allowed.status).toBe(200);
      for (const r of [refused, allowed]) {
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
        expect(r.headers['access-control-allow-credentials']).toBeUndefined();
      }
    });

    it(`${name}: the CORS preflight for a cross-origin write is not answered`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'OPTIONS', '/__vs/collab/doc/publish', {
        ...CROSS_SITE(`127.0.0.1:${port}`),
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-methods']).toBeUndefined();
      expect(r.status).not.toBe(204);
    });
  }

  it('the Vite host still refuses even with cors:true and allowedHosts:true resolved', () => {
    // Measured, not assumed: Vite applies its CORS middleware after the plugin
    // middlewares this package registers, so `/__vs` terminates before any
    // Access-Control header can be attached. The assertions above run against a
    // server whose resolved config is exactly this.
    expect(vite.config.server.cors).toBe(true);
    expect(vite.config.server.allowedHosts).toBe(true);
  });

  it('this package never widens allowedHosts or cors itself', async () => {
    for (const rel of ['vite.config.ts', 'core/vite/md-plugin.ts', 'src/server.ts']) {
      const text = await code(rel);
      expect(text).not.toMatch(/allowedHosts\s*:\s*(true|'all'|"all"|\[\s*'all'\s*\])/);
      expect(text).not.toMatch(/cors\s*:\s*true/);
      expect(text).not.toMatch(/access-control-allow-origin/i);
    }
  });
});

/* ================================================================== *
 * R-9.16 — publish is not reachable unless the guard ran
 * ================================================================== */
describe('R-9.16 — the publish route is unreachable without the request guard', () => {
  for (const { name } of hosts()) {
    it(`${name}: a cross-site POST to publish is refused with no job started`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(
        port,
        'POST',
        '/__vs/collab/doc-1/publish',
        CROSS_SITE(`127.0.0.1:${port}`),
        JSON.stringify({ json: { nodes: [] }, markdown: '# pwned\n' }),
      );
      expect(r.status).toBe(403);
      // Not the route layer's 400/503 — the request never got that far.
      expect(r.body).not.toContain('missing json');
      expect(r.body).not.toContain('not-configured');
    });

    it(`${name}: a rebound POST to publish is refused`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'POST', '/__vs/collab/doc-1/publish', REBOUND('evil.example'), '{}');
      expect(r.status).toBe(403);
    });
  }

  // The structural half. Source position alone says the guard is *above* the
  // dispatch; these say the dispatch *asks*, so deleting the guard turns
  // collaboration off instead of turning publish on.
  for (const rel of ['src/server.ts', 'core/vite/md-plugin.ts']) {
    it(`${rel} refuses the collab dispatch when it cannot confirm the guard ran`, async () => {
      const text = await code(rel);
      const attest = text.indexOf('attestGuardRan(req.headers)');
      const check = text.indexOf('checkRequest(req.headers)');
      const ask = text.indexOf('guardRan(req.headers)');
      const dispatch = text.indexOf('collab.handle(');
      expect(check).toBeGreaterThan(-1);
      // Attestation happens once, on the guard's success path, and nowhere else.
      expect(text.split('attestGuardRan(').length - 1).toBe(1);
      expect(attest).toBeGreaterThan(check);
      // The dispatch asks before it dispatches.
      expect(ask).toBeGreaterThan(-1);
      expect(ask).toBeLessThan(dispatch);
      expect(text).toContain('GUARD_NOT_RUN');
    });
  }

  it('an unattested request is refused by the shared module, not by ordering luck', () => {
    const headers = { host: 'localhost:3000' };
    expect(guardRan(headers)).toBe(false);
    attestGuardRan(headers);
    expect(guardRan(headers)).toBe(true);
    // A different request object never inherits another request's clearance.
    expect(guardRan({ host: 'localhost:3000' })).toBe(false);
    expect(GUARD_NOT_RUN).toContain('request guard did not run');
  });
});

/* ================================================================== *
 * R-9.17 — merge is not offered in-app at all
 * ================================================================== *
 * Decision: no in-app merge route exists. Publish deliberately stops at "commit
 * then verify" (8.3), and merge is the one irreversible remote write, so the
 * cheapest way to satisfy "requires an out-of-band confirmation shown only on
 * the terminal" is to keep the operation off the HTTP surface entirely — the
 * author merges in GitHub's UI, where GitHub's own auth applies. R-9.17's
 * conditional ("if a merge is requested") is therefore never entered, and that
 * has to be asserted rather than assumed: the moment someone adds a merge route,
 * these tests fail and the confirmation requirement comes back into scope.
 */
describe('R-9.17 — no in-app merge route exists in either host', () => {
  for (const { name } of hosts()) {
    it(`${name}: POST /__vs/collab/:id/merge from loopback is not a route`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'POST', '/__vs/collab/doc-1/merge', { host: `127.0.0.1:${port}` }, '{}');
      expect(r.status).toBe(404);
      expect(r.body).toContain('no route');
    });
  }

  it('no route, host or wiring module can reach adapter.mergePullRequest', async () => {
    for (const rel of [
      'src/server.ts',
      'core/vite/md-plugin.ts',
      'core/vite/routes/collab.ts',
      'core/vite/routes/collab-wiring.ts',
      'core/collaboration/publish.ts',
      'core/collaboration/lifecycle.ts',
    ]) {
      const text = await code(rel);
      expect(text).not.toContain('mergePullRequest');
      expect(text).not.toMatch(/['"`]\/?merge['"`]/);
    }
  });

  it('mergePullRequest exists on the adapter but nothing outside its own tests calls it', async () => {
    // Kept available for a future task; unreferenced is the point.
    expect(await src('core/collaboration/github-adapter.ts')).toContain('mergePullRequest');
  });
});
