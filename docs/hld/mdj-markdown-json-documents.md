# `.mdj` Markdown-JSON Documents — High-Level Design

> **RETIRED — never implemented. Do not build from this document.**
>
> Superseded by Markdown-native collaboration. See
> `docs/ears/github-pr-collaborative-documents.md`, Unit 0.

## Overview

The viewer today shows a collaboration document as what it literally is on disk: a
JSON envelope full of Lexical node bookkeeping, rendered through the line-numbered
code viewer. That is honest and useless — the JSON is an implementation detail of
how the document is stored, and the thing the user came to read is the Markdown it
represents.

This change introduces a dedicated file extension, **`.mdj`** (Markdown JSON), for
files whose JSON content is a document envelope. The viewer renders an `.mdj` file
as a document — headings, paragraphs, lists — never as raw JSON. Plain `.json`
files keep rendering as code, because most JSON in a repository is an API response
or a config file and rendering those as prose would be worse than the status quo.
Files created from the UI default to `.mdj`, so a new document gives a Markdown
authoring experience while storing the content in the JSON form the collaboration
machinery already depends on.

The document envelope itself does not change. `.mdj` is a naming and routing
convention over the existing `CollaborationDocument` shape defined in
`core/collaboration/document-protocol.ts`.

## Stakeholders & Impact

- **Document readers and reviewers** (primary): today, opening
  `documents/ui-e2e-001.json` in the file tree shows 400 lines of Lexical JSON.
  After this ships, the same document opens as rendered prose, and comments attach
  to the block they are looking at rather than to a JSON line number.
- **Document authors** (primary): today the only way to author a collaboration
  document is inside the pull-request review route, which starts a branch and a PR
  before a single word is written. After this ships, an author can create a
  standalone `.mdj` anywhere in the browsed tree and edit it in the WYSIWYG editor
  with no GitHub involvement.
- **The collaboration / publish flow** (secondary): the artifact of record on the
  branch is renamed from `documents/<id>.json` to `documents/<id>.mdj`. The
  published Markdown sibling (`documents/<id>.md`) is unchanged, and so is
  everything about how publish commits and verifies.
- **Agents applying comments** (secondary): an apply run against an `.mdj` document
  edits structured JSON keyed by `nodeId` rather than by line, so the instructions
  it receives must name the node, not a line range.
- **Everyone browsing ordinary repositories** (secondary, must-not-regress): a
  `package.json` or a fixture file must keep rendering as syntax-highlighted code.

## Goals

- An `.mdj` file anywhere in the browsed tree opens as a **rendered document**, with
  the same block-level identity attributes the review surface already stamps.
- A user can **comment on a block** of an `.mdj` document; the comment is pinned to
  that block's `nodeId`, not to a line of JSON.
- A user can **edit** an `.mdj` document in the WYSIWYG editor and save it back to
  disk, with every existing block keeping its `nodeId` across the round trip.
- A user can **create** a new document from the UI: a local `.mdj` file with no
  GitHub binding, or a PR-backed document through the existing collaboration panel.
  Both produce `.mdj`.
- Existing `documents/*.json` files that hold a document envelope still render as
  documents, without anyone having to rename them.
- Ordinary `.json` files still render as code.

## Non-Goals

- **No change to the document envelope.** `documentId`, `documentPath`, `title`,
  `frontmatter`, `nodes`, `doc` stay exactly as `document-protocol.ts` defines them,
  including the unknown-field passthrough.
- **No Markdown importer.** There is no "convert this `.md` to `.mdj`" path.
  Parsing Markdown back into the document JSON destroys every `nodeId`, which is
  forbidden on this path (R-2.13, `import-boundary.test.ts`) and would break every
  existing comment anchor.
- **No new renderer for local `.md` files.** Markdown files keep going through the
  react-markdown surface with `data-vs-loc` source positions. The document renderer
  reads JSON only.
- **No bulk migration.** Existing `documents/*.json` files are not renamed by this
  change; the content fallback is what keeps them working.
- **No merged edit+comment surface.** As on the review route, a document is either
  being read/commented or being edited, because the live editor does not stamp
  `data-vs-node-id` into the DOM. Closing that is separate work.
- **No GitHub features for local `.mdj`.** A standalone `.mdj` has no branch, no PR,
  no publish, and its comments live in the local sidecar, not in GitHub.

## Success Criteria

- Opening `documents/ui-e2e-001.json` — unrenamed, as it exists today — shows the
  rendered document instead of the JSON in the screenshot that prompted this work.
- Renaming that same file to `.mdj` produces an identical rendering, without a read
  of its contents being needed to classify it.
- Opening `package.json` still shows syntax-highlighted JSON with line numbers.
- A comment left on a paragraph of an `.mdj` document survives an edit to a
  *different* paragraph and still resolves to its block.
- Editing an `.mdj` document and saving it leaves every untouched block's `nodeId`
  byte-identical, and the file still parses as a valid document envelope.
- Creating a document from the local sidebar writes an `.mdj` file that opens
  immediately in the editor; creating one from the collaboration panel opens a PR
  whose document artifact is `documents/<id>.mdj`.
