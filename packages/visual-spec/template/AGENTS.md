# Agent guide

This project is a **visual-spec** workspace: React/TSX surfaces under `surfaces/`,
annotated in the browser with in-source markers, applied by an LLM session.

## Start here

When the user wants to spec, annotate, or apply changes to a surface, invoke the
**visual-spec** skill — it's the driver that figures out where they are and routes
to the right sub-skill below.

## Marker routing

| Marker in `surfaces/<id>/index.tsx` | Skill | What it is |
| --- | --- | --- |
| `{/* @vs-spec … */}` | **apply-specs** | A formal SDD spec (EARS / OpenSpec / SpecKit). Synthesize → validate → implement → archive. |
| `{/* @vs-note … */}` | **apply-notes** | A freeform quick edit. marker → small edit → delete. |
| "this element" (no marker) | **current-target** | Resolve via `node_modules/.visual-spec/current.json`. |
| writing/editing a surface | **surface-authoring** | The shared "how to edit a surface" reference. |

## Rules

- `surfaces/<id>/index.tsx` is the canonical model. Edit it through the anchored
  `line:column`; never hand-author element IDs (`data-vs-loc` is compiler-injected).
- Apply multiple edits **bottom-up by line** so positions stay valid.
- `@vs-spec` markers are routed to `apply-specs`, never edited ad hoc.
- After any edit: the surface must parse and `pnpm tsc --noEmit` must pass.

## Bridges (read these, don't hand-scan)

- `node_modules/.visual-spec/specs.json` — every spec marker, grouped by capability.
- `node_modules/.visual-spec/current.json` — the live browser selection.

## Commands

```
pnpm dev              # open the editor in the browser
pnpm apply-specs      # synthesize ready @vs-spec markers into a change (dry)
pnpm apply-specs --apply   # also remove applied markers
```
