/**
 * import-boundary.test.ts — R-2.13.
 *
 * "WHERE a collaboration document is open, THE SYSTEM SHALL NOT import
 * `markdownToInjectable()` or `canonicalizeMarkdown()`, and a test SHALL assert this."
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. `markdownToInjectable` does not throw on an
 * id-less tree. It returns a structurally valid Lexical document with every `nodeId`
 * gone — the comment anchors of the whole document silently detach and nothing, at any
 * layer, notices. Markdown is derived, not canonical (LLD §2); the only thing keeping
 * the derived artifact from flowing back in is that nobody writes the import.
 *
 * WHAT "THE COLLABORATION PATH" MEANS HERE — enumerated by `COLLABORATION_PATH`, not by
 * a file list, so a module added by a concurrent task is covered the moment it lands:
 *
 *   1. `core/collaboration/**`            — the whole layer, by definition.
 *   2. `core/vite/routes/collab*.ts`      — the route family that serves it (R-7.1).
 *   3. `ui/{node-id,publish,collab}*.tsx?` — the browser-side modules that own document
 *      identity and the publish payload. The `ui/` boundary is drawn by name prefix
 *      rather than by directory because the collaboration UI shares `ui/` with the
 *      local viewer, and the local viewer legitimately parses Markdown
 *      (`ui/wysiwyg-editor.tsx` imports `markdownToInjectable` and must keep doing so —
 *      it is the local editor's load path, explicitly out of scope for this feature).
 *
 * The check follows the **import graph**, not direct imports: a collaboration module
 * that imports a helper that imports `markdownToInjectable` has the same defect, and the
 * chain is what the failure message names. The walker is task 0.3's, shared via
 * `core/import-graph.ts`.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { walkImportGraph } from '../import-graph';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Package-relative patterns defining the collaboration path. Order is cosmetic. */
const COLLABORATION_PATH: RegExp[] = [
  /^core\/collaboration\/[^/]+\.tsx?$/,
  /^core\/vite\/routes\/collab[^/]*\.tsx?$/,
  /^ui\/(node-id|publish|collab)[^/]*\.tsx?$/,
];

/**
 * Bindings that turn Markdown back into a document. Named, not module-scoped: the rest
 * of `ui/luthor-bridge.ts` (`mapImages`, `normalizeForStore`) is pure string work and is
 * fine to reach.
 */
const FORBIDDEN_BINDINGS: [name: string, why: string][] = [
  ['markdownToInjectable', 'reparses Markdown into an injectable tree, dropping every nodeId'],
  ['canonicalizeMarkdown', 'round-trips a document through Markdown, dropping every nodeId'],
  ['markdownToJSON', "Luthor's raw Markdown parser — the primitive both of the above wrap"],
];

const SOURCE_EXT = new Set(['.ts', '.tsx']);

/** Every non-test source file under `dir`, package-relative. */
function sourcesUnder(dir: string): string[] {
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
      if (/\.test\.tsx?$/.test(entry)) continue; // tests are not the collaboration path
      out.push(relative(pkgRoot, full));
    }
  };
  walk(resolve(pkgRoot, dir));
  return out;
}

/** The collaboration path, resolved against what is actually on disk right now. */
function collaborationEntries(): string[] {
  return ['core', 'ui', 'src']
    .flatMap(sourcesUnder)
    .filter((file) => COLLABORATION_PATH.some((pattern) => pattern.test(file)))
    .sort();
}

/** Every way `name` is reached in `source`: as an imported binding or as a call. */
function usesOf(source: string, name: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)\sfrom\s*['"]([^'"]+)['"]/g)) {
    if (new RegExp(`\\b${name}\\b`).test(match[1])) hits.push(`imports \`${name}\` from '${match[2]}'`);
  }
  // Catches the namespace-import escape hatch (`import * as bridge` → `bridge.foo()`).
  if (new RegExp(`\\.\\s*${name}\\s*\\(`).test(source)) hits.push(`calls \`.${name}()\``);
  return hits;
}

/** `entry → … → module: reason` for every reachable use of `name`. */
function reachesBinding(entry: string, name: string): string[] {
  const violations: string[] = [];
  walkImportGraph(pkgRoot, entry, ({ source, chain }) => {
    for (const use of usesOf(source, name)) violations.push(`${chain.join(' → ')}: ${use}`);
  });
  return violations;
}

describe('R-2.13 — the collaboration path never reads Markdown back', () => {
  const entries = collaborationEntries();

  it('enumerates the collaboration path from disk (guards against a vacuous pass)', () => {
    // Anchors that exist today. If one of these stops matching, the patterns above have
    // drifted from the layout and the whole suite would otherwise pass on nothing.
    expect(entries).toContain('core/collaboration/document-protocol.ts');
    expect(entries).toContain('core/collaboration/document-store.ts');
    expect(entries).toContain('core/vite/routes/collab.ts');
    expect(entries).toContain('ui/node-id-extension.ts');
    expect(entries.length).toBeGreaterThan(8);
  });

  for (const [name, why] of FORBIDDEN_BINDINGS) {
    it(`no collaboration module reaches \`${name}\` — ${why}`, () => {
      const violations = entries.flatMap((entry) => reachesBinding(entry, name));
      // Joined rather than compared as an array so the failure diff prints the offending
      // chains in full instead of vitest's `[ …(6) ]` elision.
      expect(violations.join('\n')).toBe('');
    });
  }

  // Proves the detector traverses and matches rather than passing vacuously: the local
  // editor genuinely imports `markdownToInjectable`, and is deliberately NOT on the
  // collaboration path.
  it('detects the binding when one genuinely exists (ui/wysiwyg-editor.tsx)', () => {
    expect(entries).not.toContain('ui/wysiwyg-editor.tsx');
    expect(reachesBinding('ui/wysiwyg-editor.tsx', 'markdownToInjectable').join('\n')).toContain(
      "imports `markdownToInjectable` from './luthor-bridge'",
    );
  });

  // …and that it follows the graph rather than only direct imports: `luthor-bridge` is
  // two hops from the editor's entry, reached through a relative import chain.
  it('detects a transitive reach, not just a direct import', () => {
    const chains = reachesBinding('ui/App.tsx', 'markdownToInjectable');
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((chain) => chain.split(' → ').length > 1)).toBe(true);
  });
});
