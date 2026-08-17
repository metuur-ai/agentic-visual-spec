/**
 * collab.no-browser-github.test.ts — R-7.7.
 *
 * "THE SYSTEM SHALL NOT issue GitHub API calls from the browser." The PAT lives
 * server-side (R-9.1 / R-9.2), so a single `fetch('https://api.github.com/…')` in the
 * client bundle is either a call that cannot authenticate or, worse, a reason for
 * somebody to ship the credential to the browser so that it can.
 *
 * This is a SOURCE-LEVEL assertion over every module that ends up in the browser
 * bundle, matching the convention of `core/bundle-guard.test.ts` (which walks the
 * Node-reachable graph for `react`) and of the R-10.5 block in
 * `core/editing/local-mode.regression.test.ts` (which greps the local path for
 * `github`). Bundling here would tell us nothing extra: the offending string would be
 * the same string.
 *
 * The complement is the positive assertion at the bottom — the GitHub access that does
 * exist lives behind `/__vs/collab/*` on the server, in `core/collaboration/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Everything that is compiled for and executed by the browser. */
const CLIENT_DIRS = ['ui', 'core/app'];

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function sourcesUnder(dir: string): string[] {
  const abs = resolve(pkgRoot, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXT.has(extname(entry))) continue;
      if (/\.test\.tsx?$/.test(entry)) continue; // tests are not bundled
      out.push(full);
    }
  };
  walk(abs);
  return out;
}

/**
 * Ways a browser module could reach GitHub. Deliberately broad — a false positive is a
 * conversation, a false negative is a leaked credential.
 */
const GITHUB_REACH: [RegExp, string][] = [
  [/\bapi\.github\.com\b/, 'the GitHub REST/GraphQL host'],
  [/\buploads\.github\.com\b/, 'the GitHub uploads host'],
  [/github\.com\/(repos|api|graphql|user)\b/, 'a GitHub API path'],
  [/\b@?octokit\b/i, 'the Octokit SDK'],
  [/\b(GH_TOKEN|GITHUB_TOKEN)\b/, 'a GitHub credential env var'],
  [/\bAuthorization['"`\s]*:\s*['"`]?\s*(token|Bearer)\s/i, 'a hand-built credential header'],
  [/\bspawn\(\s*['"`]gh['"`]/, 'a `gh` CLI invocation'],
  [/\bX-OAuth-Scopes\b/i, 'a GitHub credential-scope probe'],
];

/** Modules that legitimately own GitHub access, used to prove the patterns are live. */
const SERVER_SIDE_PROOFS = [
  'core/collaboration/github-executor.ts',
  'core/collaboration/credentials.ts',
];

describe('R-7.7 — the browser never issues a GitHub API call', () => {
  const clientSources = CLIENT_DIRS.flatMap(sourcesUnder);

  it('finds client sources to check (guards against a vacuous pass)', () => {
    expect(clientSources.length).toBeGreaterThan(10);
  });

  for (const [pattern, what] of GITHUB_REACH) {
    it(`no client module contains ${what}`, () => {
      const offenders = clientSources
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => relative(pkgRoot, file));
      expect(offenders).toEqual([]);
    });
  }

  for (const proof of SERVER_SIDE_PROOFS) {
    it(`the pattern set actually matches — ${proof} trips it`, () => {
      // Proves the greps are live rather than vacuously passing: the modules that
      // legitimately own GitHub access must match at least one of them.
      const text = readFileSync(resolve(pkgRoot, proof), 'utf8');
      expect(GITHUB_REACH.some(([pattern]) => pattern.test(text))).toBe(true);
    });
  }

  it('GitHub access lives behind the server routes, in core/collaboration', () => {
    const collab = readFileSync(resolve(pkgRoot, 'core/vite/routes/collab.ts'), 'utf8');
    expect(collab).toContain("from '../../collaboration/github-adapter'");
    expect(collab).toContain("from '../../collaboration/comment-projection'");
  });

  it('no client module fetches anything but a same-origin path', () => {
    const offenders: string[] = [];
    for (const file of clientSources) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bfetch\(\s*[`'"]([^`'"]*)/g)) {
        const url = match[1]!;
        if (url.startsWith('/') || url.startsWith('$')) continue;
        offenders.push(`${relative(pkgRoot, file)}: fetch('${url}…')`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
