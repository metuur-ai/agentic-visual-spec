/**
 * git-checkout-ignore.test.ts — what the write route answers when the branch changed
 * and the ignore entry (R-5.8) could not be written.
 *
 * This is asserted end to end, through a real host and a real repository, because the
 * failure it guards is a property of the whole chain rather than of any one module:
 * `ensureIgnored` writes `.gitignore` through `node:fs`, Node puts the ABSOLUTE path
 * into the error it throws, `handleGitRequest` deliberately catches nothing (every
 * failure below it is a value), and each host's last-resort handler answers 500 with
 * `err.message`. An uncaught throw here is therefore an absolute filesystem path on
 * the wire from the one route in this package that writes — R-5.10 and R-1.11 broken
 * together. Only a request over a socket can show that, so the request goes over a
 * socket.
 *
 * The failure is produced rather than simulated: `.gitignore` is committed on both
 * branches with identical contents (so `checkout` never needs to rewrite it) and then
 * made read-only. `checkout` succeeds, the ignore write does not.
 *
 * 200, NOT 500, is the answer under test. The branch really did change, and R-6.7 has
 * the client adopt the returned context and nothing else — so a 5xx would leave the
 * chip naming a branch the repository has already left, which is the exact class of
 * lie Unit 3's states exist to prevent. The warning travels beside the context.
 */
import { type Server, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { access, chmod, constants, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type ViteDevServer, createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createVisualSpecServer } from '../../src/server';
import { visualSpecMarkdown } from './md-plugin';
import { IGNORE_ENTRY } from '../collaboration/worktree';

vi.setConfig({ testTimeout: 30_000 });

const run = promisify(execFile);

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

let repo: string;
/** Both preconditions are environmental: no git, or a process that ignores mode bits. */
let hasGit = true;
let readOnlyHolds = true;
let standalone: Server;
let standalonePort: number;
let vite: ViteDevServer;
let vitePort: number;

const gitignore = () => join(repo, '.gitignore');

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vs-ignore-fail-'));
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
    await run('git', ['config', 'user.name', 'Visual Spec Test'], { cwd: repo });
    await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: repo });
    await writeFile(join(repo, 'a.md'), '# a\n');
    // No collaboration entry, so `ensureIgnored` has something to write. Identical on
    // both branches, so `checkout` leaves the read-only file alone and the only write
    // attempted is the one under test.
    await writeFile(gitignore(), 'node_modules/\n');
    await run('git', ['add', '-A'], { cwd: repo });
    await run('git', ['commit', '-qm', 'first'], { cwd: repo });
    await run('git', ['branch', 'topic'], { cwd: repo });
    await run('git', ['branch', 'topic2'], { cwd: repo });
  } catch {
    hasGit = false;
  }

  if (hasGit) {
    await chmod(gitignore(), 0o444);
    try {
      // A process running as root writes through the mode bits, and the failure this
      // file exists to provoke would not happen. Reported rather than silently green.
      await access(gitignore(), constants.W_OK);
      readOnlyHolds = false;
    } catch {
      readOnlyHolds = true;
    }
  }

  const config = { git: { allowCheckout: true } };
  standalone = createVisualSpecServer({ contentDir: repo, uiDir: join(repo, '__ui'), port: 0, config }).server;
  await new Promise<void>((ok) => standalone.listen(0, '127.0.0.1', ok));
  standalonePort = (standalone.address() as AddressInfo).port;

  vite = await createViteServer({
    configFile: false,
    root: repo,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: visualSpecMarkdown({ contentDir: repo, config }),
  });
  await vite.listen();
  vitePort = (vite.httpServer?.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((ok) => standalone.close(() => ok()));
  await vite?.close();
  if (hasGit) await chmod(gitignore(), 0o644).catch(() => {});
  await rm(repo, { recursive: true, force: true });
});

/** Anything that would betray where on this machine the served directory lives. */
const ABSOLUTE_PATH = /(?:^|[^\w])\/(?:Users|home|var|private|tmp|srv|Volumes|opt)\//;

describe('a branch change whose ignore entry could not be written (R-5.8, R-5.10, R-1.11)', () => {
  // One branch per host, so neither meets a repository the other already moved.
  for (const [name, target] of [
    ['standalone server', 'topic'],
    ['Vite plugin host', 'topic2'],
  ] as const) {
    it(`${name}: answers 200 with the new context and a warning, and leaks no path`, async () => {
      if (!hasGit || !readOnlyHolds) return;
      const port = name === 'standalone server' ? standalonePort : vitePort;

      // (a) the request is answered at all — an uncaught throw would have become the
      // host's last-resort 500.
      const r = await raw(port, 'POST', '/__vs/git/checkout', JSON.stringify({ branch: target }));

      // (b) the branch really did change on disk. Everything else in this test is
      // about how that fact is reported, so it has to be a fact first.
      const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
      expect(stdout.trim()).toBe(target);

      // (c) reported as changed, carrying the context read after the change (R-5.9),
      // with the one thing that did not happen named beside it.
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({
        warning: 'ignore-failed',
        context: {
          state: 'remote',
          branch: target,
          detached: false,
          host: 'github.com',
          owner: 'acme',
          repo: 'widgets',
          url: 'git@github.com:acme/widgets.git',
        },
      });

      // (d) the point of the whole arm. Node's message for the refused write is
      // "EACCES: permission denied, open '/…/.gitignore'", and none of it — not the
      // path, not the errno, not git's or the filesystem's wording — is on the wire.
      expect(r.body).not.toContain(repo);
      expect(r.body).not.toContain(tmpdir());
      expect(r.body).not.toMatch(ABSOLUTE_PATH);
      expect(r.body).not.toMatch(/EACCES|EROFS|EPERM|permission denied/i);

      // And the entry genuinely is still missing — the warning is not decorative.
      expect(await readFile(gitignore(), 'utf8')).not.toContain(IGNORE_ENTRY);
    });
  }

  it('the preconditions this file depends on actually held', () => {
    // Stated rather than assumed: a silent `return` above would otherwise let the
    // whole suite pass on a machine where nothing was ever tested.
    expect(hasGit).toBe(true);
    expect(readOnlyHolds).toBe(true);
  });
});
