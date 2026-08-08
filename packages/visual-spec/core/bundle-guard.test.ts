/**
 * bundle-guard.test.ts — R-12.6 / R-3.3.
 *
 * Luthor is UI-only. `@lyfie/luthor` drags `react-dom/server` in with it, and
 * esbuild turns that into a 3.8 MB CLI artifact that throws
 * `Dynamic require of "react-dom/server.node.js"` the moment it is imported.
 * One stray import from core/ ships a broken binary, so the import graph of every
 * Node-reachable entrypoint is walked here and asserted clean.
 *
 * This is the STATIC layer (TypeScript sources, no build needed). The complementary
 * BUILD-OUTPUT layer is `npm run check:bundle`, which greps the emitted bundles.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkImportGraph } from './import-graph';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entrypoints whose code runs in (or is bundled for) Node. */
const NODE_REACHABLE_ENTRIES = ['src/cli.ts', 'core/vite/index.ts', 'core/index.ts'];

/** Bare specifiers that must never appear anywhere in those graphs. */
const FORBIDDEN = /^(react|react-dom|@lyfie\/luthor)($|\/)/;

/** Walk the static import graph, returning `entry → … → offender` chains. */
function forbiddenPaths(entry: string): string[] {
  const violations: string[] = [];
  walkImportGraph(pkgRoot, entry, ({ chain, specifiers }) => {
    for (const specifier of specifiers) {
      // other bare deps are somebody else's problem; relative ones the walker follows
      if (FORBIDDEN.test(specifier)) violations.push([...chain, specifier].join(' → '));
    }
  });
  return violations;
}

describe('Node-reachable import graph (R-12.6, R-3.3)', () => {
  for (const entry of NODE_REACHABLE_ENTRIES) {
    it(`${entry} reaches no react / react-dom / @lyfie/luthor`, () => {
      expect(forbiddenPaths(entry)).toEqual([]);
    });
  }

  // Proves the walker actually traverses rather than vacuously passing: the UI
  // graph, which legitimately owns Luthor and React, must trip the same check.
  it('detects a forbidden import when one genuinely exists (ui/luthor-bridge.ts)', () => {
    expect(forbiddenPaths('ui/luthor-bridge.ts').join('\n')).toContain('@lyfie/luthor');
  });
});

/*
 * The prompt that hands review comments to an agent names the document by its own
 * `documentPath`, and the agent is spawned with the apply hub's `cwd`. `documentPath` is
 * only resolvable from there because `fsCollaborationStore` writes the Markdown at
 * `<baseDir>/<documentPath>` — so the two directories have to be the same one. They are
 * two different expressions in two different hosts, and they only agree because each host
 * derives both from one variable. Let them drift and the agent opens a file that is not
 * there — or worse, one that is.
 *
 * The store this reads used to be `fsDocumentStore`, which held the document as JSON at a
 * path of its own choosing; the invariant did not change with the format, only the name
 * of the thing that establishes the root.
 */
describe('the agent runs where the documents are', () => {
  const HOSTS = ['src/server.ts', 'core/vite/md-plugin.ts'];

  it.each(HOSTS)('%s spawns apply in the same directory it stores documents in', (host) => {
    const source = readFileSync(resolve(pkgRoot, host), 'utf8');
    const cwd = /createApplyHub\(\(\) => \(\{ cwd: (\w+)/.exec(source)?.[1];
    const base = /fsCollaborationStore\((\w+)\)/.exec(source)?.[1];
    expect(cwd).toBeDefined();
    expect(base).toBeDefined();
    expect(cwd).toBe(base);
  });
});

/*
 * R-4.1 / R-2.3 (git) — the static half of host parity, extending the HOSTS block
 * above rather than inventing a second convention for the same class of claim.
 *
 * This is the cheap guard: it reads both hosts' source and asserts each one *reaches*
 * the shared handler and carries no create/rename/git implementation of its own. It
 * cannot prove the two behave identically — `host-parity.test.ts` runs both servers
 * against one directory for that — but it fails the instant someone answers a wiring
 * bug by pasting a local copy into one host, which is the failure the live test would
 * report only as a confusing diff.
 *
 * Comments are stripped first: a claim about code must not be satisfied by prose that
 * merely mentions the symbol.
 */
describe('both hosts reach one shared module for the write and git routes', () => {
  const HOSTS = ['src/server.ts', 'core/vite/md-plugin.ts'];
  const code = (host: string) =>
    readFileSync(resolve(pkgRoot, host), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

  it.each(HOSTS)('%s imports handleFilesRequest from routes/files and dispatches to it', (host) => {
    const text = code(host);
    expect(text).toMatch(/import \{[^}]*handleFilesRequest[^}]*\} from '[^']*routes\/files'/);
    expect(text).toContain('handleFilesRequest(tree, comments,');
  });

  it.each(HOSTS)('%s imports handleGitRequest from routes/git and dispatches to it', (host) => {
    const text = code(host);
    expect(text).toMatch(/import \{[^}]*handleGitRequest[^}]*\} from '[^']*routes\/git'/);
    // The getter form, not a captured string: `setRoot` reassigns the root at
    // runtime and a value captured at wiring time would freeze R-2.2.
    expect(text).toMatch(/handleGitRequest\(\(\) => \w+,/);
  });

  it.each(HOSTS)('%s declares no create/rename/git implementation of its own', (host) => {
    const text = code(host);
    // The write half: no host may reach the filesystem write primitives these
    // routes are built from, nor re-derive the seed or the .md rule.
    for (const forbidden of ['writeFile(', 'mkdir(', 'link(', 'unlink(', 'readGitContext(']) {
      expect(`${host}:${forbidden}${text.includes(forbidden)}`).toBe(`${host}:${forbidden}false`);
    }
    // And no second answer to "which subpaths are writes" beyond the one branch.
    expect(text.split("'/create'").length - 1).toBe(1);
    expect(text.split("'/rename'").length - 1).toBe(1);
  });
});
