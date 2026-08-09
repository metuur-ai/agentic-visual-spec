/**
 * git-write-attestation.test.ts — the fail-closed half of the git write route
 * (R-5.5 under R-2.3, by the argument in `core/vite/guard-attestation.ts`).
 *
 * `host-parity.test.ts` asserts the *source* asks `guardRan` before dispatching a git
 * write. That is a claim about text, and text is exactly what a refactor rearranges.
 * This file asserts the behaviour instead, by breaking the attestation for real:
 * `attestGuardRan` is replaced with a no-op, which is what a host that lost its guard
 * — or moved it below the dispatch — looks like from the dispatch's point of view.
 * The request guard itself still runs and still passes, so the only thing missing is
 * the mark.
 *
 * With that mark gone, the requirement is that the write breaks LOUDLY (500) rather
 * than opening quietly, on both hosts, while the reads — which open nothing — keep
 * answering. `POST /__vs/git/checkout` is the one route in this package that changes
 * the user's own working tree, so it is the one that cannot rest on registration
 * order.
 *
 * `node:http` rather than `fetch`, for the reason the sibling suites give: `Host` is
 * a forbidden header name and these hosts are addressed by it.
 */
import { type Server, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ViteDevServer, createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createVisualSpecServer } from '../../src/server';
import { visualSpecMarkdown } from './md-plugin';
import { GUARD_NOT_RUN } from './guard-attestation';

// Only the mark is removed. `guardRan` and `GUARD_NOT_RUN` stay real, because what is
// being measured is what the dispatch does when it cannot confirm the guard — not
// what a stubbed dispatch would say. `vi.mock` is hoisted above the imports above, so
// both hosts get the no-op.
vi.mock('./guard-attestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guard-attestation')>()),
  attestGuardRan: () => {},
}));

type Reply = { status: number; body: string };

function raw(port: number, method: string, path: string, body?: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

let contentDir: string;
let standalone: Server;
let standalonePort: number;
let vite: ViteDevServer;
let vitePort: number;

beforeAll(async () => {
  contentDir = await mkdtemp(join(tmpdir(), 'vs-git-attest-'));

  // The flag is on, so the checkout route really exists. With it off (R-6.3) a
  // refusal would prove only that nothing serves the path.
  const config = { git: { allowCheckout: true } };
  standalone = createVisualSpecServer({ contentDir, uiDir: join(contentDir, 'ui'), port: 0, config }).server;
  await new Promise<void>((ok) => standalone.listen(0, '127.0.0.1', ok));
  standalonePort = (standalone.address() as AddressInfo).port;

  vite = await createViteServer({
    configFile: false,
    root: contentDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: visualSpecMarkdown({ contentDir, config }),
  });
  await vite.listen();
  vitePort = (vite.httpServer?.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((ok) => standalone.close(() => ok()));
  await vite?.close();
  await rm(contentDir, { recursive: true, force: true });
});

const hosts = () => [
  { name: 'standalone server', port: standalonePort },
  { name: 'Vite plugin host', port: vitePort },
];

describe('a git write is refused when the guard cannot be confirmed, on both hosts', () => {
  for (const { name } of hosts()) {
    it(`${name}: POST /__vs/git/checkout answers 500 GUARD_NOT_RUN and never reaches the handler`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'POST', '/__vs/git/checkout', JSON.stringify({ branch: 'topic' }));

      expect(r.status).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ error: GUARD_NOT_RUN });
      // Fail closed, not open: none of the handler's own answers came back, so the
      // request stopped at the dispatch rather than being served and refused later.
      for (const handlerAnswer of ['missing branch', 'unknown-branch', 'dirty', 'context', 'git-failed']) {
        expect(r.body).not.toContain(handlerAnswer);
      }
      expect(r.body).not.toContain(contentDir);
    });

    it(`${name}: every non-GET under the prefix is refused, not just the one that is a route`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      // The guard is on the method, not on the path: a write to a path no route
      // claims must not get further than one to a path a route does.
      const r = await raw(port, 'POST', '/__vs/git/nonsense', '{}');
      expect(r.status).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ error: GUARD_NOT_RUN });
      expect(r.body).not.toContain('no route');
    });

    it(`${name}: GET /__vs/git still answers without any attestation`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/git');

      expect(r.status).toBe(200);
      // A directory that is not a repository — the read ran and reported (R-1.2).
      expect(JSON.parse(r.body)).toEqual({ state: 'none' });
    });

    it(`${name}: GET /__vs/git/branches still reaches its handler without any attestation`, async () => {
      const { port } = hosts().find((h) => h.name === name)!;
      const r = await raw(port, 'GET', '/__vs/git/branches');

      // Not a repository, so the listing fails — but it fails as the *handler's*
      // answer (R-5.11), which is the proof the read was never gated.
      expect(r.status).toBe(500);
      expect(r.body).not.toContain(GUARD_NOT_RUN);
      expect(['git-failed', 'git-unavailable']).toContain((JSON.parse(r.body) as { error: string }).error);
    });
  }
});
