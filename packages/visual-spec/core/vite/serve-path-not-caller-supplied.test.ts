/**
 * serve-path-not-caller-supplied.test.ts — R-W5.6: the directory this server serves is
 * chosen by a human in the operating system's own folder chooser, and by nothing else.
 *
 * WHY THIS REQUIREMENT EXISTS AT ALL, GIVEN NOTHING IMPLEMENTS THE OPPOSITE. It is the
 * guard against a *withdrawn design* rather than against a live bug. An earlier shape of
 * this feature provisioned a managed workspace and re-rooted the server into it, which
 * makes "which directory do you serve?" a thing a caller says. That design did not land,
 * and the whole point of the source-resolution design that replaced it is that nothing
 * needs the served directory to change any more. So this file exists to make the absence
 * durable: a requirement whose implementation is "there is no such code path" is exactly
 * the kind that gets re-added by someone solving a nearby problem, and it will look like a
 * one-line convenience when they do.
 *
 * THE THREAT IS CONCRETE, NOT CEREMONIAL. `/__vs` is an unauthenticated server on
 * localhost. Its write routes (`/__vs/tree/create`, `/__vs/tree/rename`, the collaboration
 * routes' drafts) are all rooted at the served directory, and every containment check in
 * `tree-store.ts` is relative to it. A caller that can move the root does not need to
 * escape containment — it redefines what the root contains. One request re-rooting the
 * server at `/` turns every path check in the package into a check against nothing.
 *
 * TWO LAYERS, BECAUSE NEITHER ALONE IS THE CLAIM.
 *
 *   The STATIC layer reads both hosts and asserts the root is assigned from exactly one
 *   expression, `pickDirectoryNative`'s result, and that the picker is handed the current
 *   root rather than anything off a request. This is what catches the regression at the
 *   moment it is written, and it is the only layer that can say "and from nowhere else" —
 *   a behavioural test can only probe the spellings somebody thought of.
 *
 *   The BEHAVIOURAL layer runs the real production server and tries the spellings anyway,
 *   because the static layer is a set of regexes over a file and a route added in a shape
 *   they do not match is precisely the failure they cannot report.
 *
 * WHY `POST /__vs/dir/pick` IS NOT PROBED BEHAVIOURALLY. It spawns the platform's folder
 * chooser — `osascript` on macOS — and a test that hits it either blocks on a dialog a
 * human has to dismiss or passes for the accidental reason that no picker is installed.
 * The route is therefore covered statically, which is also the stronger coverage: the
 * question is not "what does the picker answer" but "is its answer the only thing that can
 * set the root", and that is a claim about the code, not about the dialog.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVisualSpecServer } from '../../src/server';

const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** The two hosts. Both serve `/__vs/dir`, and both must answer this requirement alike. */
const HOSTS = ['src/server.ts', 'core/vite/md-plugin.ts'];

/** Source with comments removed — a claim about code must not be met by prose. */
const code = async (rel: string) => (await readFile(join(pkgRoot, rel), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/* ================================================================== *
 * The static layer — one source for the root, in both hosts
 * ================================================================== */
describe('R-W5.6 — the served root is assigned from the native picker and nothing else', () => {
  it.each(HOSTS)('%s re-roots only from the picker result', async (host) => {
    const text = await code(host);

    // The picker is reached, so the "nothing sets the root" degenerate reading is out.
    expect(text).toMatch(/import \{[^}]*pickDirectoryNative[^}]*\} from '[^']*native-pick'/);

    /*
     * Exactly one CALL, and its argument is the picker's own answer. The count matters as
     * much as the shape: a second call site is a second answer to "where does the root
     * come from", and matching only `setRoot(picked.path)` would pass happily alongside a
     * `setRoot(body.root)` three lines further down. The declaration is spelled
     * `const setRoot = (dir: string) =>` in both hosts, so it is not one of these matches
     * — and it is asserted separately, or the count could be satisfied by there being no
     * re-rooting mechanism at all.
     */
    expect(text, `${host}: setRoot is declared`).toMatch(/const setRoot\s*=/);
    const setRootCalls = [...text.matchAll(/setRoot\(/g)];
    expect(setRootCalls.length, `${host}: setRoot call sites`).toBe(1);
    expect(text).toMatch(/setRoot\(picked\.path\)/);

    // And the picker is seeded from the CURRENT root — a starting location for the dialog,
    // never a directory a caller named. `existingDir` in `native-pick.ts` walks this up to
    // something that exists and falls back to `$HOME`; it is a hint, and it is not what the
    // picker returns.
    expect(text).toMatch(/pickDirectoryNative\((?:specsRoot|contentDir)\)/);
  });

  it.each(HOSTS)('%s never derives a directory from a request body or query', async (host) => {
    const text = await code(host);
    /*
     * The shapes the withdrawn design would reappear in. Each is a *specific* way a caller
     * could name a directory, so a failure here reads as "this is the line" rather than as
     * "something about directories changed".
     */
    const FORBIDDEN: Array<[string, RegExp]> = [
      ['setRoot from a request', /setRoot\(\s*(?:body|query|req|url|params|input)\b/],
      ['the root assigned from a request', /\b(?:specsRoot|contentDir|root)\s*=\s*(?:body|query|req|url|params)\b/],
      ['a caller-named directory read off the body', /\bbody\??\.(?:root|dir|directory|cwd|workspace|servePath|contentDir)\b/],
      ['a caller-named directory read off the query', /\bquery\??\.(?:root|dir|directory|cwd|workspace|servePath|contentDir)\b/],
      ['a resolve() seeded from a request', /resolve\(\s*(?:body|query|req)\b/],
    ];
    for (const [why, pattern] of FORBIDDEN) {
      expect(`${host}: ${why}: ${pattern.test(text)}`).toBe(`${host}: ${why}: false`);
    }
  });

  it.each(HOSTS)('%s roots the review at the served directory, not at a parameter', async (host) => {
    /*
     * The other half of the same property, and the one this change could actually have
     * broken. `baseDir` is where a review mounts its checkout and holds its comments, so a
     * caller-supplied `baseDir` is a caller-supplied serve path wearing a different name.
     * Both hosts must pass a thunk over their own root variable — a thunk because a re-root
     * has to be picked up on the next request, and their own variable because there is
     * nowhere else it may come from.
     */
    const text = await code(host);
    expect(text).toMatch(/baseDir:\s*\(\)\s*=>\s*(?:specsRoot|contentDir)\b/);
    expect(text).not.toMatch(/baseDir:\s*\(\)\s*=>\s*(?:body|query|req)\b/);
  });

  it('detects a host that took the directory from the caller', async () => {
    /*
     * The negative control. Every assertion above is an absence, and absences pass just as
     * well when the pattern is wrong as when the code is right. This is the diff the
     * withdrawn design would have produced, run through the same rules.
     */
    const regressed = `
      if (method === 'POST' && sub === '/open') {
        setRoot(resolve(body.root));
        return sendJson(res, 200, { root: specsRoot });
      }
    `;
    expect(/setRoot\(\s*(?:body|query|req|url|params|input)\b/.test(regressed) || /resolve\(\s*(?:body|query|req)\b/.test(regressed)).toBe(true);
    // One more call site than the single legitimate one, which is what the count catches.
    expect([...regressed.matchAll(/setRoot\(/g)].length).toBe(1);
    expect(/\bbody\??\.(?:root|dir|directory|cwd|workspace|servePath|contentDir)\b/.test(regressed)).toBe(true);
  });
});

/* ================================================================== *
 * The behavioural layer — the real server refuses every other spelling
 * ================================================================== */
describe('R-W5.6 — a running server accepts no directory from a caller', () => {
  let served: string;
  let elsewhere: string;
  let server: Server;
  let port: number;

  function raw(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
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

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'vs-serve-path-'));
    served = join(base, 'served');
    elsewhere = join(base, 'elsewhere');
    await mkdir(served, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(served, 'a.md'), '# served\n');
    // A recognisable file in a directory the server was never pointed at. If any probe
    // below re-roots the server, this is what it starts serving.
    await writeFile(join(elsewhere, 'SECRET.md'), '# somewhere the user never chose\n');

    server = createVisualSpecServer({ contentDir: served, uiDir: join(served, '__ui'), port: 0 }).server;
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(resolve(served, '..'), { recursive: true, force: true });
  });

  /**
   * Every spelling a caller might reach for. `/pick` is deliberately absent — see the
   * header — and its absence is why the static layer above exists.
   */
  const PROBES: Array<{ label: string; method: string; path: string; body?: unknown }> = [
    { label: 'POST /__vs/dir with a root', method: 'POST', path: '/__vs/dir', body: { root: 'ELSEWHERE' } },
    { label: 'PUT /__vs/dir with a root', method: 'PUT', path: '/__vs/dir', body: { root: 'ELSEWHERE' } },
    { label: 'POST /__vs/dir/set', method: 'POST', path: '/__vs/dir/set', body: { root: 'ELSEWHERE' } },
    { label: 'POST /__vs/dir/open', method: 'POST', path: '/__vs/dir/open', body: { path: 'ELSEWHERE' } },
    { label: 'POST /__vs/dir/root', method: 'POST', path: '/__vs/dir/root', body: { dir: 'ELSEWHERE' } },
    { label: 'POST /__vs/dir/pick with a path in the body', method: 'POST', path: '/__vs/dir/picked', body: { path: 'ELSEWHERE' } },
    { label: 'GET /__vs/dir with a root in the query', method: 'GET', path: '/__vs/dir?root=ELSEWHERE' },
    { label: 'GET /__vs/dir with a contentDir in the query', method: 'GET', path: '/__vs/dir?contentDir=ELSEWHERE' },
  ];

  it('reports the directory it was started with, and keeps reporting it', async () => {
    const before = await raw('GET', '/__vs/dir');
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body)).toMatchObject({ root: served });

    for (const probe of PROBES) {
      const body = probe.body === undefined ? undefined : JSON.stringify(probe.body).replace(/ELSEWHERE/g, elsewhere);
      const res = await raw(probe.method, probe.path.replace('ELSEWHERE', encodeURIComponent(elsewhere)), body);

      /*
       * The two acceptable answers, and no third. A refusal (404 — no such route) is the
       * expected one for every path that does not exist; `GET /__vs/dir` itself answers 200
       * and is required to have IGNORED the query rather than honoured it, which the root
       * check below is what proves.
       */
      if (probe.method === 'GET' && probe.path.startsWith('/__vs/dir?')) {
        expect(res.status, probe.label).toBe(200);
        expect(JSON.parse(res.body), probe.label).toMatchObject({ root: served });
      } else {
        expect(res.status, probe.label).toBe(404);
      }

      // Asserted after every single probe rather than once at the end: "which request
      // moved it" is the only useful thing a failure here can say.
      const now = await raw('GET', '/__vs/dir');
      expect(JSON.parse(now.body), `after ${probe.label}`).toMatchObject({ root: served });
    }
  }, 30_000);

  it('still serves the directory the user chose, not the one the caller named', async () => {
    // The end-to-end form of the same claim: a re-rooted server would list `SECRET.md`.
    const tree = await raw('GET', '/__vs/tree');
    expect(tree.status).toBe(200);
    const paths = (JSON.parse(tree.body) as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('a.md');
    expect(paths).not.toContain('SECRET.md');
  }, 30_000);
});
