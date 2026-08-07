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
import react from "@vitejs/plugin-react";
import { visualSpec } from "@metuur/visual-spec/vite";
import { defineConfig } from "vite";

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
import { defineConfig } from "@metuur/visual-spec/config";

export default defineConfig({
  surfacesDir: "surfaces",
});
```

| Option        | Default      | Description                 |
| ------------- | ------------ | --------------------------- |
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
} from "@metuur/visual-spec/app";
```

See `src/App.tsx` in a scaffolded project for a complete, working shell.

## How an agent applies the work

Markers in `surfaces/<id>/index.tsx` route to skills:

| Marker                     | What it is                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `{/* @vs-spec … */}`       | A formal SDD spec (EARS / OpenSpec / SpecKit): synthesize → validate → implement → archive. |
| `{/* @vs-note … */}`       | A freeform quick edit: marker → small edit → delete.                                        |
| "this element" (no marker) | Resolved via the live browser selection.                                                    |

The skills live in a separate repository. If a build bundled them, install with `visual-spec install-skills` (otherwise that command is a no-op). The scaffold always ships an `AGENTS.md` describing the routing and the bridge files (`node_modules/.visual-spec/specs.json`, `current.json`) the agent should read instead of hand-scanning.

## Package exports

| Entry                         | Purpose                             |
| ----------------------------- | ----------------------------------- |
| `@metuur/visual-spec`         | Core: config + editing primitives.  |
| `@metuur/visual-spec/config`  | `defineConfig`, config types.       |
| `@metuur/visual-spec/editing` | Comment/marker document model.      |
| `@metuur/visual-spec/app`     | React components for the editor UI. |
| `@metuur/visual-spec/vite`    | The Vite plugin.                    |

## License

See the repository root.

- Whether collaboration mode should live in the standalone CLI only or also in the Vite plugin workflow.
  - only in the UI.
- Whether GitHub operations should use a PAT, OAuth user token, or GitHub App installation token.
  - yes Use PAT to use github MCP and gh cli so the Claude cli can be used in the standalone CLI and Vite plugin workflows.
- Whether thread resolution must be GraphQL-only in the implementation or wrapped behind a mixed REST/GraphQL adapter.
- CI want to use github MCP and gh cli
- Whether final Markdown should be committed before merge, generated after merge, or both.
  - both, so the agent can use the final Markdown to generate a PR summary and/or a changelog.
- Whether local `visual-spec-comments.json` should remain as cache for GitHub comments or disappear entirely in collaboration mode.
- just as cache, so the agent can use it to generate a PR summary and/or a changelog. and delete it after merge.

---

---

1. Is the reviewable PR artifact the Markdown or the JSON? This is the fork. JSON-as-canonical fixes identity permanently but makes the PR diff less human-readable. It changes Units 2, 3, and 8 wholesale.

- I'm thinking JSON-as-canonical is the right choice. The PR diff is still human-readable, and the Markdown can be generated on demand for review from the visual spec UI. It also makes it easier to support multiple output formats in the future.

2. What happens when someone comments on unchanged prose? Conversation-tab comment, subject_type: "file", or refuse. uncle-po argues conversation-tab should be the default channel, not the fallback.

- agreed, conversation-tab should be the default channel for unchanged prose comments , maybe we need a over all comments section for the PR in the visual spec UI? . The infile comment allows a better detailed comments context and visibility of discussions without cluttering the general comment threads.

3. Will reviewers actually install visual-spec, or is github.com the only realistic reviewer surface? If the latter, the UI→GitHub comment direction is the low-value half and the scope shrinks a lot.

- reviewers must actually install and use visual-spec. the PR files will be a json document, and the reviewers will need to use visual-spec to view and comment on the document using a markdown-like interface. The github.com interface will be used for general discussion and high-level comments, but the detailed review and commenting will be done in visual-spec.

---

1. Conversation-tab comments have no native resolve. R-4.6, R-5.6, and PATCH /\_\_vs/collab/:id/threads/:threadId (R-7.1) lose their GitHub mechanism entirely. Resolution state must live somewhere you control. The right answer is a structured marker in the comment body or a reply convention — not the JSON doc on the branch, because that would require reviewers to push, which breaks single-writer. Worth being deliberate here.

- agreed, we need a structured marker in the comment body or a reply convention to track resolution state. This will allow reviewers to resolve threads without needing to push changes to the branch, maintaining the single-writer model.

2. R-9.7 is now backwards. It gates operations to the PAT owner matching the PR author. Under decision 3, reviewers must be able to comment. You need a two-role model: author (branch write, publish, merge) vs reviewer (comment only, no push). The upside is that reviewers need only read + PR-comment permission, so single-writer is enforced by GitHub permissions rather than convention — which fixes uncle-lead's A5 concern for free.

- agreed, we need a two-role model: author (branch write, publish, merge) vs reviewer (comment only, no push). This will allow reviewers to comment without needing to push changes to the branch, maintaining the single-writer model and enforcing it through GitHub permissions.

3. uncle-po's SC-4 cut is now wrong. Two machines / two credentials is no longer a path nobody uses — it's the mainline. It has to be tested, and reviewer onboarding ("open this PR in visual-spec") becomes a first-class product requirement that nothing in the spec currently covers.

- agreed, we need to test the two machines / two credentials scenario and make reviewer onboarding a first-class product requirement. This will ensure that reviewers can easily open the PR in visual-spec and participate in the review process without needing to push changes to the branch.
