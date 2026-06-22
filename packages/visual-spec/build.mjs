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

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Pull core's TS source in directly; node built-ins stay external automatically.
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
