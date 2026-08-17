/**
 * build.mjs — bundle the CLI + server into one self-contained dist/cli.js (core
 * is inlined), then copy the scaffold template (and the agent skills, if present)
 * next to it. Run AFTER `vite build` (which produces dist/ui).
 *
 * Skills are NOT part of this repo. If a `skills/` directory exists at the repo
 * root (e.g. you symlinked or vendored one in to bundle them), it gets copied to
 * dist/skills; otherwise the skill-dependent CLI commands degrade gracefully.
 */
import { build } from 'esbuild';
import { cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * R-3.3 / R-12.6 — the CLI bundle must stay free of the browser ecosystem.
 * Marking these `external` would only defer the failure to runtime, so resolution
 * is rejected outright: a stray import from core/ fails the build instead of
 * shipping a 3.8 MB binary that throws `Dynamic require of "react-dom/server.node.js"`.
 */
const forbidBrowserDeps = {
  name: 'forbid-browser-deps',
  setup(build) {
    build.onResolve({ filter: /^(react|react-dom|@lyfie\/luthor)($|\/)/ }, (args) => ({
      errors: [
        {
          text: `Node-reachable bundle must not import "${args.path}" (imported by ${args.importer}). Luthor and React are UI-only — see R-3.3.`,
        },
      ],
    }));
  },
};

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Pull core's TS source in directly; node built-ins stay external automatically.
  plugins: [forbidBrowserDeps],
  banner: { js: '#!/usr/bin/env node' },
});

// Ship the scaffold template inside the package (dist is published).
await cp('template', 'dist/template', { recursive: true });

// Bundle skills only if a sibling skills/ dir is present (it lives in a separate repo).
const skillsSrc = '../../skills';
if (existsSync(skillsSrc)) {
  await cp(skillsSrc, 'dist/skills', { recursive: true });
  console.log('✓ built dist/cli.js + dist/template + dist/skills');
} else {
  console.log('✓ built dist/cli.js + dist/template (no ../../skills — skipped skills bundle)');
}
