<!-- uncle-dev -->
<!-- uncle-dev:generated -->
## uncle-dev

This project uses uncle-dev engineering skills for structured AI-assisted development.

### SDD mode: lid-ears (LID+EARS)
This project uses the **LID+EARS documentation chain** for spec-driven development.
- Run `/uncle-dev-spec` before any non-trivial feature — it will elicit requirements and produce three docs
- Documents live in `docs/hld/`, `docs/lld/`, `docs/ears/`
- **Do NOT use OpenSpec change scaffolding in this project**
- Arrow of intent: HLD → LLD → EARS → code/tests
- To change a behaviour: update `docs/ears/` first, then let changes flow downstream

### Skills by Phase
**Define:** uncle-dev-research, uncle-dev-idea-refine, uncle-dev-grill, uncle-dev-ubiquitous-language, uncle-dev-spec-driven-development, uncle-dev-design-architecture-docs, uncle-dev-acknowledge
**Plan:** uncle-dev-planning-and-task-breakdown
**Build:** uncle-dev-incremental-implementation, uncle-dev-test-driven-development, uncle-dev-spec-annotations, uncle-dev-context-engineering, uncle-dev-frontend-ui-engineering, uncle-dev-api-and-interface-design
**Verify:** uncle-dev-browser-testing-with-devtools, uncle-dev-debug-error
**Review:** uncle-dev-code-review-and-quality, uncle-dev-security-and-hardening, uncle-dev-performance-optimization
**Ship:** uncle-dev-git-workflow-and-versioning, uncle-dev-shipping-and-launch, uncle-dev-documentation-and-adrs
**Capture:** uncle-dev-knowledge-capture
**Maintain:** uncle-dev-knowledge-maintenance

### Skill loading

When a command prints `SKILL: <ref>` lines, read each `<ref>` as the active skill — if `<ref>` is `uncle-dev:<name>`, use the bundled plugin skill; if it is a file path, read that file instead. When a command also prints `COMPANION: <path>` lines, read each companion file **after** the active skill and merge its `## Companion Additions` into your working context.

### Conventions
- Personal scratchpad in `.devlocal/<user>/` (gitignored, not shared)
- Team learnings captured in `.uncle-dev/learns/`
<!-- /uncle-dev:generated -->
<!-- /uncle-dev -->
