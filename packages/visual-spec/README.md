# visual-spec

Browse any directory in the browser, comment on files, line ranges, and folders — then let an agent apply the comments.

`visual-spec` has two modes:

1. **Directory browser** — point it at any folder, read it in the browser, and leave comments anchored to files, line ranges, or folders. An agent session picks the comments up and applies them.
2. **Surface projects** — author React/TSX "surfaces", inspect them live in the browser (press `I`, click an element), and attach specs or notes as in-source markers (`@vs-spec`, `@vs-note`) that an agent resolves.

## Install

```bash
# one-off, no install
npx @metuur/visual-spec <dir>

# or add to a project
npm install @metuur/visual-spec
```

Requires Node 18+.

## Quick start — browse & comment

```bash
npx @metuur/visual-spec .              # open the current directory
npx @metuur/visual-spec ./docs --port 5180
```

This serves a prebuilt UI rooted at the directory you pass. Comments are written to a sidecar file next to the content; the open URL and comment path are printed on start. The browser opens automatically (use `--no-open` to skip).

### CLI

```
visual-spec <dir> [--port 5180] [--no-open]   open the browser on a directory (default command)
visual-spec init <dir> [--name <pkg>]         scaffold a new surface project
visual-spec install-skills [--dest <dir>]     install the agent skills (default ~/.claude/skills)
visual-spec help
```

**Filtering.** A `.visualspecignore` at the directory root is honored (gitignore syntax). `.git/`, `node_modules/`, and the comments sidecar are always hidden; common build/dep/cache/secret cruft (`dist/`, `target/`, `*.log`, `.env`, …) is hidden by default. Negate any default with a `!` rule (e.g. `!dist/`).

## Quick start — surface project

```bash
npx @metuur/visual-spec init my-surfaces
cd my-surfaces
npm install
npm run dev          # opens the editor at http://localhost:5180
```

Press `I` in the browser, click any element, and attach an EARS / OpenSpec / SpecKit spec or a freeform note. The marker is written directly into the surface's source file — the source is the canonical model.

A scaffolded project looks like:

```
my-surfaces/
  surfaces/
    example/index.tsx     # a surface: exported meta + array of page components
  src/
    App.tsx               # mounts the inspector + surface host
    main.tsx
  vite.config.ts          # wires in the visual-spec vite plugin
  visual-spec.config.ts   # surfacesDir + spec mode
  AGENTS.md               # guide for the agent that applies markers
```

### Vite plugin

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import { visualSpec } from '@metuur/visual-spec/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // loc-tags runs enforce:'pre', so surfaces are tagged before plugin-react.
  plugins: [react(), ...visualSpec()],
  server: { port: 5180 },
});
```

The plugin tags surface elements with source locations (`data-vs-loc`, compiler-injected — never hand-author it), serves the markdown/comment bridges, and tracks the live browser selection.

### Config

```ts
// visual-spec.config.ts
import { defineConfig } from '@metuur/visual-spec/config';

export default defineConfig({
  surfacesDir: 'surfaces',
});
```

| Option | Default | Description |
| --- | --- | --- |
| `surfacesDir` | `'surfaces'` | Where surface modules live. |

### App components

Build the editor shell from the `@metuur/visual-spec/app` exports:

```tsx
import {
  InspectorProvider,
  InspectOverlay,
  SelectionReporter,
  SurfaceHost,
  useSurfaceModule,
} from '@metuur/visual-spec/app';
```

See `src/App.tsx` in a scaffolded project for a complete, working shell.

## How an agent applies the work

Markers in `surfaces/<id>/index.tsx` route to skills:

| Marker | What it is |
| --- | --- |
| `{/* @vs-spec … */}` | A formal SDD spec (EARS / OpenSpec / SpecKit): synthesize → validate → implement → archive. |
| `{/* @vs-note … */}` | A freeform quick edit: marker → small edit → delete. |
| "this element" (no marker) | Resolved via the live browser selection. |

The skills live in a separate repository. If a build bundled them, install with `visual-spec install-skills` (otherwise that command is a no-op). The scaffold always ships an `AGENTS.md` describing the routing and the bridge files (`node_modules/.visual-spec/specs.json`, `current.json`) the agent should read instead of hand-scanning.

## Package exports

| Entry | Purpose |
| --- | --- |
| `@metuur/visual-spec` | Core: config + editing primitives. |
| `@metuur/visual-spec/config` | `defineConfig`, config types. |
| `@metuur/visual-spec/editing` | Comment/marker document model. |
| `@metuur/visual-spec/app` | React components for the editor UI. |
| `@metuur/visual-spec/vite` | The Vite plugin. |

## License

See the repository root.
